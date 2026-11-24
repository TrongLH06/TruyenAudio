import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import get_current_user, get_db
from ..models import Chapter, Comic, User
from ..schemas import (
    ChapterItem,
    ChapterPagesResponse,
    ComicDetail,
    ComicSummary,
    HiNetHomeResponse,
    SourceTypeLiteral,
)
from ..security import enforce_rate_limit
from ..services.external_comics import (
    fetch_proxied_image,
    fetch_proxied_image_optimized,
    get_hinet_chapter_pages,
    get_hinet_detail,
    get_hinet_home,
    get_mangadex_chapter_pages,
    get_mangadex_detail,
    get_otruyen_chapter_pages,
    get_otruyen_detail,
    list_hinet_comics,
    list_mangadex_comics,
    list_otruyen_comics,
)
from ..services.upload_service import create_new_comic_id, process_uploaded_chapter

router = APIRouter(prefix="/api/comics", tags=["comics"])


@router.get("/local", response_model=list[ComicSummary])
def list_local_comics(
    q: str = Query(default="", max_length=120),
    db: Session = Depends(get_db),
):
    query = db.query(Comic).filter(Comic.is_public == 1)
    if q.strip():
        query = query.filter(Comic.title.ilike(f"%{q.strip()}%"))
    comics = query.order_by(Comic.created_at.desc()).all()

    results: list[ComicSummary] = []
    for c in comics:
        latest = c.chapters[-1].title if c.chapters else ""
        results.append(
            ComicSummary(
                id=c.id,
                source_type="local",
                title=c.title,
                cover_url=c.cover_url,
                description=c.description,
                latest_chapter=latest,
                language="vi",
                chapter_count=len(c.chapters),
            )
        )
    return results


@router.post("/upload", response_model=ComicDetail)
async def upload_comic_chapter(
    title: str = Form(..., min_length=1, max_length=200),
    chapter_title: str = Form(default="Chương 1", max_length=200),
    description: str = Form(default="", max_length=2000),
    comic_id: str | None = Form(default=None),
    files: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Chỉ tài khoản chủ web (Admin) mới có quyền tải truyện lên.")
    if comic_id:
        comic = db.query(Comic).filter(Comic.id == comic_id).first()
        if not comic:
            raise HTTPException(status_code=404, detail="Không tìm thấy bộ truyện cần thêm chương.")
        if comic.owner_id != user.id and user.role != "admin":
            raise HTTPException(status_code=403, detail="Bạn không có quyền thêm chương vào bộ truyện này.")
    else:
        new_id = create_new_comic_id()
        comic = Comic(
            id=new_id,
            owner_id=user.id,
            title=title.strip(),
            description=description.strip(),
            cover_url="",
            source_type="local",
            is_public=1,
        )
        db.add(comic)
        db.flush()

    chapter_id = f"ch-{uuid.uuid4().hex[:10]}"
    comic_dir = settings.uploads_path / comic.id
    pages = await process_uploaded_chapter(files, comic_dir, chapter_id)

    sort_order = len(comic.chapters) + 1
    chapter = Chapter(
        id=chapter_id,
        comic_id=comic.id,
        title=chapter_title.strip() or f"Chương {sort_order}",
        sort_order=sort_order,
        pages_json=json.dumps(pages),
        page_count=len(pages),
    )
    if not comic.cover_url and pages:
        comic.cover_url = pages[0]

    db.add(chapter)
    db.commit()
    db.refresh(comic)

    return ComicDetail(
        id=comic.id,
        source_type="local",
        title=comic.title,
        description=comic.description,
        cover_url=comic.cover_url,
        chapters=[
            ChapterItem(
                id=ch.id,
                title=ch.title,
                chapter_number=str(ch.sort_order),
                page_count=ch.page_count,
                language="vi",
            )
            for ch in comic.chapters
        ],
    )


@router.get("/hinettruyen/home", response_model=HiNetHomeResponse)
async def hinet_home(response: Response):
    response.headers["Cache-Control"] = "public, max-age=120"
    return await get_hinet_home()


@router.get("/external", response_model=list[ComicSummary])
async def browse_external_comics(
    response: Response,
    source: Literal["hinettruyen", "otruyen", "mangadex"] = Query(default="hinettruyen"),
    q: str = Query(default="", max_length=120),
    genre: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1, le=200),
):
    response.headers["Cache-Control"] = "public, max-age=120"
    if source == "hinettruyen":
        return await list_hinet_comics(query=q, genre=genre, page=page)
    if source == "otruyen":
        return await list_otruyen_comics(q)
    return await list_mangadex_comics(q)


@router.get("/proxy-image")
async def proxy_external_image(
    request: Request,
    url: str = Query(..., min_length=10, max_length=2000),
    w: int | None = Query(default=None, ge=160, le=1600),
    q: int = Query(default=78, ge=45, le=95),
):
    enforce_rate_limit(request, "proxy_image", max_requests=180, window_seconds=60)
    prefer_webp = "image/webp" in request.headers.get("accept", "").lower()
    data, content_type = await fetch_proxied_image_optimized(
        url,
        width=w,
        quality=q,
        prefer_webp=prefer_webp,
    )
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
            "Vary": "Accept",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.get("/{source_type}/{comic_id}", response_model=ComicDetail)
async def get_comic_detail(
    source_type: SourceTypeLiteral,
    comic_id: str,
    response: Response,
    db: Session = Depends(get_db),
):
    if source_type == "local":
        comic = db.query(Comic).filter(Comic.id == comic_id).first()
        if not comic:
            raise HTTPException(status_code=404, detail="Không tìm thấy truyện.")
        return ComicDetail(
            id=comic.id,
            source_type="local",
            title=comic.title,
            description=comic.description,
            cover_url=comic.cover_url,
            chapters=[
                ChapterItem(
                    id=ch.id,
                    title=ch.title,
                    chapter_number=str(ch.sort_order),
                    page_count=ch.page_count,
                    language="vi",
                )
                for ch in comic.chapters
            ],
        )
    response.headers["Cache-Control"] = "public, max-age=300"
    if source_type == "hinettruyen":
        return await get_hinet_detail(comic_id)
    if source_type == "otruyen":
        return await get_otruyen_detail(comic_id)
    return await get_mangadex_detail(comic_id)


@router.get("/{source_type}/{comic_id}/chapters/{chapter_id}", response_model=ChapterPagesResponse)
async def get_chapter_pages(
    source_type: SourceTypeLiteral,
    comic_id: str,
    chapter_id: str,
    response: Response,
    db: Session = Depends(get_db),
):
    if source_type == "local":
        comic = db.query(Comic).filter(Comic.id == comic_id).first()
        if not comic:
            raise HTTPException(status_code=404, detail="Không tìm thấy truyện.")
        chapters = comic.chapters
        target_idx = next((i for i, ch in enumerate(chapters) if ch.id == chapter_id), None)
        if target_idx is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy chương truyện.")
        target = chapters[target_idx]
        pages = json.loads(target.pages_json)
        prev_id = chapters[target_idx - 1].id if target_idx > 0 else None
        next_id = chapters[target_idx + 1].id if target_idx + 1 < len(chapters) else None
        return ChapterPagesResponse(
            comic_id=comic.id,
            source_type="local",
            chapter_id=target.id,
            chapter_title=target.title,
            pages=pages,
            prev_chapter_id=prev_id,
            next_chapter_id=next_id,
        )
    response.headers["Cache-Control"] = "public, max-age=300"
    if source_type == "hinettruyen":
        return await get_hinet_chapter_pages(comic_id, chapter_id)
    if source_type == "otruyen":
        return await get_otruyen_chapter_pages(comic_id, chapter_id)
    return await get_mangadex_chapter_pages(comic_id, chapter_id)
