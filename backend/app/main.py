from contextlib import asynccontextmanager
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import SessionLocal, init_db
from .models import User
from .routers import auth, comics, library, narration
from .security import hash_password
from .services.external_comics import close_shared_http_client


def _bootstrap_admin_from_env() -> None:
    if not (settings.ADMIN_USERNAME and settings.ADMIN_PASSWORD):
        return
    db = SessionLocal()
    try:
        uname = settings.ADMIN_USERNAME.strip()
        email = (settings.ADMIN_EMAIL or f"{uname.lower()}@admin.local").strip().lower()
        existing = db.query(User).filter(User.username == uname).first()
        if existing:
            if existing.role != "admin":
                existing.role = "admin"
                db.commit()
        else:
            db.add(
                User(
                    username=uname,
                    email=email,
                    password_hash=hash_password(settings.ADMIN_PASSWORD),
                    role="admin",
                )
            )
            db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.validate_production_secrets()
    init_db()
    _bootstrap_admin_from_env()
    try:
        yield
    finally:
        await close_shared_http_client()


app = FastAPI(
    title="Lười Truyện API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX.strip() or None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Range"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)
app.add_middleware(GZipMiddleware, minimum_size=800)


@app.middleware("http")
async def _storage_cache_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    if response.status_code in (200, 206, 304):
        path = request.url.path
        if path.startswith("/storage/audio_cache/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.startswith("/storage/uploads/"):
            response.headers["Cache-Control"] = "public, max-age=604800"
    return response

app.mount(
    "/storage/uploads",
    StaticFiles(directory=str(settings.uploads_path)),
    name="uploads",
)
app.mount(
    "/storage/audio_cache",
    StaticFiles(directory=str(settings.audio_cache_path)),
    name="audio_cache",
)

app.include_router(auth.router)
app.include_router(comics.router)
app.include_router(narration.router)
app.include_router(library.router)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "gemini_model": settings.GEMINI_MODEL,
        "server_has_gemini_key": bool(settings.GEMINI_API_KEY),
        "default_engine": "ocr",
    }


# Optional single-container SPA serving (used in Docker / production)
_frontend_dist = os.environ.get("FRONTEND_DIST_DIR", "").strip()
if _frontend_dist:
    _dist_path = Path(_frontend_dist).resolve()
    _assets_dir = _dist_path / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="frontend_assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("storage/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (_dist_path / full_path).resolve()
        if full_path and candidate.is_relative_to(_dist_path) and candidate.is_file():
            return FileResponse(str(candidate))
        index_html = _dist_path / "index.html"
        if index_html.is_file():
            return FileResponse(str(index_html))
        raise HTTPException(status_code=404, detail="Frontend bundle not found")
else:
    @app.get("/", include_in_schema=False)
    def root_status():
        return {
            "status": "ok",
            "service": "Lười Truyện API",
            "default_engine": "ocr",
            "health": "/api/health",
            "docs": "/docs",
        }
