"""AI endpoints – models, analyze/window, analyze/incident, chat, jobs/{id}."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import job_store, ollama_client
from app.ai.tools import (
    TOOL_REGISTRY,
    TOOL_SCHEMAS,
    ToolContext,
    collect_references,
)
from app.config import get_settings
from app.dependencies import get_db
from app.domain.models import AIAnalysis, Event, Incident, ModelProfile
from app.schemas.domain import (
    AIAnalyzeIncidentRequest,
    AIAnalyzeWindowRequest,
    AIChatRequest,
    AIChatAsyncRequest,
    AIChatResponse,
    AIJob,
    AIModelListResponse,
    AIModelResponse,
    AsyncJobAccepted,
)

router = APIRouter(prefix="/ai", tags=["AI"])

_DEFAULT_MODEL = "llama3"
_DEFAULT_SYSTEM = (
    "You are a Senior SOC (Security Operations Center) analyst working on a "
    "self-hosted log analyzer. You have direct, read-only access to the log "
    "database via tools.\n\n"
    "HARD RULES:\n"
    "1. NEVER invent log lines, timestamps, hostnames, services, IPs or error "
    "messages. Every concrete fact MUST come from a tool result you executed "
    "in the current conversation OR from the baseline snapshot you receive in "
    "the system context.\n"
    "2. If a tool returns 0 events, say so explicitly. Do not fall back to "
    "generic example logs.\n"
    "3. For ANY question about what is in the logs, what happened, anomalies, "
    "errors, incidents or status: first consult the baseline snapshot you "
    "already received; if you need more detail, call a tool (`search_logs`, "
    "`get_recent_logs`, `get_log_stats`, `get_top_errors`, `get_incidents`, "
    "`list_sources`).\n"
    "4. When the user asks 'auf welche Logs hast du dich bezogen?' or similar, "
    "quote the actual events from the baseline / your previous tool results, "
    "never generic examples.\n\n"
    "STYLE:\n"
    "- Reply in the user's language (German or English), concise and factual.\n"
    "- Quote concrete log lines with timestamp and severity when reporting "
    "findings.\n"
    "- Suggest next investigation steps or remediation when relevant."
)

_MAX_TOOL_ITERATIONS = 6

# Heuristic: which user messages should never be answered without consulting
# the log database. Used to detect when the model ignored its tools.
_LOG_INTENT_RE = __import__("re").compile(
    r"\b(log|logs|event|events|fehler|error|errors|warn|warning|critical|"
    r"incident|alert|auffall|auffällig|verdächtig|attack|angriff|status|alles\s*ok|"
    r"anomal|ausfall|crash|exception|trace|stacktrace|bezogen|gefunden|datenbank|"
    r"system|service|host|server)\b",
    __import__("re").IGNORECASE,
)


def _detect_user_language(message: str) -> str:
    """Best-effort language detection for strict reply-language enforcement."""
    text = (message or "").strip().lower()
    if not text:
        return "same"

    german_markers = (
        " der ", " die ", " das ", " und ", " ist ", " nicht ", " mit ", " fuer ",
        " über ", " ueber ", " bitte ", " warum ", " wieso ", " weshalb ", " dass ",
        " muss ", " soll ", " kann ", " logs", " fehler", " eintrag", " eintraege",
    )
    english_markers = (
        " the ", " and ", " is ", " are ", " not ", " with ", " please ", " why ",
        " how ", " can ", " should ", " must ", " logs", " error", " entries",
    )

    padded = f" {text} "
    de_hits = sum(1 for marker in german_markers if marker in padded)
    en_hits = sum(1 for marker in english_markers if marker in padded)

    if any(ch in text for ch in ("ä", "ö", "ü", "ß")):
        de_hits += 2

    if de_hits > en_hits and de_hits >= 1:
        return "de"
    if en_hits > de_hits and en_hits >= 1:
        return "en"
    return "same"


def _language_guardrail_message(message: str) -> str:
    lang = _detect_user_language(message)
    if lang == "de":
        return (
            "CRITICAL LANGUAGE RULE: The user's message is in German. "
            "You MUST respond in German only. Do NOT answer in Chinese, English, "
            "or any other language, except for short literal log quotes."
        )
    if lang == "en":
        return (
            "CRITICAL LANGUAGE RULE: The user's message is in English. "
            "You MUST respond in English only. Do NOT answer in Chinese, German, "
            "or any other language, except for short literal log quotes."
        )
    return (
        "CRITICAL LANGUAGE RULE: Respond in the same language as the user's last "
        "message. Do NOT switch languages unless the user explicitly asks for it."
    )


def _build_scope_message(
    source_ids: list[str],
    source_paths: list[str],
    since_hours: float | None,
    extra_context: dict | None,
) -> str | None:
    parts: list[str] = []
    scope_bits: list[str] = []
    if source_ids:
        scope_bits.append(f"source_ids={source_ids}")
    if source_paths:
        scope_bits.append(f"source_paths={source_paths}")
    if since_hours:
        scope_bits.append(f"hours_back={since_hours}")
    if scope_bits:
        parts.append(
            "User has selected the following default scope. Tools you call "
            "will already respect these defaults; only override them if the "
            "user explicitly asks for a different scope. "
            + ", ".join(scope_bits)
        )
    else:
        parts.append(
            "User has NOT selected a source filter. If you need a starting "
            "point, call `list_sources` first or `get_recent_logs` for an "
            "overview."
        )
    if extra_context:
        parts.append(
            "Additional structured context attached by the user:\n"
            + json.dumps(extra_context, ensure_ascii=False, indent=2, default=str)
        )
    return "\n\n".join(parts) if parts else None


def _coerce_tool_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


async def _build_baseline_snapshot(ctx: ToolContext) -> str:
    """Pre-compute real log data so the LLM cannot hallucinate.

    We always run a small, cheap set of queries and inject the result as a
    system message. This guarantees that every answer is grounded in real
    events from the user's selected scope, even if the model decides not to
    call any tool.
    """
    parts: list[str] = []
    try:
        stats = await TOOL_REGISTRY["get_log_stats"](ctx, {})
        parts.append("# Log statistics (current scope)")
        parts.append(json.dumps(stats, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"# Log statistics unavailable: {type(exc).__name__}: {exc}")

    try:
        top = await TOOL_REGISTRY["get_top_errors"](ctx, {"limit": 10})
        parts.append("\n# Top errors (current scope)")
        parts.append(json.dumps(top, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"# Top errors unavailable: {type(exc).__name__}: {exc}")

    try:
        severe = await TOOL_REGISTRY["get_recent_logs"](
            ctx,
            {"severity": "critical,error", "limit": 12},
        )
        parts.append("\n# Recent critical/error events (current scope)")
        parts.append(json.dumps(severe, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"# Recent critical/error events unavailable: {type(exc).__name__}: {exc}")

    try:
        warnings = await TOOL_REGISTRY["get_recent_logs"](
            ctx,
            {"severity": "warning", "limit": 10},
        )
        parts.append("\n# Recent warning events (current scope)")
        parts.append(json.dumps(warnings, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"# Recent warning events unavailable: {type(exc).__name__}: {exc}")

    try:
        recent = await TOOL_REGISTRY["get_recent_logs"](ctx, {"limit": 8})
        parts.append("\n# Most recent events (all severities, current scope)")
        parts.append(json.dumps(recent, ensure_ascii=False, indent=2, default=str))
    except Exception as exc:  # noqa: BLE001
        parts.append(f"# Recent events unavailable: {type(exc).__name__}: {exc}")

    body = "\n".join(parts)
    return (
        "BASELINE LOG SNAPSHOT (auto-collected from the live database – use "
        "these as your primary source of truth, call tools only if you need "
        "more detail):\n\n" + body
    )


async def _run_tool_chat(
    session: AsyncSession,
    *,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
    message: str,
    source_ids: list[str],
    source_paths: list[str],
    since_hours: float | None,
    context: dict | None,
) -> tuple[str, list[str]]:
    """Run a multi-turn tool-calling chat and return (answer, references)."""
    ctx = ToolContext(
        session=session,
        default_source_ids=source_ids,
        default_source_paths=source_paths,
        default_hours=since_hours,
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    scope_msg = _build_scope_message(source_ids, source_paths, since_hours, context)
    if scope_msg:
        messages.append({"role": "system", "content": scope_msg})

    # Always pre-load real data so the model has ground truth even if it
    # decides to skip tool calls.
    baseline = await _build_baseline_snapshot(ctx)
    messages.append({"role": "system", "content": baseline})
    messages.append({"role": "system", "content": _language_guardrail_message(message)})

    messages.append({"role": "user", "content": message})

    answer = ""
    forced_retry_used = False
    for _ in range(_MAX_TOOL_ITERATIONS):
        assistant_msg = await ollama_client.chat_full(
            model, messages, temperature, max_tokens, tools=TOOL_SCHEMAS
        )
        tool_calls = assistant_msg.get("tool_calls") or []

        if not tool_calls:
            answer = (assistant_msg.get("content") or "").strip()
            # If the user asked something log-related but the model neither
            # called a tool nor referenced the baseline snapshot, push back
            # once and demand evidence-grounded answers.
            if (
                not forced_retry_used
                and _LOG_INTENT_RE.search(message)
                and not ctx.collected_events
            ):
                forced_retry_used = True
                messages.append({
                    "role": "assistant",
                    "content": answer or "",
                })
                messages.append({
                    "role": "user",
                    "content": (
                        "Stop. Du hast weder ein Tool aufgerufen noch dich "
                        "auf das BASELINE LOG SNAPSHOT bezogen. Antworte "
                        "erneut: zitiere ausschließlich konkrete Einträge aus "
                        "dem BASELINE LOG SNAPSHOT oder rufe ein passendes "
                        "Tool (search_logs / get_recent_logs / get_log_stats "
                        "/ get_top_errors) auf. Keine erfundenen Beispiele."
                    ),
                })
                continue
            break

        # Append the assistant message verbatim so the model sees its own call.
        messages.append({
            "role": "assistant",
            "content": assistant_msg.get("content", "") or "",
            "tool_calls": tool_calls,
        })

        for call in tool_calls:
            fn = (call.get("function") or {})
            name = fn.get("name") or ""
            args = _coerce_tool_args(fn.get("arguments"))
            handler = TOOL_REGISTRY.get(name)
            if handler is None:
                tool_result: dict[str, Any] = {"error": f"unknown tool: {name}"}
            else:
                try:
                    tool_result = await handler(ctx, args)
                except Exception as exc:  # noqa: BLE001 - surface to model
                    tool_result = {"error": f"{type(exc).__name__}: {exc}"}
            messages.append({
                "role": "tool",
                "name": name,
                "content": json.dumps(tool_result, ensure_ascii=False, default=str),
            })
    else:
        # Loop exhausted without a final answer.
        answer = (
            "Ich habe die maximale Anzahl an Tool-Aufrufen erreicht, ohne zu "
            "einer abschließenden Antwort zu kommen. Bitte stelle die Frage "
            "konkreter oder schränke den Zeitraum / die Quelle ein."
        )

    # Pull baseline events into references so the UI panel always shows the
    # real events the answer is grounded in, even if the model did not call a
    # tool itself.
    if not ctx.collected_events:
        try:
            await TOOL_REGISTRY["get_recent_logs"](ctx, {"limit": 15})
        except Exception:  # noqa: BLE001
            pass

    return answer, collect_references(ctx)


async def _get_model_settings(
    session: AsyncSession,
    model_profile_id: Optional[str],
) -> tuple[str, str, float, int]:
    """Return (ollama_model, system_prompt, temperature, max_tokens)."""
    if model_profile_id:
        result = await session.execute(
            select(ModelProfile).where(
                ModelProfile.id == model_profile_id,
                ModelProfile.enabled == True,  # noqa: E712
            )
        )
        profile = result.scalar_one_or_none()
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Model profile not found or disabled.",
            )
        return (
            profile.ollama_model,
            profile.system_prompt_template,
            float(profile.temperature),
            profile.max_tokens,
        )
    settings = get_settings()
    return _DEFAULT_MODEL, _DEFAULT_SYSTEM, 0.2, 1024


# ---------------------------------------------------------------------------
# GET /ai/models
# ---------------------------------------------------------------------------

@router.get("/models", response_model=AIModelListResponse)
async def list_models():
    """Proxy Ollama /api/tags to list available local models."""
    try:
        raw = await ollama_client.list_models()
    except (httpx.ConnectError, httpx.HTTPError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Ollama is not reachable. Ensure it is running at the configured base URL.",
        )

    items = [
        AIModelResponse(
            name=m.get("name", ""),
            size=str(m.get("size", "")) if m.get("size") else None,
            family=m.get("details", {}).get("family"),
            modified_at=m.get("modified_at"),
        )
        for m in raw
    ]
    return AIModelListResponse(items=items)


# ---------------------------------------------------------------------------
# POST /ai/analyze/window
# ---------------------------------------------------------------------------

async def _run_window_analysis(
    job_id: str,
    db_url: str,
    from_dt: datetime,
    to_dt: datetime,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
) -> None:
    """Background task: fetch events in window, call Ollama, persist AIAnalysis."""
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            stmt = (
                select(Event)
                .where(Event.timestamp >= from_dt, Event.timestamp <= to_dt)
                .order_by(Event.timestamp.asc())
                .limit(500)
            )
            result = await session.execute(stmt)
            events = result.scalars().all()

            if not events:
                job_store.set_completed(job_id, {"summary": "No events in the given time window."})
                return

            event_count = len(events)
            log_text = "\n".join(
                f"[{e.timestamp.isoformat()}] [{e.severity.upper()}] {e.message}"
                for e in events
            )
            del events  # release ORM objects after extracting the text we need
            prompt = (
                f"Analyze these {event_count} log events from "
                f"{from_dt.isoformat()} to {to_dt.isoformat()}:\n\n{log_text}\n\n"
                "Summarize key issues, root causes, and recommended actions."
            )
            del log_text  # release after prompt is assembled

            answer = await ollama_client.generate(model, prompt, system, temperature, max_tokens)

            analysis = AIAnalysis(
                target_type="window",
                target_ref=f"{from_dt.isoformat()}/{to_dt.isoformat()}",
                model_name=model,
                prompt_version="v1",
                result_text=answer,
            )
            session.add(analysis)
            await session.commit()

        job_store.set_completed(job_id, {"summary": answer})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/analyze/window", response_model=AsyncJobAccepted, status_code=202)
async def analyze_window(
    body: AIAnalyzeWindowRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    model, system, temperature, max_tokens = await _get_model_settings(
        session, body.model_profile_id
    )
    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_window_analysis,
        job_id,
        settings.database_url,
        body.from_,
        body.to,
        model,
        system,
        temperature,
        max_tokens,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# POST /ai/analyze/incident/{id}
# ---------------------------------------------------------------------------

async def _run_incident_analysis(
    job_id: str,
    incident_id: str,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
) -> None:
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(Incident).where(Incident.id == incident_id)
            )
            incident = result.scalar_one_or_none()
            if incident is None:
                job_store.set_failed(job_id, "Incident not found.")
                return

            prompt = (
                f"Analyze this incident:\n"
                f"Title: {incident.title}\n"
                f"Status: {incident.status}\n"
                f"Severity: {incident.severity}\n"
                f"First seen: {incident.first_seen.isoformat()}\n"
                f"Last seen: {incident.last_seen.isoformat()}\n"
                f"Event count: {incident.event_count}\n"
                f"Summary: {incident.summary or 'N/A'}\n\n"
                "Provide a root cause analysis and recommended remediation steps."
            )

            answer = await ollama_client.generate(model, prompt, system, temperature, max_tokens)

            analysis = AIAnalysis(
                target_type="incident",
                target_ref=incident_id,
                model_name=model,
                prompt_version="v1",
                result_text=answer,
            )
            session.add(analysis)
            await session.commit()

        job_store.set_completed(job_id, {"summary": answer})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/analyze/incident/{incident_id}", response_model=AsyncJobAccepted, status_code=202)
async def analyze_incident(
    incident_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[AIAnalyzeIncidentRequest] = None,
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(select(Incident).where(Incident.id == incident_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found.")

    model_profile_id = body.model_profile_id if body else None
    model, system, temperature, max_tokens = await _get_model_settings(session, model_profile_id)

    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_incident_analysis,
        job_id,
        incident_id,
        model,
        system,
        temperature,
        max_tokens,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# POST /ai/chat
# ---------------------------------------------------------------------------

@router.post("/chat", response_model=AIChatResponse)
async def ai_chat(
    body: AIChatRequest,
    session: AsyncSession = Depends(get_db),
):
    # --- Model resolution ---
    if body.model_profile_id:
        model, system, temperature, max_tokens = await _get_model_settings(
            session, body.model_profile_id
        )
    elif body.model:
        model = body.model
        system = _DEFAULT_SYSTEM
        temperature = 0.2
        max_tokens = 2048
    else:
        model, system, temperature, max_tokens = await _get_model_settings(session, None)

    try:
        answer, references = await _run_tool_chat(
            session,
            model=model,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            message=body.message,
            source_ids=[],
            source_paths=[],
            since_hours=None,
            context=body.context,
        )
    except (httpx.ConnectError, httpx.HTTPError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Ollama error: {exc}",
        )

    return AIChatResponse(answer=answer, references=references[:25])


# ---------------------------------------------------------------------------
# POST /ai/chat/async
# ---------------------------------------------------------------------------

async def _run_chat_async(
    job_id: str,
    db_url: str,
    model: str,
    system: str,
    temperature: float,
    max_tokens: int,
    message: str,
    source_ids: list[str],
    source_paths: list[str],
    since_hours: float | None,
    context: dict | None,
) -> None:
    from app.db.session import get_session_factory

    job_store.set_running(job_id)
    try:
        factory = get_session_factory()
        async with factory() as session:
            answer, references = await _run_tool_chat(
                session,
                model=model,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                message=message,
                source_ids=source_ids,
                source_paths=source_paths,
                since_hours=since_hours,
                context=context,
            )
        job_store.set_completed(job_id, {"answer": answer, "references": references[:25]})
    except Exception as exc:
        job_store.set_failed(job_id, str(exc))


@router.post("/chat/async", response_model=AsyncJobAccepted, status_code=202)
async def ai_chat_async(
    body: AIChatAsyncRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    settings=Depends(get_settings),
):
    if body.model_profile_id:
        model, system, temperature, max_tokens = await _get_model_settings(
            session, body.model_profile_id
        )
    elif body.model:
        model = body.model
        system = _DEFAULT_SYSTEM
        temperature = 0.2
        max_tokens = 2048
    else:
        model, system, temperature, max_tokens = await _get_model_settings(session, None)

    job_id = job_store.create_job()
    background_tasks.add_task(
        _run_chat_async,
        job_id,
        settings.database_url,
        model,
        system,
        temperature,
        max_tokens,
        body.message,
        body.source_ids or [],
        body.source_paths or [],
        body.since_hours,
        body.context,
    )
    return AsyncJobAccepted(job_id=job_id)


# ---------------------------------------------------------------------------
# GET /ai/jobs/{id}
# ---------------------------------------------------------------------------

@router.get("/jobs/{job_id}", response_model=AIJob)
async def get_job(job_id: str):
    job = job_store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    return AIJob(**job)
