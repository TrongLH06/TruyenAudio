from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..deps import get_current_user, get_db
from ..models import Favorite, ReadingHistory, User
from ..schemas import (
    FavoriteItem,
    FavoriteToggleRequest,
    HistoryItem,
    HistoryUpdateRequest,
)

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("/favorites", response_model=list[FavoriteItem])
def list_favorites(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Favorite)
        .filter(Favorite.user_id == user.id)
        .order_by(Favorite.created_at.desc())
        .all()
    )
    return [
        FavoriteItem(
            id=r.id,
            source_type=r.source_type,
            comic_id=r.comic_id,
            comic_title=r.comic_title,
            cover_url=r.cover_url,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.post("/favorites/toggle")
def toggle_favorite(
    payload: FavoriteToggleRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(Favorite)
        .filter(
            Favorite.user_id == user.id,
            Favorite.source_type == payload.source_type,
            Favorite.comic_id == payload.comic_id,
        )
        .first()
    )
    if existing:
        db.delete(existing)
        db.commit()
        return {"favorited": False}

    fav = Favorite(
        user_id=user.id,
        source_type=payload.source_type,
        comic_id=payload.comic_id,
        comic_title=payload.comic_title,
        cover_url=payload.cover_url,
    )
    db.add(fav)
    db.commit()
    return {"favorited": True}


@router.get("/history", response_model=list[HistoryItem])
def list_history(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(ReadingHistory)
        .filter(ReadingHistory.user_id == user.id)
        .order_by(ReadingHistory.updated_at.desc())
        .limit(50)
        .all()
    )
    return [
        HistoryItem(
            id=r.id,
            source_type=r.source_type,
            comic_id=r.comic_id,
            comic_title=r.comic_title,
            cover_url=r.cover_url,
            chapter_id=r.chapter_id,
            chapter_title=r.chapter_title,
            page_index=r.page_index,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.post("/history")
def upsert_history(
    payload: HistoryUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(ReadingHistory)
        .filter(
            ReadingHistory.user_id == user.id,
            ReadingHistory.source_type == payload.source_type,
            ReadingHistory.comic_id == payload.comic_id,
        )
        .first()
    )
    now = datetime.now(timezone.utc)
    if existing:
        existing.comic_title = payload.comic_title
        if payload.cover_url:
            existing.cover_url = payload.cover_url
        existing.chapter_id = payload.chapter_id
        existing.chapter_title = payload.chapter_title
        existing.page_index = payload.page_index
        existing.updated_at = now
    else:
        db.add(
            ReadingHistory(
                user_id=user.id,
                source_type=payload.source_type,
                comic_id=payload.comic_id,
                comic_title=payload.comic_title,
                cover_url=payload.cover_url,
                chapter_id=payload.chapter_id,
                chapter_title=payload.chapter_title,
                page_index=payload.page_index,
                updated_at=now,
            )
        )
    db.commit()
    return {"ok": True}
