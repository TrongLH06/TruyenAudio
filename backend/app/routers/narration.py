import asyncio

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..deps import get_db, get_optional_user
from ..models import User
from ..schemas import (
    BatchNarrationRequest,
    BatchNarrationResponse,
    PageNarrationRequest,
    PageNarrationResponse,
    PrefetchRequest,
)
from ..security import enforce_rate_limit
from ..services.narration_service import (
    generate_or_get_batch_narration,
    generate_or_get_page_narration,
)

router = APIRouter(prefix="/api/narration", tags=["narration"])


@router.post("/page", response_model=PageNarrationResponse)
async def narrate_page(
    payload: PageNarrationRequest,
    request: Request,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(request, "narration_page", max_requests=45, window_seconds=60)
    return await generate_or_get_page_narration(db, payload, user)


@router.post("/batch", response_model=BatchNarrationResponse)
async def narrate_batch(
    payload: BatchNarrationRequest,
    request: Request,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(request, "narration_batch", max_requests=25, window_seconds=60)
    return await generate_or_get_batch_narration(db, payload, user)


async def _prefetch_worker(
    req_list: list[PageNarrationRequest],
    user_id: str | None,
) -> None:
    db = SessionLocal()
    try:
        user = db.get(User, user_id) if user_id else None
        for item in req_list:
            try:
                await generate_or_get_page_narration(db, item, user)
            except Exception:
                # Prefetch is best-effort; stop on quota/auth errors quietly
                break
    finally:
        db.close()


@router.post("/prefetch")
async def prefetch_pages(
    payload: PrefetchRequest,
    request: Request,
    user: User | None = Depends(get_optional_user),
):
    enforce_rate_limit(request, "narration_prefetch", max_requests=25, window_seconds=60)
    req_list = [
        PageNarrationRequest(
            source_type=payload.source_type,
            comic_id=payload.comic_id,
            chapter_id=payload.chapter_id,
            page_index=p.page_index,
            image_url=p.image_url,
            mode=payload.mode,
            engine=payload.engine,
            voice=payload.voice,
            demo_mode=payload.demo_mode,
            comic_title=payload.comic_title,
        )
        for p in payload.pages[:3]
    ]
    if req_list:
        asyncio.create_task(_prefetch_worker(req_list, user.id if user else None))
    return {"queued": len(req_list)}
