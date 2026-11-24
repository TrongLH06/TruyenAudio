import io
import logging
import re
import shutil
import uuid
import zipfile
from pathlib import Path

import pymupdf
from fastapi import HTTPException, UploadFile
from PIL import Image

logger = logging.getLogger(__name__)

# Protect against decompression pixel bombs
Image.MAX_IMAGE_PIXELS = 25_000_000

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
MAX_PAGES_PER_CHAPTER = 200
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024  # 200 MB across entire request
MAX_SINGLE_ENTRY_BYTES = 20 * 1024 * 1024   # 20 MB per archive image
MAX_UPLOAD_BYTES = 120 * 1024 * 1024        # 120 MB raw upload total
MAX_PDF_RENDER_DIM = 2200                   # cap PDF render pixel dimension


def _natural_sort_key(text: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


async def _read_upload_bounded(upload: UploadFile, current_total: int) -> tuple[bytes, int]:
    chunks: list[bytes] = []
    total = current_total
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Tổng dung lượng tải lên vượt quá giới hạn 120MB.")
        chunks.append(chunk)
    return b"".join(chunks), total


def _save_validated_image(raw_bytes: bytes, dest_path: Path) -> None:
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            img.verify()
        with Image.open(io.BytesIO(raw_bytes)) as img:
            if img.mode in ("RGBA", "P", "LA"):
                bg = Image.new("RGB", img.size, (15, 17, 23))
                rgba = img.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
                rgb = bg
            else:
                rgb = img.convert("RGB")
            max_w = 1400
            if rgb.width > max_w:
                ratio = max_w / rgb.width
                rgb = rgb.resize((max_w, max(1, int(rgb.height * ratio))), Image.Resampling.LANCZOS)
            rgb.save(dest_path, format="JPEG", quality=88, optimize=True)
    except Image.DecompressionBombError:
        raise HTTPException(status_code=400, detail="Ảnh có độ phân giải quá lớn vượt ngưỡng an toàn.")
    except HTTPException:
        raise
    except Exception:
        logger.warning("Invalid uploaded image rejected")
        raise HTTPException(status_code=400, detail="Tệp ảnh không hợp lệ hoặc bị hỏng.")


def _read_zip_member_bounded(zf: zipfile.ZipFile, info: zipfile.ZipInfo, running_total: int) -> tuple[bytes, int]:
    chunks: list[bytes] = []
    entry_read = 0
    total = running_total
    with zf.open(info, "r") as stream:
        while True:
            chunk = stream.read(256 * 1024)
            if not chunk:
                break
            entry_read += len(chunk)
            total += len(chunk)
            if entry_read > MAX_SINGLE_ENTRY_BYTES or total > MAX_UNCOMPRESSED_BYTES:
                raise HTTPException(status_code=413, detail="Dung lượng giải nén vượt quá giới hạn an toàn.")
            chunks.append(chunk)
    return b"".join(chunks), total


async def process_uploaded_chapter(
    files: list[UploadFile],
    comic_dir: Path,
    chapter_id: str,
) -> list[str]:
    if not files:
        raise HTTPException(status_code=400, detail="Vui lòng chọn ít nhất một tệp ảnh, ZIP, CBZ hoặc PDF.")

    chapter_dir = comic_dir / chapter_id
    chapter_dir.mkdir(parents=True, exist_ok=True)
    comic_folder_name = comic_dir.name

    # Sort multiple loose image uploads naturally before streaming to disk
    sorted_files = sorted(files, key=lambda f: _natural_sort_key(f.filename or "file"))

    rel_urls: list[str] = []
    total_raw_read = 0
    total_uncompressed = 0

    def _emit_page(img_bytes: bytes) -> None:
        if len(rel_urls) >= MAX_PAGES_PER_CHAPTER:
            return
        idx = len(rel_urls) + 1
        out_name = f"{idx:04d}.jpg"
        out_path = chapter_dir / out_name
        _save_validated_image(img_bytes, out_path)
        rel_urls.append(f"/storage/uploads/{comic_folder_name}/{chapter_id}/{out_name}")

    try:
        for upload in sorted_files:
            if len(rel_urls) >= MAX_PAGES_PER_CHAPTER:
                break
            filename = (upload.filename or "file").strip()
            ext = Path(filename).suffix.lower()
            data, total_raw_read = await _read_upload_bounded(upload, total_raw_read)

            if ext in (".zip", ".cbz"):
                try:
                    zf = zipfile.ZipFile(io.BytesIO(data))
                except zipfile.BadZipFile:
                    raise HTTPException(status_code=400, detail="Tệp nén ZIP/CBZ không hợp lệ.")

                with zf:
                    members: list[zipfile.ZipInfo] = []
                    for info in zf.infolist():
                        if info.is_dir():
                            continue
                        norm_name = info.filename.replace("\\", "/")
                        if "__MACOSX" in norm_name or norm_name.startswith("/") or ".." in norm_name.split("/"):
                            continue
                        base_name = Path(norm_name).name
                        if base_name.startswith("."):
                            continue
                        if Path(base_name).suffix.lower() not in ALLOWED_IMAGE_EXTS:
                            continue
                        members.append(info)

                    members.sort(key=lambda m: _natural_sort_key(m.filename))
                    for info in members:
                        if len(rel_urls) >= MAX_PAGES_PER_CHAPTER:
                            break
                        entry_bytes, total_uncompressed = _read_zip_member_bounded(zf, info, total_uncompressed)
                        _emit_page(entry_bytes)

            elif ext == ".pdf":
                try:
                    doc = pymupdf.open(stream=data, filetype="pdf")
                except Exception:
                    raise HTTPException(status_code=400, detail="Không thể đọc tệp PDF.")

                with doc:
                    if len(doc) > MAX_PAGES_PER_CHAPTER:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Tệp PDF có quá nhiều trang (tối đa {MAX_PAGES_PER_CHAPTER} trang/chương).",
                        )
                    for page in doc:
                        if len(rel_urls) >= MAX_PAGES_PER_CHAPTER:
                            break
                        rect = page.rect
                        max_side = max(rect.width, rect.height, 1.0)
                        scale = min(1.6, MAX_PDF_RENDER_DIM / max_side)
                        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                        _emit_page(pix.tobytes("jpeg"))

            elif ext in ALLOWED_IMAGE_EXTS:
                _emit_page(data)
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Định dạng tệp chưa hỗ trợ. Vui lòng dùng ảnh (JPG/PNG/WEBP), ZIP, CBZ hoặc PDF.",
                )

        if not rel_urls:
            raise HTTPException(status_code=400, detail="Không tìm thấy trang ảnh hợp lệ nào trong tệp tải lên.")

        return rel_urls
    except Exception:
        shutil.rmtree(chapter_dir, ignore_errors=True)
        raise


def create_new_comic_id() -> str:
    return uuid.uuid4().hex[:16]
