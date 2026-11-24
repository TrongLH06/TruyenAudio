from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import get_current_user, get_db
from ..models import User
from ..schemas import (
    ApiKeyUpdateRequest,
    AuthResponse,
    LoginRequest,
    RegisterRequest,
    UserProfile,
)
from ..security import (
    create_access_token,
    encrypt_api_key,
    enforce_rate_limit,
    hash_password,
    mask_api_key,
    verify_password,
)
from ..services.narration_service import get_user_daily_usage

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _to_profile(db: Session, user: User) -> UserProfile:
    role = getattr(user, "role", "user") or "user"
    return UserProfile(
        id=user.id,
        username=user.username,
        email=user.email,
        role=role,
        is_admin=(role == "admin"),
        has_custom_api_key=bool(user.encrypted_gemini_key),
        key_hint=user.key_hint,
        daily_free_used=get_user_daily_usage(db, user.id),
        daily_free_limit=settings.DAILY_FREE_NARRATION_LIMIT,
        server_has_gemini_key=bool(settings.GEMINI_API_KEY),
    )


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    enforce_rate_limit(request, "auth_register", max_requests=10, window_seconds=300)
    username = payload.username.strip()
    email = payload.email.strip().lower()

    exists = (
        db.query(User)
        .filter(or_(User.username == username, User.email == email))
        .first()
    )
    if exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Tên đăng nhập hoặc email đã được sử dụng.",
        )

    user = User(
        username=username,
        email=email,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id)
    return AuthResponse(access_token=token, user=_to_profile(db, user))


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    enforce_rate_limit(request, "auth_login", max_requests=20, window_seconds=300)
    ident = payload.identifier.strip()
    user = (
        db.query(User)
        .filter(or_(User.username == ident, User.email == ident.lower()))
        .first()
    )
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sai tên đăng nhập/email hoặc mật khẩu.",
        )

    token = create_access_token(user.id)
    return AuthResponse(access_token=token, user=_to_profile(db, user))


@router.get("/me", response_model=UserProfile)
def get_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _to_profile(db, user)


@router.put("/settings/api-key", response_model=UserProfile)
def update_api_key(
    payload: ApiKeyUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    raw_key = (payload.gemini_api_key or "").strip()
    if not raw_key:
        user.encrypted_gemini_key = None
        user.key_hint = None
    else:
        if len(raw_key) < 20:
            raise HTTPException(status_code=400, detail="Gemini API key có vẻ không hợp lệ (quá ngắn).")
        user.encrypted_gemini_key = encrypt_api_key(raw_key)
        user.key_hint = mask_api_key(raw_key)

    db.commit()
    db.refresh(user)
    return _to_profile(db, user)
