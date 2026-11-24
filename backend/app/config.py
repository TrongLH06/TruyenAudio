from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent

DEFAULT_DEV_JWT_SECRET = "dev-secret-change-me-in-production-32-chars-min"
DEFAULT_DEV_ENC_KEY = "dev-encryption-key-change-me-in-production-32-chars"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_ENV: str = "development"
    JWT_SECRET: str = DEFAULT_DEV_JWT_SECRET
    API_KEY_ENCRYPTION_KEY: str = DEFAULT_DEV_ENC_KEY
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"
    CORS_ORIGIN_REGEX: str = ""

    DATABASE_URL: str = f"sqlite:///{(BACKEND_DIR / 'storage' / 'app.db').as_posix()}"
    STORAGE_DIR: str = str(BACKEND_DIR / "storage")
    OCR_MODELS_DIR: str = ""

    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.5-flash-lite"
    DAILY_FREE_NARRATION_LIMIT: int = 30

    ADMIN_USERNAME: str = ""
    ADMIN_EMAIL: str = ""
    ADMIN_PASSWORD: str = ""

    def validate_production_secrets(self) -> None:
        if self.APP_ENV.lower() != "development":
            if (
                not self.JWT_SECRET
                or self.JWT_SECRET == DEFAULT_DEV_JWT_SECRET
                or len(self.JWT_SECRET) < 32
            ):
                raise RuntimeError(
                    "JWT_SECRET phải được cấu hình riêng (ít nhất 32 ký tự) khi chạy ngoài môi trường development."
                )
            if (
                not self.API_KEY_ENCRYPTION_KEY
                or self.API_KEY_ENCRYPTION_KEY == DEFAULT_DEV_ENC_KEY
                or len(self.API_KEY_ENCRYPTION_KEY) < 32
                or self.API_KEY_ENCRYPTION_KEY == self.JWT_SECRET
            ):
                raise RuntimeError(
                    "API_KEY_ENCRYPTION_KEY phải được cấu hình riêng biệt (>= 32 ký tự, khác JWT_SECRET) ở production."
                )

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def storage_path(self) -> Path:
        p = Path(self.STORAGE_DIR)
        if not p.is_absolute():
            p = (BACKEND_DIR / p).resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def ocr_models_path(self) -> Path:
        if self.OCR_MODELS_DIR.strip():
            p = Path(self.OCR_MODELS_DIR.strip())
            if not p.is_absolute():
                p = (BACKEND_DIR / p).resolve()
        else:
            p = self.storage_path / "ocr_models"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def uploads_path(self) -> Path:
        p = self.storage_path / "uploads"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def audio_cache_path(self) -> Path:
        p = self.storage_path / "audio_cache"
        p.mkdir(parents=True, exist_ok=True)
        return p


settings = Settings()
_ = settings.uploads_path
_ = settings.audio_cache_path
