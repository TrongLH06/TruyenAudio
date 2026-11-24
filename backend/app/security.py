import base64
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
import hashlib
import time

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request, status
import jwt

from .config import settings


def hash_password(password: str) -> str:
    pw_bytes = password.encode("utf-8")
    if len(pw_bytes) > 72:
        raise HTTPException(status_code=400, detail="Mật khẩu không được vượt quá 72 byte.")
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(pw_bytes, salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        pw_bytes = password.encode("utf-8")
        if len(pw_bytes) > 72:
            return False
        return bcrypt.checkpw(pw_bytes, password_hash.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> str | None:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
        )
        sub = payload.get("sub")
        return str(sub) if sub else None
    except jwt.PyJWTError:
        return None


def _get_fernet() -> Fernet:
    # Dedicated encryption key separated from JWT signing secret
    digest = hashlib.sha256(settings.API_KEY_ENCRYPTION_KEY.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_api_key(raw_key: str) -> str:
    return _get_fernet().encrypt(raw_key.strip().encode("utf-8")).decode("utf-8")


def decrypt_api_key(encrypted_key: str) -> str | None:
    try:
        return _get_fernet().decrypt(encrypted_key.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None


def mask_api_key(raw_key: str) -> str:
    k = raw_key.strip()
    if len(k) <= 8:
        return "****"
    return f"{k[:4]}...{k[-4:]}"


# Lightweight sliding-window in-memory rate limiter
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)


def enforce_rate_limit(request: Request, scope: str, max_requests: int, window_seconds: int) -> None:
    client_ip = request.client.host if request.client else "unknown"
    bucket_key = f"{scope}:{client_ip}"
    now = time.monotonic()
    q = _RATE_BUCKETS[bucket_key]
    cutoff = now - window_seconds
    while q and q[0] < cutoff:
        q.popleft()
    if len(q) >= max_requests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.",
        )
    q.append(now)
    # Periodic cleanup to avoid unbounded dict growth
    if len(_RATE_BUCKETS) > 5000:
        empty_keys = [k for k, dq in _RATE_BUCKETS.items() if not dq or dq[-1] < cutoff]
        for k in empty_keys:
            _RATE_BUCKETS.pop(k, None)
