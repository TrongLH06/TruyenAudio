from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator


# --- Auth ---
class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=72)

    @field_validator("password")
    @classmethod
    def check_password_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Mật khẩu không được vượt quá 72 byte.")
        return v


class LoginRequest(BaseModel):
    identifier: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=1, max_length=72)


class UserProfile(BaseModel):
    id: str
    username: str
    email: str
    role: str = "user"
    is_admin: bool = False
    has_custom_api_key: bool
    key_hint: str | None = None
    daily_free_used: int = 0
    daily_free_limit: int = 30
    server_has_gemini_key: bool = False


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserProfile


class ApiKeyUpdateRequest(BaseModel):
    gemini_api_key: str | None = Field(default=None, max_length=256)


SourceTypeLiteral = Literal["local", "hinettruyen", "otruyen", "mangadex"]
VoiceLiteral = Literal["hoaimy", "namminh"]
EngineLiteral = Literal["ocr", "ai"]


# --- Comics & Chapters ---
class ComicSummary(BaseModel):
    id: str
    source_type: SourceTypeLiteral
    title: str
    cover_url: str = ""
    description: str = ""
    latest_chapter: str = ""
    language: str = "vi"
    chapter_count: int = 0


class GenreItem(BaseModel):
    name: str
    slug: str


class HiNetHomeResponse(BaseModel):
    featured: list[ComicSummary] = Field(default_factory=list)
    latest: list[ComicSummary] = Field(default_factory=list)
    top_month: list[ComicSummary] = Field(default_factory=list)
    top_week: list[ComicSummary] = Field(default_factory=list)
    top_day: list[ComicSummary] = Field(default_factory=list)
    genres: list[GenreItem] = Field(default_factory=list)


class ChapterItem(BaseModel):
    id: str
    title: str
    chapter_number: str = ""
    page_count: int = 0
    language: str = "vi"
    updated_at: str = ""
    views: str = ""


class ComicDetail(BaseModel):
    id: str
    source_type: SourceTypeLiteral
    title: str
    description: str = ""
    cover_url: str = ""
    authors: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    status: str = ""
    updated_at: str = ""
    chapters: list[ChapterItem] = Field(default_factory=list)


class ChapterPagesResponse(BaseModel):
    comic_id: str
    source_type: SourceTypeLiteral
    chapter_id: str
    chapter_title: str
    pages: list[str]
    prev_chapter_id: str | None = None
    next_chapter_id: str | None = None


# --- Narration ---
class PageNarrationRequest(BaseModel):
    source_type: SourceTypeLiteral
    comic_id: str = Field(..., min_length=1, max_length=120)
    chapter_id: str = Field(..., min_length=1, max_length=255)
    page_index: int = Field(..., ge=0, le=1000)
    image_url: str = Field(..., min_length=1, max_length=1000)
    mode: Literal["dialogue", "storytelling"] = "storytelling"
    engine: EngineLiteral = "ocr"
    voice: VoiceLiteral = "hoaimy"
    demo_mode: bool = False
    allow_fallback: bool = False
    comic_title: str = Field(default="", max_length=200)
    previous_context: str = Field(default="", max_length=1500)


class PageNarrationResponse(BaseModel):
    page_index: int
    mode: str
    engine: str = "ocr"
    voice: str = "hoaimy"
    script_text: str
    audio_url: str | None = None
    duration_ms: int
    cached: bool = False
    used_demo: bool = False
    translated: bool = False


class BatchNarrationPageItem(BaseModel):
    page_index: int = Field(..., ge=0, le=1000)
    image_url: str = Field(..., min_length=1, max_length=1000)


class BatchNarrationRequest(BaseModel):
    source_type: SourceTypeLiteral
    comic_id: str = Field(..., min_length=1, max_length=120)
    chapter_id: str = Field(..., min_length=1, max_length=255)
    mode: Literal["dialogue", "storytelling"] = "storytelling"
    engine: EngineLiteral = "ocr"
    voice: VoiceLiteral = "hoaimy"
    demo_mode: bool = False
    allow_fallback: bool = True
    comic_title: str = Field(default="", max_length=200)
    previous_context: str = Field(default="", max_length=1500)
    pages: list[BatchNarrationPageItem] = Field(..., min_length=1, max_length=6)


class BatchNarrationResponse(BaseModel):
    items: list[PageNarrationResponse]
    batch_ai_calls: int = 0
    fallback_used: bool = False


class PrefetchPageItem(BaseModel):
    page_index: int = Field(..., ge=0, le=1000)
    image_url: str = Field(..., min_length=1, max_length=1000)


class PrefetchRequest(BaseModel):
    source_type: SourceTypeLiteral
    comic_id: str = Field(..., min_length=1, max_length=120)
    chapter_id: str = Field(..., min_length=1, max_length=255)
    mode: Literal["dialogue", "storytelling"] = "storytelling"
    engine: EngineLiteral = "ocr"
    voice: VoiceLiteral = "hoaimy"
    demo_mode: bool = False
    comic_title: str = Field(default="", max_length=200)
    pages: list[PrefetchPageItem] = Field(..., max_length=4)


# --- Library (Favorites & History) ---
class FavoriteToggleRequest(BaseModel):
    source_type: SourceTypeLiteral
    comic_id: str = Field(..., min_length=1, max_length=120)
    comic_title: str = Field(..., min_length=1, max_length=255)
    cover_url: str = Field(default="", max_length=500)


class FavoriteItem(BaseModel):
    id: int
    source_type: str
    comic_id: str
    comic_title: str
    cover_url: str
    created_at: datetime


class HistoryUpdateRequest(BaseModel):
    source_type: SourceTypeLiteral
    comic_id: str = Field(..., min_length=1, max_length=120)
    comic_title: str = Field(..., min_length=1, max_length=255)
    cover_url: str = Field(default="", max_length=500)
    chapter_id: str = Field(..., min_length=1, max_length=255)
    chapter_title: str = Field(default="", max_length=255)
    page_index: int = Field(default=0, ge=0, le=10000)


class HistoryItem(BaseModel):
    id: int
    source_type: str
    comic_id: str
    comic_title: str
    cover_url: str
    chapter_id: str
    chapter_title: str
    page_index: int
    updated_at: datetime
