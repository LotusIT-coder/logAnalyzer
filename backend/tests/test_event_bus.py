from __future__ import annotations

import asyncio

import pytest

from app.services.event_bus import InMemoryEventBus


@pytest.mark.asyncio
async def test_event_bus_processes_event_successfully():
    bus = InMemoryEventBus(workers=1, queue_size=128)
    seen: list[dict] = []

    async def handler(payload: dict):
        seen.append(payload)

    bus.subscribe("topic.ok", handler)
    await bus.start()
    try:
        assert await bus.publish("topic.ok", {"k": "v"}) is True
        await asyncio.wait_for(bus._queue.join(), timeout=1.0)
        assert seen == [{"k": "v"}]
        stats = bus.get_stats()
        assert stats["processed_total"] == 1
        assert stats["dead_letter_total"] == 0
    finally:
        await bus.stop(drain=True)


@pytest.mark.asyncio
async def test_event_bus_retries_then_succeeds():
    bus = InMemoryEventBus(workers=1, queue_size=128, max_retry_attempts=3, retry_backoff_seconds=0.01)
    attempts = 0

    async def flaky_handler(_payload: dict):
        nonlocal attempts
        attempts += 1
        if attempts < 2:
            raise RuntimeError("transient")

    bus.subscribe("topic.retry", flaky_handler)
    await bus.start()
    try:
        assert await bus.publish("topic.retry", {"n": 1}) is True
        await asyncio.wait_for(bus._queue.join(), timeout=2.0)
        stats = bus.get_stats()
        assert attempts == 2
        assert stats["retried_total"] >= 1
        assert stats["processed_total"] == 1
        assert stats["dead_letter_total"] == 0
    finally:
        await bus.stop(drain=True)


@pytest.mark.asyncio
async def test_event_bus_dead_letters_after_max_retries():
    bus = InMemoryEventBus(workers=1, queue_size=128, max_retry_attempts=1, retry_backoff_seconds=0.01)

    async def broken_handler(_payload: dict):
        raise RuntimeError("permanent")

    bus.subscribe("topic.dead", broken_handler)
    await bus.start()
    try:
        assert await bus.publish("topic.dead", {"x": 1}) is True
        await asyncio.wait_for(bus._queue.join(), timeout=2.0)
        stats = bus.get_stats()
        assert stats["failed_total"] >= 1
        assert stats["dead_letter_total"] == 1
        assert stats["processed_total"] == 0
        assert stats["dead_letter_size"] == 1
    finally:
        await bus.stop(drain=True)


@pytest.mark.asyncio
async def test_event_bus_reports_queue_full_drops_when_not_running():
    bus = InMemoryEventBus(workers=1, queue_size=100)

    published = 0
    for i in range(140):
        ok = await bus.publish("topic.full", {"i": i})
        if ok:
            published += 1

    stats = bus.get_stats()
    assert published == 100
    assert stats["dropped_queue_full_total"] == 40


@pytest.mark.asyncio
async def test_event_bus_stop_with_drain_waits_for_handler_completion():
    bus = InMemoryEventBus(workers=1, queue_size=128)
    completed = 0

    async def slow_handler(_payload: dict):
        nonlocal completed
        await asyncio.sleep(0.03)
        completed += 1

    bus.subscribe("topic.drain", slow_handler)
    await bus.start()
    assert await bus.publish("topic.drain", {"i": 1}) is True
    assert await bus.publish("topic.drain", {"i": 2}) is True

    await bus.stop(drain=True, drain_timeout_seconds=2.0)
    assert completed == 2
