"""Parser test endpoint – POST /api/v1/parser/test."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.domain.models import ParserProfile
from app.parser.pipeline import parse_line
from app.schemas.event import ParserTestRequest, ParserTestResponse

router = APIRouter(prefix="/parser", tags=["Parser"])


@router.post("/test", response_model=ParserTestResponse, summary="Test parser pattern")
async def test_parser(
    body: ParserTestRequest,
    session: AsyncSession = Depends(get_db),
):
    profile: Optional[ParserProfile] = None

    if body.parser_profile_id:
        result = await session.execute(
            select(ParserProfile).where(ParserProfile.id == body.parser_profile_id)
        )
        profile = result.scalar_one_or_none()
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parser profile not found.",
            )

    matched = 0
    preview: List[Dict[str, Any]] = []

    for line in body.sample_lines:
        if profile:
            parsed = parse_line(
                line,
                fmt=profile.format,
                pattern=profile.pattern,
                mapping=profile.mapping_json,
            )
        else:
            # Auto-detect: try json → kv
            parsed = parse_line(line, "json", None, None)
            if parsed is None:
                parsed = parse_line(line, "kv", None, None)

        if parsed is not None:
            matched += 1
            preview.append(parsed)

    return ParserTestResponse(
        matched=matched,
        total=len(body.sample_lines),
        preview_events=preview,
    )
