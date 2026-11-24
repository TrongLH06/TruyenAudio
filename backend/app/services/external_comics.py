import asyncio
import base64
from collections import OrderedDict
import io
import ipaddress
import logging
import re
import socket
import time
from urllib.parse import quote, urlparse
import weakref

from bs4 import BeautifulSoup
import httpx
from fastapi import HTTPException
from PIL import Image

from ..schemas import (
    ChapterItem,
    ChapterPagesResponse,
    ComicDetail,
    ComicSummary,
    GenreItem,
    HiNetHomeResponse,
)

logger = logging.getLogger(__name__)

HINET_BASE = "https://hinettruyen.com"
OTRUYEN_BASE = "https://otruyenapi.com/v1/api"
MANGADEX_BASE = "https://api.mangadex.org"

ALLOWED_IMAGE_HOSTS = {
    "hinettruyen.com",
    "img.otruyenapi.com",
    "sv1.otruyencdn.com",
    "sv2.otruyencdn.com",
    "uploads.mangadex.org",
}
ALLOWED_IMAGE_SUFFIXES = (
    ".kcgsbok.com",
    ".hinettruyen.com",
    ".otruyencdn.com",
    ".otruyenapi.com",
    ".mangadex.network",
    ".mangadex.org",
)
ALLOWED_OTRUYEN_CHAPTER_HOSTS = {
    "sv1.otruyencdn.com",
    "sv2.otruyencdn.com",
    "otruyenapi.com",
}
ALLOWED_OTRUYEN_CHAPTER_SUFFIXES = (".otruyencdn.com", ".otruyenapi.com")

ALLOWED_RASTER_MIME_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
}

MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024  # 15 MB
MAX_CACHED_IMAGE_BYTES = 2_500_000  # Cache individual images <= 2.5 MB
MAX_IMAGE_CACHE_ITEMS = 120
MAX_IMAGE_CACHE_TOTAL_BYTES = 40 * 1024 * 1024  # 40 MB total RAM budget (raw + mobile WebP)
IMAGE_CACHE_TTL = 600.0
DNS_CACHE_TTL = 300.0

HTTP_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
DEFAULT_HEADERS = {
    "User-Agent": "LazyComicReader/1.0",
    "Accept": "application/json, image/*;q=0.9",
}

_SHARED_CLIENT: httpx.AsyncClient | None = None
_DNS_PUBLIC_CACHE: dict[str, float] = {}
# Maps image URL -> (expires_at, bytes, mime_type)
_IMAGE_MEM_CACHE: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()
_IMAGE_MEM_CACHE_BYTES = 0
_IMAGE_FETCH_LOCKS: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


def get_shared_http_client() -> httpx.AsyncClient:
    global _SHARED_CLIENT
    if _SHARED_CLIENT is None or _SHARED_CLIENT.is_closed:
        _SHARED_CLIENT = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
        )
    return _SHARED_CLIENT


async def close_shared_http_client() -> None:
    global _SHARED_CLIENT
    if _SHARED_CLIENT is not None and not _SHARED_CLIENT.is_closed:
        await _SHARED_CLIENT.aclose()
    _SHARED_CLIENT = None


def _cache_image_put(url: str, data: bytes, mime: str) -> None:
    global _IMAGE_MEM_CACHE_BYTES
    size = len(data)
    if size == 0 or size > MAX_CACHED_IMAGE_BYTES:
        return
    now = time.monotonic()
    if url in _IMAGE_MEM_CACHE:
        _, old_bytes, _ = _IMAGE_MEM_CACHE.pop(url)
        _IMAGE_MEM_CACHE_BYTES -= len(old_bytes)
    while _IMAGE_MEM_CACHE and (
        len(_IMAGE_MEM_CACHE) >= MAX_IMAGE_CACHE_ITEMS
        or _IMAGE_MEM_CACHE_BYTES + size > MAX_IMAGE_CACHE_TOTAL_BYTES
    ):
        _, (_, old_bytes, _) = _IMAGE_MEM_CACHE.popitem(last=False)
        _IMAGE_MEM_CACHE_BYTES -= len(old_bytes)
    _IMAGE_MEM_CACHE[url] = (now + IMAGE_CACHE_TTL, data, mime)
    _IMAGE_MEM_CACHE_BYTES += size


def _cache_image_get(url: str) -> tuple[bytes, str] | None:
    global _IMAGE_MEM_CACHE_BYTES
    entry = _IMAGE_MEM_CACHE.get(url)
    if not entry:
        return None
    exp, data, mime = entry
    if time.monotonic() >= exp:
        _IMAGE_MEM_CACHE.pop(url, None)
        _IMAGE_MEM_CACHE_BYTES -= len(data)
        return None
    _IMAGE_MEM_CACHE.move_to_end(url)
    return data, mime


def _check_url_host(
    url: str,
    allowed_hosts: set[str],
    allowed_suffixes: tuple[str, ...],
) -> tuple[bool, str]:
    try:
        parsed = urlparse(url)
    except Exception:
        return False, ""
    if parsed.scheme != "https":
        return False, ""
    if parsed.username or parsed.password:
        return False, ""
    if parsed.port not in (None, 443):
        return False, ""
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return False, ""
    if host in allowed_hosts or any(host.endswith(suffix) for suffix in allowed_suffixes):
        return True, host
    return False, ""


def is_allowed_external_image_url(url: str) -> bool:
    ok, _ = _check_url_host(url, ALLOWED_IMAGE_HOSTS, ALLOWED_IMAGE_SUFFIXES)
    return ok


def is_allowed_otruyen_chapter_url(url: str) -> bool:
    ok, _ = _check_url_host(url, ALLOWED_OTRUYEN_CHAPTER_HOSTS, ALLOWED_OTRUYEN_CHAPTER_SUFFIXES)
    return ok


def _verify_public_dns(host: str) -> None:
    now = time.monotonic()
    cached_until = _DNS_PUBLIC_CACHE.get(host)
    if cached_until and now < cached_until:
        return

    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise HTTPException(status_code=502, detail="Không thể phân giải tên miền nguồn ảnh.")

    if not infos:
        raise HTTPException(status_code=403, detail="Tên miền nguồn ảnh không hợp lệ.")

    for info in infos:
        ip_str = info[4][0]
        try:
            ip_obj = ipaddress.ip_address(ip_str)
        except ValueError:
            raise HTTPException(status_code=403, detail="Địa chỉ IP nguồn ảnh không hợp lệ.")
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_reserved
            or ip_obj.is_multicast
            or ip_obj.is_unspecified
        ):
            raise HTTPException(status_code=403, detail="Chặn kết nối tới địa chỉ mạng nội bộ.")

    if len(_DNS_PUBLIC_CACHE) > 200:
        _DNS_PUBLIC_CACHE.clear()
    _DNS_PUBLIC_CACHE[host] = now + DNS_CACHE_TTL


async def _ensure_public_dns(host: str) -> None:
    cached_until = _DNS_PUBLIC_CACHE.get(host)
    if cached_until and time.monotonic() < cached_until:
        return
    await asyncio.to_thread(_verify_public_dns, host)


def make_proxy_url(raw_url: str) -> str:
    return f"/api/comics/proxy-image?url={quote(raw_url, safe='')}"


async def fetch_proxied_image(url: str) -> tuple[bytes, str]:
    ok, host = _check_url_host(url, ALLOWED_IMAGE_HOSTS, ALLOWED_IMAGE_SUFFIXES)
    if not ok:
        raise HTTPException(status_code=403, detail="Nguồn ảnh không nằm trong danh sách cho phép.")

    cached_img = _cache_image_get(url)
    if cached_img is not None:
        return cached_img

    lock = _IMAGE_FETCH_LOCKS.get(url)
    if lock is None:
        lock = asyncio.Lock()
        _IMAGE_FETCH_LOCKS[url] = lock

    async with lock:
        cached_img = _cache_image_get(url)
        if cached_img is not None:
            return cached_img

        await _ensure_public_dns(host)

        req_headers = dict(DEFAULT_HEADERS)
        if host == "hinettruyen.com" or host.endswith(".kcgsbok.com") or host.endswith(".hinettruyen.com"):
            req_headers["Referer"] = f"{HINET_BASE}/"
            req_headers["User-Agent"] = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )

        client = get_shared_http_client()
        current_url = url
        for _ in range(3):
            async with client.stream("GET", current_url, headers=req_headers, follow_redirects=False) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location", "")
                    loc_ok, loc_host = _check_url_host(loc, ALLOWED_IMAGE_HOSTS, ALLOWED_IMAGE_SUFFIXES)
                    if not loc_ok:
                        raise HTTPException(status_code=403, detail="Chuyển hướng ảnh không hợp lệ.")
                    await _ensure_public_dns(loc_host)
                    current_url = loc
                    continue

                if resp.status_code != 200:
                    raise HTTPException(status_code=502, detail="Không thể tải ảnh từ nguồn ngoài.")

                content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                if content_type not in ALLOWED_RASTER_MIME_TYPES:
                    raise HTTPException(status_code=400, detail="Định dạng ảnh nguồn không được hỗ trợ.")

                content_len = resp.headers.get("content-length")
                if content_len and content_len.isdigit() and int(content_len) > MAX_PROXY_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="Ảnh nguồn vượt quá giới hạn 15MB.")

                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes(65536):
                    total += len(chunk)
                    if total > MAX_PROXY_IMAGE_BYTES:
                        raise HTTPException(status_code=413, detail="Ảnh nguồn vượt quá giới hạn 15MB.")
                    chunks.append(chunk)

                mime = "image/jpeg" if content_type == "image/jpg" else content_type
                raw_bytes = b"".join(chunks)
                _cache_image_put(url, raw_bytes, mime)
                return raw_bytes, mime

    raise HTTPException(status_code=502, detail="Quá nhiều chuyển hướng khi tải ảnh.")


def _resize_and_encode_image(
    raw_bytes: bytes,
    mime: str,
    width: int,
    quality: int,
    prefer_webp: bool,
) -> tuple[bytes, str]:
    if mime == "image/gif":
        return raw_bytes, mime
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            has_alpha = "A" in img.getbands() or "transparency" in img.info
            work = img.convert("RGBA" if (prefer_webp and has_alpha) else "RGB")
            if work.width > width:
                new_h = max(1, round(work.height * (width / work.width)))
                work = work.resize((width, new_h), Image.Resampling.BILINEAR)
            buf = io.BytesIO()
            if prefer_webp:
                work.save(buf, format="WEBP", quality=quality, method=1)
                out_mime = "image/webp"
            else:
                work.save(buf, format="JPEG", quality=quality, optimize=False)
                out_mime = "image/jpeg"
            out_bytes = buf.getvalue()
            if out_bytes and (work.width < img.width or len(out_bytes) < len(raw_bytes)):
                return out_bytes, out_mime
    except Exception:
        logger.debug("Mobile image resize/encode skipped, serving original", exc_info=True)
    return raw_bytes, mime


async def fetch_proxied_image_optimized(
    url: str,
    width: int | None = None,
    quality: int = 78,
    prefer_webp: bool = True,
) -> tuple[bytes, str]:
    if width is None:
        return await fetch_proxied_image(url)

    opt_key = f"{url}#w={width}&q={quality}&webp={int(prefer_webp)}"
    cached_opt = _cache_image_get(opt_key)
    if cached_opt is not None:
        return cached_opt

    raw_bytes, raw_mime = await fetch_proxied_image(url)
    out_bytes, out_mime = await asyncio.to_thread(
        _resize_and_encode_image,
        raw_bytes,
        raw_mime,
        width,
        quality,
        prefer_webp,
    )
    _cache_image_put(opt_key, out_bytes, out_mime)
    return out_bytes, out_mime


def _encode_b64_url(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_b64_url(encoded: str) -> str:
    pad = "=" * ((4 - len(encoded) % 4) % 4)
    return base64.urlsafe_b64decode((encoded + pad).encode("ascii")).decode("utf-8")


# ---------------- HINETTRUYEN (NETTRUYEN) ----------------
HINET_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": f"{HINET_BASE}/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
}

_SLUG_RE = re.compile(r"^[a-zA-Z0-9._-]{1,180}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_HINET_HOME_CACHE: tuple[float, HiNetHomeResponse] | None = None
_HINET_HOME_TTL = 600.0  # 10 minutes
_HINET_DETAIL_CACHE: dict[str, tuple[float, ComicDetail]] = {}
_HINET_DETAIL_TTL = 180.0
_HINET_LIST_CACHE: dict[tuple[str, str, int], tuple[float, list[ComicSummary]]] = {}
_HINET_LIST_TTL = 300.0  # 5 minutes
_HINET_CHAPTER_CACHE: dict[tuple[str, str], tuple[float, ChapterPagesResponse]] = {}
_HINET_CHAPTER_TTL = 600.0
_HINET_BLOCKED_UNTIL = 0.0
_HINET_BLOCKED_TTL = 600.0  # Skip repeated blocked probes from cloud IPs for 10 min

_MANGADEX_TAGS_CACHE: tuple[float, dict[str, str], list[GenreItem]] | None = None
_MANGADEX_TAGS_TTL = 3600.0
_MANGADEX_CHAPTER_LANG_CACHE: dict[str, str] = {}


_SEO_SENTENCE_MARKERS = (
    "nettruyen",
    "hinettruyen",
    "website của chúng tôi",
    "bộ truyện này thuộc về các thể loại",
    "đã thu hút hàng triệu độc giả",
    "tìm kiếm và đọc truyện tranh theo nhiều tiêu chí",
    "thưởng thức những giây phút giải trí tuyệt vời",
    "để trải nghiệm truyện tranh tốt nhất",
    "đăng ký tài khoản tại",
    "theo dõi những bộ truyện yêu thích, bình luận",
    "hãy đăng ký ngay hôm nay để khám phá",
    "cập nhật nhanh nhất",
)


def _clean_hinet_description(raw: str) -> str:
    if not raw:
        return ""
    text = re.sub(r"\s+", " ", raw).strip()
    parts = re.split(r"(?<=[.!?])\s+", text)
    kept: list[str] = []
    for part in parts:
        low = part.lower()
        if any(marker in low for marker in _SEO_SENTENCE_MARKERS):
            continue
        kept.append(part.strip())
    cleaned = " ".join(kept).strip()
    return cleaned or text


def _format_hinet_num(val) -> str:
    if val is None:
        return ""
    try:
        f = float(val)
        return str(int(f)) if f.is_integer() else str(f)
    except (ValueError, TypeError):
        return str(val).strip()


def _format_hinet_views(val) -> str:
    try:
        n = int(val)
        return f"{n:,}".replace(",", ".")
    except (ValueError, TypeError):
        return str(val or "")


def _format_hinet_date(raw: str | None) -> str:
    if not raw:
        return ""
    # Input like "2026-11-21 13:01:38" -> "21/11/2026"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw.strip())
    if m:
        return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
    return raw.strip()


def _normalize_hinet_img(raw: str | None) -> str:
    if not raw:
        return ""
    u = raw.strip()
    if u.startswith("//"):
        u = "https:" + u
    elif u.startswith("/"):
        u = HINET_BASE + u
    if not is_allowed_external_image_url(u):
        return ""
    return make_proxy_url(u)


def _extract_hinet_slug(href: str) -> str:
    if not href:
        return ""
    path = urlparse(href).path.strip("/")
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] == "truyen-tranh":
        return parts[1]
    return ""


def _extract_hinet_chapter_slug(href: str) -> str:
    if not href:
        return ""
    path = urlparse(href).path.strip("/")
    parts = path.split("/")
    if len(parts) >= 3 and parts[0] == "truyen-tranh":
        return parts[2]
    return ""


def _pick_img_attr(img_tag) -> str:
    if not img_tag:
        return ""
    for attr in ("data-original", "data-sv1", "data-src", "data-retries", "src"):
        val = img_tag.get(attr)
        if val and "thumb-default" not in str(val) and not str(val).startswith("data:"):
            return str(val).strip()
    return ""


def _parse_hinet_feed_items(soup: BeautifulSoup) -> list[ComicSummary]:
    results: list[ComicSummary] = []
    seen: set[str] = set()
    for item in soup.select(".items .row .item"):
        a = item.select_one("h3 a") or item.select_one(".image a")
        if not a:
            continue
        slug = _extract_hinet_slug(a.get("href", ""))
        if not slug or slug in seen:
            continue
        seen.add(slug)
        title = a.get_text(strip=True) or (a.get("title") or "").replace("Truyện tranh ", "").strip() or slug
        img_raw = _pick_img_attr(item.select_one("img"))
        ch_a = item.select_one("ul.comic-item li.chapter a")
        latest = ch_a.get_text(strip=True) if ch_a else ""
        results.append(
            ComicSummary(
                id=slug,
                source_type="hinettruyen",
                title=title,
                cover_url=_normalize_hinet_img(img_raw),
                latest_chapter=latest,
                language="vi",
            )
        )
    return results


def _parse_hinet_ranking(soup: BeautifulSoup, container_id: str) -> list[ComicSummary]:
    results: list[ComicSummary] = []
    for li in soup.select(f"#{container_id} li"):
        a = li.select_one("h3 a") or li.select_one("a.thumb")
        if not a:
            continue
        slug = _extract_hinet_slug(a.get("href", ""))
        if not slug:
            continue
        title = a.get_text(strip=True) or (a.get("title") or "").replace("Truyện tranh ", "").strip() or slug
        img_raw = _pick_img_attr(li.select_one("img"))
        ch_a = li.select_one("p.chapter a")
        latest = ch_a.get_text(strip=True) if ch_a else ""
        results.append(
            ComicSummary(
                id=slug,
                source_type="hinettruyen",
                title=title,
                cover_url=_normalize_hinet_img(img_raw),
                latest_chapter=latest,
                language="vi",
            )
        )
    return results[:7]


async def get_hinet_home() -> HiNetHomeResponse:
    global _HINET_HOME_CACHE, _HINET_BLOCKED_UNTIL
    now = time.monotonic()
    if _HINET_HOME_CACHE and (now - _HINET_HOME_CACHE[0]) < _HINET_HOME_TTL:
        return _HINET_HOME_CACHE[1]

    if now < _HINET_BLOCKED_UNTIL:
        try:
            result = await get_mangadex_vi_home()
            _HINET_HOME_CACHE = (now, result)
            return result
        except Exception:
            logger.exception("MangaDex Vietnamese fallback homepage failed")
            raise HTTPException(status_code=502, detail="Không kết nối được kho truyện.")

    html = ""
    try:
        client = get_shared_http_client()
        resp = await client.get(
            f"{HINET_BASE}/trang-chu",
            headers=HINET_HEADERS,
            follow_redirects=True,
            timeout=httpx.Timeout(7.0, connect=4.0),
        )
        resp.raise_for_status()
        html = resp.text
    except Exception as exc:
        logger.warning("HiNetTruyen homepage unavailable (%s); falling back to MangaDex Vietnamese", type(exc).__name__)
        _HINET_BLOCKED_UNTIL = now + _HINET_BLOCKED_TTL
        try:
            result = await get_mangadex_vi_home()
            _HINET_HOME_CACHE = (now, result)
            return result
        except Exception:
            logger.exception("Failed both HiNetTruyen and MangaDex Vietnamese home fallback")
            raise HTTPException(status_code=502, detail="Không kết nối được kho truyện hinettruyen.com.")

    soup = BeautifulSoup(html, "html.parser")

    # Featured carousel
    featured: list[ComicSummary] = []
    seen_feat: set[str] = set()
    for item in soup.select(".items-slide .item"):
        a = item.select_one("h3 a") or item.select_one("a")
        if not a:
            continue
        slug = _extract_hinet_slug(a.get("href", ""))
        if not slug or slug in seen_feat:
            continue
        seen_feat.add(slug)
        title = a.get_text(strip=True) or a.get("title") or slug
        img_raw = _pick_img_attr(item.select_one("img"))
        ch_a = item.select_one(".slide-caption > a")
        latest = ch_a.get_text(strip=True) if ch_a else ""
        featured.append(
            ComicSummary(
                id=slug,
                source_type="hinettruyen",
                title=title,
                cover_url=_normalize_hinet_img(img_raw),
                latest_chapter=latest,
                language="vi",
            )
        )

    latest = _parse_hinet_feed_items(soup)
    top_month = _parse_hinet_ranking(soup, "topMonth")
    top_week = _parse_hinet_ranking(soup, "topWeek")
    top_day = _parse_hinet_ranking(soup, "topDay")

    if not featured and not latest:
        logger.warning("HiNetTruyen homepage returned empty catalog; falling back to MangaDex Vietnamese")
        _HINET_BLOCKED_UNTIL = now + _HINET_BLOCKED_TTL
        try:
            result = await get_mangadex_vi_home()
            _HINET_HOME_CACHE = (now, result)
            return result
        except Exception:
            logger.exception("MangaDex Vietnamese fallback failed after empty HiNetTruyen response")
            raise HTTPException(status_code=502, detail="Không kết nối được kho truyện hinettruyen.com.")

    genres: list[GenreItem] = []
    seen_genres: set[str] = set()
    for g in soup.select("a[href*='/tim-truyen/']"):
        href = g.get("href", "")
        path = urlparse(href).path.strip("/")
        parts = path.split("/")
        if len(parts) == 2 and parts[0] == "tim-truyen" and _SLUG_RE.match(parts[1]):
            g_slug = parts[1]
            g_name = g.get_text(strip=True)
            if g_name and g_slug not in seen_genres:
                seen_genres.add(g_slug)
                genres.append(GenreItem(name=g_name, slug=g_slug))

    result = HiNetHomeResponse(
        featured=featured[:18],
        latest=latest[:36],
        top_month=top_month,
        top_week=top_week,
        top_day=top_day,
        genres=genres[:24],
    )
    _HINET_HOME_CACHE = (now, result)
    return result


async def list_hinet_comics(query: str = "", genre: str = "", page: int = 1) -> list[ComicSummary]:
    global _HINET_BLOCKED_UNTIL
    safe_page = max(1, min(page, 200))
    q_norm = query.strip()
    g_norm = genre.strip()
    is_md_uuid_genre = bool(g_norm and _UUID_RE.match(g_norm))
    if not q_norm and not g_norm and safe_page == 1:
        home = await get_hinet_home()
        return home.latest

    cache_key = (q_norm.lower(), g_norm.lower(), safe_page)
    now = time.monotonic()
    cached = _HINET_LIST_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _HINET_LIST_TTL:
        return cached[1]

    if now < _HINET_BLOCKED_UNTIL or is_md_uuid_genre:
        results = await list_mangadex_vi_comics(query=q_norm, genre=g_norm, page=safe_page)
        if len(_HINET_LIST_CACHE) > 100:
            _HINET_LIST_CACHE.clear()
        _HINET_LIST_CACHE[cache_key] = (now, results)
        return results

    params: dict[str, str | int] = {}
    if q_norm:
        url = f"{HINET_BASE}/tim-truyen"
        params["keyword"] = q_norm
        if safe_page > 1:
            params["page"] = safe_page
    elif g_norm:
        if not _SLUG_RE.match(g_norm):
            raise HTTPException(status_code=400, detail="Mã thể loại không hợp lệ.")
        url = f"{HINET_BASE}/tim-truyen/{g_norm}"
        if safe_page > 1:
            params["page"] = safe_page
    else:
        url = f"{HINET_BASE}/trang-chu"
        params["page"] = safe_page

    html = ""
    try:
        client = get_shared_http_client()
        resp = await client.get(
            url,
            params=params,
            headers=HINET_HEADERS,
            follow_redirects=True,
            timeout=httpx.Timeout(7.0, connect=4.0),
        )
        resp.raise_for_status()
        html = resp.text
    except Exception as exc:
        logger.warning("HiNetTruyen list unavailable (%s); falling back to MangaDex Vietnamese", type(exc).__name__)
        _HINET_BLOCKED_UNTIL = now + _HINET_BLOCKED_TTL
        results = await list_mangadex_vi_comics(query=q_norm, genre=g_norm, page=safe_page)
        if len(_HINET_LIST_CACHE) > 100:
            _HINET_LIST_CACHE.clear()
        _HINET_LIST_CACHE[cache_key] = (now, results)
        return results

    if "just a moment" in html[:2000].lower():
        logger.warning("HiNetTruyen returned challenge HTML; falling back to MangaDex Vietnamese")
        _HINET_BLOCKED_UNTIL = now + _HINET_BLOCKED_TTL
        results = await list_mangadex_vi_comics(query=q_norm, genre=g_norm, page=safe_page)
        if len(_HINET_LIST_CACHE) > 100:
            _HINET_LIST_CACHE.clear()
        _HINET_LIST_CACHE[cache_key] = (now, results)
        return results

    soup = BeautifulSoup(html, "html.parser")
    results = _parse_hinet_feed_items(soup)
    if len(_HINET_LIST_CACHE) > 100:
        _HINET_LIST_CACHE.clear()
    _HINET_LIST_CACHE[cache_key] = (now, results)
    return results


async def get_hinet_detail(slug: str) -> ComicDetail:
    if not _SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Mã truyện HiNetTruyen không hợp lệ.")

    now = time.monotonic()
    cached = _HINET_DETAIL_CACHE.get(slug)
    if cached and (now - cached[0]) < _HINET_DETAIL_TTL:
        return cached[1]

    try:
        client = get_shared_http_client()
        detail_task = client.get(f"{HINET_BASE}/truyen-tranh/{slug}", headers=HINET_HEADERS, follow_redirects=True)
        ch_api_task = client.get(
            f"{HINET_BASE}/Comic/Services/ComicService.asmx/ChapterList",
            params={"slug": slug},
            headers=HINET_HEADERS,
            follow_redirects=True,
        )
        detail_resp, ch_api_resp = await asyncio.gather(
            detail_task, ch_api_task, return_exceptions=True
        )
        if isinstance(detail_resp, Exception):
            raise detail_resp
        detail_resp.raise_for_status()
        html = detail_resp.text
    except Exception:
        logger.exception("Failed to fetch hinettruyen detail %s", slug)
        raise HTTPException(status_code=502, detail="Không tải được chi tiết truyện từ hinettruyen.com.")

    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.select_one("h1.title-detail")
    title = title_el.get_text(strip=True) if title_el else slug

    cover_raw = _pick_img_attr(soup.select_one(".detail-info .col-image img"))
    authors = [
        el.get_text(strip=True)
        for el in soup.select(".detail-info li.author p.col-xs-8 a, .detail-info li.author p.col-xs-8")
        if el.get_text(strip=True) and el.get_text(strip=True).lower() != "đang cập nhật"
    ][:3]
    authors = list(dict.fromkeys(authors))

    tags = [
        el.get_text(strip=True)
        for el in soup.select(".detail-info li.kind a")
        if el.get_text(strip=True)
    ][:12]

    desc_el = soup.select_one(".detail-content .shortened") or soup.select_one(".detail-content p")
    raw_desc = desc_el.get_text(" ", strip=True) if desc_el else ""
    description = _clean_hinet_description(raw_desc)

    status_el = soup.select_one(".detail-info li.status p.col-xs-8")
    comic_status = status_el.get_text(strip=True) if status_el else "Đang tiến hành"

    time_el = soup.select_one("time.small")
    updated_at = time_el.get_text(strip=True).strip("[]") if time_el else ""

    # Prefer full ChapterList JSON API (loads all 100-1000+ chapters!)
    chapters_desc: list[ChapterItem] = []
    seen_ch: set[str] = set()
    if not isinstance(ch_api_resp, Exception) and ch_api_resp.status_code == 200:
        try:
            api_payload = ch_api_resp.json()
            raw_items = api_payload.get("data") if isinstance(api_payload, dict) else api_payload
            if isinstance(raw_items, list):
                for item in raw_items:
                    if not isinstance(item, dict):
                        continue
                    num_str = _format_hinet_num(item.get("chapter_num"))
                    ch_slug = f"chuong-{num_str}" if num_str != "" else str(item.get("chapter_slug") or "").strip()
                    if not ch_slug or ch_slug in seen_ch or not _SLUG_RE.match(ch_slug):
                        continue
                    seen_ch.add(ch_slug)
                    ch_title = str(item.get("chapter_name") or f"Chapter {num_str}").strip()
                    chapters_desc.append(
                        ChapterItem(
                            id=ch_slug,
                            title=ch_title,
                            chapter_number=num_str,
                            page_count=int(item.get("image_num") or 0),
                            language="vi",
                            updated_at=_format_hinet_date(item.get("updated_at")),
                            views=_format_hinet_views(item.get("view")),
                        )
                    )
        except Exception:
            logger.warning("Failed to parse HiNetTruyen ChapterList JSON for %s; falling back to HTML", slug)

    # Fallback to HTML chapter list if JSON API returned empty
    if not chapters_desc:
        for li in soup.select("#chapter_list li.row, #nt_listchapter li.row"):
            a = li.select_one("a")
            if not a:
                continue
            ch_slug = _extract_hinet_chapter_slug(a.get("href", ""))
            if not ch_slug or ch_slug in seen_ch or not _SLUG_RE.match(ch_slug):
                continue
            seen_ch.add(ch_slug)
            ch_title = a.get_text(strip=True) or ch_slug
            num_match = re.search(r"(\d+(?:\.\d+)?)", ch_title)
            cols = li.select("div.small")
            ch_updated = cols[0].get_text(strip=True) if len(cols) >= 1 else ""
            ch_views = cols[1].get_text(strip=True) if len(cols) >= 2 else ""
            chapters_desc.append(
                ChapterItem(
                    id=ch_slug,
                    title=ch_title,
                    chapter_number=num_match.group(1) if num_match else "",
                    language="vi",
                    updated_at=ch_updated,
                    views=ch_views,
                )
            )

    # Reverse so Chapter 0/1 is first (natural reading & auto-next order)
    chapters = list(reversed(chapters_desc))

    result = ComicDetail(
        id=slug,
        source_type="hinettruyen",
        title=title,
        description=description,
        cover_url=_normalize_hinet_img(cover_raw),
        authors=authors,
        tags=tags,
        status=comic_status,
        updated_at=updated_at,
        chapters=chapters,
    )
    if len(_HINET_DETAIL_CACHE) > 200:
        _HINET_DETAIL_CACHE.clear()
    _HINET_DETAIL_CACHE[slug] = (now, result)
    return result


async def get_hinet_chapter_pages(slug: str, chapter_slug: str) -> ChapterPagesResponse:
    if not _SLUG_RE.match(slug) or not _SLUG_RE.match(chapter_slug):
        raise HTTPException(status_code=400, detail="Mã truyện hoặc chương không hợp lệ.")

    cache_key = (slug, chapter_slug)
    now = time.monotonic()
    cached = _HINET_CHAPTER_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _HINET_CHAPTER_TTL:
        return cached[1]

    try:
        client = get_shared_http_client()
        resp = await client.get(
            f"{HINET_BASE}/truyen-tranh/{slug}/{chapter_slug}",
            headers=HINET_HEADERS,
            follow_redirects=True,
        )
        resp.raise_for_status()
        html = resp.text
    except Exception:
        logger.exception("Failed to fetch hinettruyen chapter %s/%s", slug, chapter_slug)
        raise HTTPException(status_code=502, detail="Không tải được trang chương từ hinettruyen.com.")

    soup = BeautifulSoup(html, "html.parser")
    pages: list[str] = []
    for img in soup.select(".reading-detail .page-chapter img"):
        raw = _pick_img_attr(img)
        proxied = _normalize_hinet_img(raw)
        if proxied:
            pages.append(proxied)

    if not pages:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh trong chương này.")

    h1 = soup.select_one("h1.txt-primary span") or soup.select_one("h1.txt-primary")
    ch_title = h1.get_text(" ", strip=True).lstrip("- ") if h1 else chapter_slug

    prev_id: str | None = None
    next_id: str | None = None
    prev_a = soup.select_one("a.prev:not(.disabled)")
    if prev_a:
        cand = _extract_hinet_chapter_slug(prev_a.get("href", ""))
        if cand and _SLUG_RE.match(cand) and cand != chapter_slug:
            prev_id = cand
    next_a = soup.select_one("a.next:not(.disabled)")
    if next_a:
        cand = _extract_hinet_chapter_slug(next_a.get("href", ""))
        if cand and _SLUG_RE.match(cand) and cand != chapter_slug:
            next_id = cand

    result = ChapterPagesResponse(
        comic_id=slug,
        source_type="hinettruyen",
        chapter_id=chapter_slug,
        chapter_title=ch_title,
        pages=pages,
        prev_chapter_id=prev_id,
        next_chapter_id=next_id,
    )
    if len(_HINET_CHAPTER_CACHE) > 200:
        _HINET_CHAPTER_CACHE.clear()
    _HINET_CHAPTER_CACHE[cache_key] = (now, result)
    return result


# ---------------- OTRUYEN ----------------
async def list_otruyen_comics(query: str = "") -> list[ComicSummary]:
    url = f"{OTRUYEN_BASE}/tim-kiem" if query.strip() else f"{OTRUYEN_BASE}/home"
    params = {"keyword": query.strip()} if query.strip() else None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=5.0), headers=DEFAULT_HEADERS) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 404 and not query.strip():
                resp = await client.get(f"{OTRUYEN_BASE}/danh-sach/dang-phat-hanh", params={"page": 1})
            resp.raise_for_status()
            payload = resp.json()
    except Exception:
        logger.warning("OTruyen upstream unavailable; falling back to MangaDex Vietnamese catalog")
        return await list_mangadex_comics(query=query, only_vietnamese=True)

    data = payload.get("data", {})
    cdn = data.get("APP_DOMAIN_CDN_IMAGE", "https://img.otruyenapi.com").rstrip("/")
    items = data.get("items") or []
    results: list[ComicSummary] = []

    for item in items[:24]:
        slug = item.get("slug") or ""
        if not slug:
            continue
        thumb = item.get("thumb_url") or ""
        cover_raw = f"{cdn}/uploads/comics/{thumb}" if thumb and not thumb.startswith("http") else thumb
        latest = ""
        chapters_latest = item.get("chaptersLatest") or []
        if chapters_latest and isinstance(chapters_latest, list):
            ch_name = chapters_latest[0].get("chapter_name", "")
            latest = f"Chương {ch_name}" if ch_name else ""

        results.append(
            ComicSummary(
                id=slug,
                source_type="otruyen",
                title=item.get("name") or slug,
                cover_url=make_proxy_url(cover_raw) if cover_raw and is_allowed_external_image_url(cover_raw) else "",
                latest_chapter=latest,
                language="vi",
            )
        )
    return results


async def get_otruyen_detail(slug: str) -> ComicDetail:
    if not slug or "/" in slug or ".." in slug:
        raise HTTPException(status_code=400, detail="Mã truyện không hợp lệ.")
    url = f"{OTRUYEN_BASE}/truyen-tranh/{quote(slug, safe='')}"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, headers=DEFAULT_HEADERS) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            payload = resp.json()
    except Exception:
        logger.exception("Failed to fetch OTruyen detail for %s", slug)
        raise HTTPException(status_code=502, detail="Không tải được thông tin truyện từ OTruyen.")

    data = payload.get("data", {})
    item = data.get("item") or {}
    cdn = data.get("APP_DOMAIN_CDN_IMAGE", "https://img.otruyenapi.com").rstrip("/")
    thumb = item.get("thumb_url") or ""
    cover_raw = f"{cdn}/uploads/comics/{thumb}" if thumb and not thumb.startswith("http") else thumb

    chapters: list[ChapterItem] = []
    server_groups = item.get("chapters") or []
    if server_groups:
        server_data = server_groups[0].get("server_data") or []
        for ch in server_data:
            api_data = ch.get("chapter_api_data") or ""
            if not api_data or not is_allowed_otruyen_chapter_url(api_data):
                continue
            ch_num = str(ch.get("chapter_name") or "")
            ch_title = ch.get("chapter_title") or ""
            display_title = f"Chương {ch_num}" + (f": {ch_title}" if ch_title else "")
            chapters.append(
                ChapterItem(
                    id=_encode_b64_url(api_data),
                    title=display_title,
                    chapter_number=ch_num,
                    language="vi",
                )
            )

    raw_desc = item.get("content") or ""
    clean_desc = re.sub(r"<[^>]+>", " ", raw_desc).strip()

    tags = [c.get("name", "") for c in (item.get("category") or []) if c.get("name")]
    authors = [a for a in (item.get("author") or []) if a]

    return ComicDetail(
        id=slug,
        source_type="otruyen",
        title=item.get("name") or slug,
        description=clean_desc,
        cover_url=make_proxy_url(cover_raw) if cover_raw and is_allowed_external_image_url(cover_raw) else "",
        authors=authors,
        tags=tags,
        chapters=chapters,
    )


async def get_otruyen_chapter_pages(slug: str, encoded_chapter_id: str) -> ChapterPagesResponse:
    try:
        chapter_api_url = _decode_b64_url(encoded_chapter_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Mã chương OTruyen không hợp lệ.")

    ok, host = _check_url_host(
        chapter_api_url,
        ALLOWED_OTRUYEN_CHAPTER_HOSTS,
        ALLOWED_OTRUYEN_CHAPTER_SUFFIXES,
    )
    if not ok:
        raise HTTPException(status_code=403, detail="URL chương OTruyen không hợp lệ.")

    await asyncio.to_thread(_verify_public_dns, host)

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=False, headers=DEFAULT_HEADERS) as client:
            resp = await client.get(chapter_api_url)
            resp.raise_for_status()
            payload = resp.json()
    except Exception:
        logger.exception("Failed to fetch OTruyen chapter %s", slug)
        raise HTTPException(status_code=502, detail="Không tải được trang chương từ OTruyen.")

    data = payload.get("data", {})
    domain_cdn = (data.get("domain_cdn") or "https://sv1.otruyencdn.com").rstrip("/")
    item = data.get("item") or {}
    chapter_path = (item.get("chapter_path") or "").strip("/")
    images = item.get("chapter_image") or []

    pages: list[str] = []
    for img in images:
        img_file = img.get("image_file")
        if img_file:
            raw_img_url = f"{domain_cdn}/{chapter_path}/{img_file}"
            if is_allowed_external_image_url(raw_img_url):
                pages.append(make_proxy_url(raw_img_url))

    ch_num = item.get("chapter_name") or ""
    ch_title = f"Chương {ch_num}" if ch_num else "Chương truyện"

    prev_id, next_id = None, None
    try:
        detail = await get_otruyen_detail(slug)
        ids = [c.id for c in detail.chapters]
        if encoded_chapter_id in ids:
            idx = ids.index(encoded_chapter_id)
            if idx > 0:
                prev_id = ids[idx - 1]
            if idx + 1 < len(ids):
                next_id = ids[idx + 1]
    except Exception:
        pass

    return ChapterPagesResponse(
        comic_id=slug,
        source_type="otruyen",
        chapter_id=encoded_chapter_id,
        chapter_title=ch_title,
        pages=pages,
        prev_chapter_id=prev_id,
        next_chapter_id=next_id,
    )


# ---------------- MANGADEX ----------------
_HINET_TO_MD_TAG_NAMES: dict[str, str] = {
    "action-95": "action",
    "chuyen-sinh-2130": "isekai",
    "co-dai-207": "historical",
    "fantasy-105": "fantasy",
    "drama-103": "drama",
    "comedy-99": "comedy",
    "adventure": "adventure",
    "dam-my": "boys' love",
    "romance": "romance",
    "slice-of-life": "slice of life",
    "isekai": "isekai",
}

_CURATED_MD_GENRES: tuple[tuple[str, str], ...] = (
    ("action", "Action"),
    ("isekai", "Chuyển Sinh"),
    ("fantasy", "Fantasy"),
    ("comedy", "Comedy"),
    ("romance", "Ngôn Tình"),
    ("drama", "Drama"),
    ("adventure", "Adventure"),
    ("historical", "Cổ Đại"),
    ("slice of life", "Đời Thường"),
    ("martial arts", "Võ Thuật"),
    ("school life", "Học Đường"),
    ("mystery", "Trinh Thám"),
)


def _cache_mangadex_chapter_lang(chapter_id: str, lang: str) -> None:
    if not chapter_id or not lang:
        return
    if len(_MANGADEX_CHAPTER_LANG_CACHE) >= 1000:
        _MANGADEX_CHAPTER_LANG_CACHE.clear()
    _MANGADEX_CHAPTER_LANG_CACHE[chapter_id] = lang.strip().lower()


def _pick_localized(mapping: dict | None, fallback: str = "") -> str:
    if not mapping or not isinstance(mapping, dict):
        return fallback
    for lang in ("vi", "en", "ja-ro", "ja", "ko"):
        if mapping.get(lang):
            return str(mapping[lang])
    for v in mapping.values():
        if v:
            return str(v)
    return fallback


async def _get_mangadex_tags() -> tuple[dict[str, str], list[GenreItem]]:
    global _MANGADEX_TAGS_CACHE
    now = time.monotonic()
    if _MANGADEX_TAGS_CACHE and (now - _MANGADEX_TAGS_CACHE[0]) < _MANGADEX_TAGS_TTL:
        return _MANGADEX_TAGS_CACHE[1], _MANGADEX_TAGS_CACHE[2]

    client = get_shared_http_client()
    resp = await client.get(f"{MANGADEX_BASE}/manga/tag", headers=DEFAULT_HEADERS)
    resp.raise_for_status()
    payload = resp.json()

    name_to_id: dict[str, str] = {}
    for item in payload.get("data") or []:
        tid = item.get("id") or ""
        name = _pick_localized((item.get("attributes") or {}).get("name"), "").strip().lower()
        if tid and name:
            name_to_id[name] = tid

    genres: list[GenreItem] = []
    for tag_key, label in _CURATED_MD_GENRES:
        tid = name_to_id.get(tag_key)
        if tid:
            genres.append(GenreItem(name=label, slug=tid))

    _MANGADEX_TAGS_CACHE = (now, name_to_id, genres)
    return name_to_id, genres


def _parse_mangadex_summaries(items: list[dict], vietnamese_mode: bool = False) -> list[ComicSummary]:
    results: list[ComicSummary] = []
    for item in items:
        manga_id = item.get("id", "")
        if not manga_id:
            continue
        attrs = item.get("attributes") or {}
        title = _pick_localized(attrs.get("title"), manga_id)
        desc = _pick_localized(attrs.get("description"), "")
        orig_lang = attrs.get("originalLanguage") or "ja"
        last_ch = str(attrs.get("lastChapter") or "").strip()

        cover_file = ""
        for rel in item.get("relationships") or []:
            if rel.get("type") == "cover_art":
                cover_file = (rel.get("attributes") or {}).get("fileName") or ""
                break
        cover_raw = f"https://uploads.mangadex.org/covers/{manga_id}/{cover_file}.256.jpg" if cover_file else ""

        if vietnamese_mode:
            latest_label = f"Ch. {last_ch}" if last_ch else "Tiếng Việt"
            lang = "vi"
        else:
            latest_label = f"Gốc: {orig_lang.upper()}"
            lang = orig_lang

        results.append(
            ComicSummary(
                id=manga_id,
                source_type="mangadex",
                title=title,
                description=desc[:200],
                cover_url=make_proxy_url(cover_raw) if cover_raw else "",
                latest_chapter=latest_label,
                language=lang,
            )
        )
    return results


async def get_mangadex_vi_home() -> HiNetHomeResponse:
    client = get_shared_http_client()
    latest_params: list[tuple[str, str]] = [
        ("limit", "36"),
        ("includes[]", "cover_art"),
        ("availableTranslatedLanguage[]", "vi"),
        ("hasAvailableChapters", "true"),
        ("contentRating[]", "safe"),
        ("contentRating[]", "suggestive"),
        ("order[latestUploadedChapter]", "desc"),
    ]
    popular_params: list[tuple[str, str]] = [
        ("limit", "18"),
        ("includes[]", "cover_art"),
        ("availableTranslatedLanguage[]", "vi"),
        ("hasAvailableChapters", "true"),
        ("contentRating[]", "safe"),
        ("contentRating[]", "suggestive"),
        ("order[followedCount]", "desc"),
    ]

    latest_resp, popular_resp, tags_res = await asyncio.gather(
        client.get(f"{MANGADEX_BASE}/manga", params=latest_params, headers=DEFAULT_HEADERS),
        client.get(f"{MANGADEX_BASE}/manga", params=popular_params, headers=DEFAULT_HEADERS),
        _get_mangadex_tags(),
        return_exceptions=True,
    )

    if isinstance(latest_resp, Exception):
        raise latest_resp
    latest_resp.raise_for_status()
    latest_items = latest_resp.json().get("data") or []
    latest = _parse_mangadex_summaries(latest_items, vietnamese_mode=True)

    popular: list[ComicSummary] = []
    if not isinstance(popular_resp, Exception) and popular_resp.status_code == 200:
        popular_items = popular_resp.json().get("data") or []
        popular = _parse_mangadex_summaries(popular_items, vietnamese_mode=True)
    if not popular:
        popular = latest[:18]

    genres: list[GenreItem] = []
    if not isinstance(tags_res, Exception) and isinstance(tags_res, tuple):
        genres = tags_res[1]

    return HiNetHomeResponse(
        featured=popular[:18],
        latest=latest[:36],
        top_month=popular[:7],
        top_week=popular[7:14] or popular[:7],
        top_day=latest[:7],
        genres=genres[:16],
    )


async def list_mangadex_vi_comics(query: str = "", genre: str = "", page: int = 1) -> list[ComicSummary]:
    offset = (max(1, page) - 1) * 24
    params: list[tuple[str, str]] = [
        ("limit", "24"),
        ("offset", str(offset)),
        ("includes[]", "cover_art"),
        ("availableTranslatedLanguage[]", "vi"),
        ("hasAvailableChapters", "true"),
        ("contentRating[]", "safe"),
        ("contentRating[]", "suggestive"),
    ]
    if query.strip():
        params.append(("title", query.strip()))
        params.append(("order[relevance]", "desc"))
    else:
        params.append(("order[latestUploadedChapter]", "desc"))

    g_norm = genre.strip()
    if g_norm:
        tag_uuid = ""
        if _UUID_RE.match(g_norm):
            tag_uuid = g_norm
        else:
            try:
                tag_map, _ = await _get_mangadex_tags()
                tag_name = _HINET_TO_MD_TAG_NAMES.get(g_norm.lower(), g_norm.replace("-", " ").lower())
                tag_uuid = tag_map.get(tag_name, "")
            except Exception:
                tag_uuid = ""
        if tag_uuid:
            params.append(("includedTags[]", tag_uuid))

    try:
        client = get_shared_http_client()
        resp = await client.get(f"{MANGADEX_BASE}/manga", params=params, headers=DEFAULT_HEADERS)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        logger.exception("Failed to fetch MangaDex Vietnamese list")
        raise HTTPException(status_code=502, detail="Không kết nối được nguồn truyện MangaDex.")

    return _parse_mangadex_summaries(payload.get("data") or [], vietnamese_mode=True)


async def get_mangadex_chapter_language(chapter_id: str) -> str:
    if not chapter_id:
        return "vi"
    cached = _MANGADEX_CHAPTER_LANG_CACHE.get(chapter_id)
    if cached:
        return cached
    try:
        client = get_shared_http_client()
        resp = await client.get(f"{MANGADEX_BASE}/chapter/{quote(chapter_id, safe='')}", headers=DEFAULT_HEADERS)
        resp.raise_for_status()
        attrs = ((resp.json().get("data") or {}).get("attributes") or {})
        lang = str(attrs.get("translatedLanguage") or "vi").strip().lower()
        _cache_mangadex_chapter_lang(chapter_id, lang)
        return lang
    except Exception:
        return "vi"


async def list_mangadex_comics(query: str = "", only_vietnamese: bool = False) -> list[ComicSummary]:
    params: list[tuple[str, str]] = [
        ("limit", "20"),
        ("includes[]", "cover_art"),
        ("hasAvailableChapters", "true"),
        ("contentRating[]", "safe"),
        ("contentRating[]", "suggestive"),
        ("order[followedCount]", "desc"),
    ]
    if only_vietnamese:
        params.append(("availableTranslatedLanguage[]", "vi"))
    if query.strip():
        params.append(("title", query.strip()))

    try:
        client = get_shared_http_client()
        resp = await client.get(f"{MANGADEX_BASE}/manga", params=params, headers=DEFAULT_HEADERS)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        logger.exception("Failed to fetch MangaDex list")
        raise HTTPException(status_code=502, detail="Không kết nối được nguồn MangaDex.")

    return _parse_mangadex_summaries(payload.get("data") or [], vietnamese_mode=only_vietnamese)


def _extract_mangadex_chapters(feed_data: list[dict]) -> list[ChapterItem]:
    seen_ch: dict[str, ChapterItem] = {}
    lang_rank = {"vi": 0, "en": 1, "ja": 2}
    for ch in feed_data:
        ch_id = ch.get("id", "")
        c_attrs = ch.get("attributes") or {}
        if c_attrs.get("externalUrl"):
            continue
        ch_num = str(c_attrs.get("chapter") or "0")
        c_lang = str(c_attrs.get("translatedLanguage") or "en").strip().lower()
        c_title = c_attrs.get("title") or ""
        pages_cnt = int(c_attrs.get("pages") or 0)
        if pages_cnt == 0 or not ch_id:
            continue
        _cache_mangadex_chapter_lang(ch_id, c_lang)
        label = f"Ch. {ch_num}" + (f": {c_title}" if c_title else "") + f" [{c_lang.upper()}]"
        item = ChapterItem(
            id=ch_id,
            title=label,
            chapter_number=ch_num,
            page_count=pages_cnt,
            language=c_lang,
        )
        if ch_num not in seen_ch:
            seen_ch[ch_num] = item
        else:
            prev_rank = lang_rank.get(seen_ch[ch_num].language, 9)
            curr_rank = lang_rank.get(c_lang, 9)
            if curr_rank < prev_rank:
                seen_ch[ch_num] = item

    def _ch_sort(c: ChapterItem) -> float:
        try:
            return float(c.chapter_number)
        except ValueError:
            return 999999.0

    return sorted(seen_ch.values(), key=_ch_sort)


async def get_mangadex_detail(manga_id: str) -> ComicDetail:
    try:
        client = get_shared_http_client()
        detail_resp, vi_feed_resp = await asyncio.gather(
            client.get(
                f"{MANGADEX_BASE}/manga/{quote(manga_id, safe='')}",
                params=[("includes[]", "cover_art"), ("includes[]", "author")],
                headers=DEFAULT_HEADERS,
            ),
            client.get(
                f"{MANGADEX_BASE}/manga/{quote(manga_id, safe='')}/feed",
                params=[
                    ("limit", "500"),
                    ("order[chapter]", "asc"),
                    ("translatedLanguage[]", "vi"),
                    ("includeExternalUrl", "0"),
                    ("includeEmptyPages", "0"),
                    ("contentRating[]", "safe"),
                    ("contentRating[]", "suggestive"),
                ],
                headers=DEFAULT_HEADERS,
            ),
        )
        detail_resp.raise_for_status()
        vi_feed_resp.raise_for_status()
        detail_data = detail_resp.json().get("data") or {}
        vi_feed_data = vi_feed_resp.json().get("data") or []
        chapters = _extract_mangadex_chapters(vi_feed_data)

        if not chapters:
            fallback_feed_resp = await client.get(
                f"{MANGADEX_BASE}/manga/{quote(manga_id, safe='')}/feed",
                params=[
                    ("limit", "200"),
                    ("order[chapter]", "asc"),
                    ("translatedLanguage[]", "en"),
                    ("translatedLanguage[]", "ja"),
                    ("includeExternalUrl", "0"),
                    ("includeEmptyPages", "0"),
                    ("contentRating[]", "safe"),
                    ("contentRating[]", "suggestive"),
                ],
                headers=DEFAULT_HEADERS,
            )
            fallback_feed_resp.raise_for_status()
            chapters = _extract_mangadex_chapters(fallback_feed_resp.json().get("data") or [])
    except Exception:
        logger.exception("Failed to fetch MangaDex detail for %s", manga_id)
        raise HTTPException(status_code=502, detail="Không tải được truyện từ MangaDex.")

    attrs = detail_data.get("attributes") or {}
    title = _pick_localized(attrs.get("title"), manga_id)
    desc = _pick_localized(attrs.get("description"), "")

    cover_file = ""
    authors: list[str] = []
    for rel in detail_data.get("relationships") or []:
        if rel.get("type") == "cover_art":
            cover_file = (rel.get("attributes") or {}).get("fileName") or ""
        elif rel.get("type") == "author":
            name = (rel.get("attributes") or {}).get("name")
            if name:
                authors.append(name)

    cover_raw = f"https://uploads.mangadex.org/covers/{manga_id}/{cover_file}.512.jpg" if cover_file else ""
    tags = [_pick_localized((t.get("attributes") or {}).get("name")) for t in (attrs.get("tags") or [])]

    return ComicDetail(
        id=manga_id,
        source_type="mangadex",
        title=title,
        description=desc,
        cover_url=make_proxy_url(cover_raw) if cover_raw else "",
        authors=authors,
        tags=[t for t in tags if t][:10],
        chapters=chapters,
    )


async def get_mangadex_chapter_pages(manga_id: str, chapter_id: str) -> ChapterPagesResponse:
    try:
        client = get_shared_http_client()
        resp = await client.get(
            f"{MANGADEX_BASE}/at-home/server/{quote(chapter_id, safe='')}",
            headers=DEFAULT_HEADERS,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        logger.exception("Failed to fetch MangaDex chapter %s", chapter_id)
        raise HTTPException(status_code=502, detail="Không tải được trang chương từ MangaDex.")

    base_url = (payload.get("baseUrl") or "").rstrip("/")
    ch_obj = payload.get("chapter") or {}
    ch_hash = ch_obj.get("hash") or ""
    data_saver = ch_obj.get("dataSaver") or ch_obj.get("data") or []
    quality_path = "data-saver" if ch_obj.get("dataSaver") else "data"

    pages: list[str] = []
    for fname in data_saver:
        if base_url and ch_hash:
            raw_url = f"{base_url}/{quality_path}/{ch_hash}/{fname}"
            if is_allowed_external_image_url(raw_url):
                pages.append(make_proxy_url(raw_url))

    ch_title = f"Chương {chapter_id[:6]}"
    prev_id, next_id = None, None
    try:
        detail = await get_mangadex_detail(manga_id)
        ids = [c.id for c in detail.chapters]
        if chapter_id in ids:
            idx = ids.index(chapter_id)
            ch_title = detail.chapters[idx].title
            if idx > 0:
                prev_id = ids[idx - 1]
            if idx + 1 < len(ids):
                next_id = ids[idx + 1]
    except Exception:
        pass

    return ChapterPagesResponse(
        comic_id=manga_id,
        source_type="mangadex",
        chapter_id=chapter_id,
        chapter_title=ch_title,
        pages=pages,
        prev_chapter_id=prev_id,
        next_chapter_id=next_id,
    )
