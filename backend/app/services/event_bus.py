"""In-memory async event bus used as a stepping stone to external brokers.

The API is intentionally small and topic-based so publishers can later be moved
from local queueing to Kafka/Redpanda with minimal call-site churn.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import structlog

logger = structlog.get_logger(__name__)

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(slots=True)
class BusEvent:
    topic: str
    payload: dict[str, Any]
    enqueued_at: datetime
    attempts: int = 0


class InMemoryEventBus:
    def __init__(
        self,
        workers: int = 1,
        queue_size: int = 10_000,
        max_retry_attempts: int = 3,
        retry_backoff_seconds: float = 0.2,
        dead_letter_max: int = 1000,
    ) -> None:
        self.workers = max(1, int(workers))
        self.queue_size = max(100, int(queue_size))
        self.max_retry_attempts = max(0, int(max_retry_attempts))
        self.retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))
        self.dead_letter_max = max(10, int(dead_letter_max))
        self._queue: asyncio.Queue[BusEvent] = asyncio.Queue(maxsize=self.queue_size)
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)
        self._tasks: list[asyncio.Task] = []
        self._running = False
        self._dead_letters: deque[dict[str, Any]] = deque(maxlen=self.dead_letter_max)
        self._stats: dict[str, int] = {
            "published_total": 0,
            "processed_total": 0,
            "failed_total": 0,
            "retried_total": 0,
            "dead_letter_total": 0,
            "dropped_queue_full_total": 0,
            "handler_missing_total": 0,
        }

    @property
    def running(self) -> bool:
        return self._running

    def get_stats(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "workers": self.workers,
            "queue_size": self.queue_size,
            "queue_depth": self._queue.qsize(),
            "max_retry_attempts": self.max_retry_attempts,
            "retry_backoff_seconds": self.retry_backoff_seconds,
            "dead_letter_size": len(self._dead_letters),
            **self._stats,
        }

    def subscribe(self, topic: str, handler: EventHandler) -> None:
        if handler not in self._handlers[topic]:
            self._handlers[topic].append(handler)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._tasks = [
            asyncio.create_task(self._worker(i), name=f"event-bus-worker-{i}")
            for i in range(self.workers)
        ]
        logger.info(
            "event_bus_started",
            workers=self.workers,
            queue_size=self.queue_size,
            max_retry_attempts=self.max_retry_attempts,
            retry_backoff_seconds=self.retry_backoff_seconds,
            dead_letter_max=self.dead_letter_max,
        )

    async def stop(self, *, drain: bool = False, drain_timeout_seconds: float = 5.0) -> None:
        if not self._running:
            return
        self._running = False
        if drain:
            try:
                await asyncio.wait_for(self._queue.join(), timeout=max(0.1, drain_timeout_seconds))
            except asyncio.TimeoutError:
                logger.warning(
                    "event_bus_drain_timeout",
                    timeout_seconds=drain_timeout_seconds,
                    queue_depth=self._queue.qsize(),
                )
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks = []
        logger.info("event_bus_stopped", **self.get_stats())

    async def publish(self, topic: str, payload: dict[str, Any]) -> bool:
        self._stats["published_total"] += 1
        event = BusEvent(
            topic=topic,
            payload=dict(payload),
            enqueued_at=datetime.now(timezone.utc),
        )
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            self._stats["dropped_queue_full_total"] += 1
            logger.warning("event_bus_queue_full", topic=topic, queue_size=self.queue_size)
            return False

    async def _retry_event(self, event: BusEvent) -> bool:
        backoff = self.retry_backoff_seconds * (2 ** max(0, event.attempts - 1))
        if backoff > 0:
            await asyncio.sleep(backoff)
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            self._stats["dropped_queue_full_total"] += 1
            return False

    def _to_dead_letter(self, event: BusEvent, reason: str) -> None:
        self._stats["dead_letter_total"] += 1
        self._dead_letters.append(
            {
                "topic": event.topic,
                "payload": dict(event.payload),
                "attempts": event.attempts,
                "reason": reason,
                "enqueued_at": event.enqueued_at.isoformat(),
                "dead_lettered_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        logger.warning("event_bus_dead_lettered", topic=event.topic, attempts=event.attempts, reason=reason)

    async def _worker(self, idx: int) -> None:
        while True:
            event = await self._queue.get()
            try:
                handlers = list(self._handlers.get(event.topic, []))
                if not handlers:
                    self._stats["handler_missing_total"] += 1
                    logger.debug("event_bus_no_handlers", topic=event.topic)
                    continue
                handler_failed = False
                for handler in handlers:
                    try:
                        await handler(event.payload)
                    except Exception:
                        handler_failed = True
                        self._stats["failed_total"] += 1
                        logger.exception("event_bus_handler_failed", topic=event.topic, worker=idx)
                        break

                if not handler_failed:
                    self._stats["processed_total"] += 1
                    continue

                if event.attempts < self.max_retry_attempts and self._running:
                    retry_event = BusEvent(
                        topic=event.topic,
                        payload=dict(event.payload),
                        enqueued_at=event.enqueued_at,
                        attempts=event.attempts + 1,
                    )
                    self._stats["retried_total"] += 1
                    pushed = await self._retry_event(retry_event)
                    if pushed:
                        continue
                    self._to_dead_letter(retry_event, reason="queue_full_on_retry")
                    continue

                self._to_dead_letter(event, reason="max_retries_exceeded")
            finally:
                self._queue.task_done()
