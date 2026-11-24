from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import threading
import unicodedata

import numpy as np
import onnxruntime as ort
from PIL import Image
from rapidocr import EngineType, LangDet, ModelType, OCRVersion, RapidOCR

from ..config import settings

logger = logging.getLogger(__name__)

_OCR_LOCK = threading.Lock()
_DET_ENGINE: RapidOCR | None = None
_FOREIGN_OCR_ENGINE: RapidOCR | None = None
_VIETOCR_ONNX: tuple[ort.InferenceSession, ort.InferenceSession, _VietOcrVocab, dict] | None = None

_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
_VIET_DIACRITICS = set(
    "àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ"
    "ÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ"
)
_NOISE_PATTERNS = (
    "http://",
    "https://",
    "www.",
    ".com",
    ".vn",
    ".net",
    "hinettruyen",
    "nettruyen",
    "truyenqq",
    "momo",
    "vietqr",
    "donate",
    "theo dõi",
    "đăng ký",
    "facebook",
    "discord",
)
_CHAPTER_BANNER_RE = re.compile(r"^(?:chap(?:ter)?|chương)\s*\d+[\s.:-]*$", re.IGNORECASE)
_PUNCT_ONLY_RE = re.compile(r"^[\W\d_]+$", re.UNICODE)


@dataclass
class _OcrBox:
    x1: int
    y1: int
    x2: int
    y2: int
    text: str = ""

    @property
    def width(self) -> int:
        return max(1, self.x2 - self.x1)

    @property
    def height(self) -> int:
        return max(1, self.y2 - self.y1)

    @property
    def y_center(self) -> float:
        return (self.y1 + self.y2) * 0.5

    @property
    def x_center(self) -> float:
        return (self.x1 + self.x2) * 0.5


class _VietOcrVocab:
    """Minimal character vocabulary matching VietOCR token indices."""

    def __init__(self, chars: str) -> None:
        self.pad = 0
        self.go = 1
        self.eos = 2
        self.mask_token = 3
        self.i2c = {i + 4: c for i, c in enumerate(chars)}
        self.i2c[0] = "<pad>"
        self.i2c[1] = "<sos>"
        self.i2c[2] = "<eos>"
        self.i2c[3] = "*"

    def decode(self, ids: list[int]) -> str:
        first = 1 if self.go in ids else 0
        last = ids.index(self.eos) if self.eos in ids else None
        return "".join(self.i2c.get(i, "") for i in ids[first:last])

    def batch_decode(self, arr: list[list[int]]) -> list[str]:
        return [self.decode(ids) for ids in arr]


def _get_num_threads() -> int:
    try:
        return max(1, int(os.environ.get("OCR_NUM_THREADS", "2")))
    except ValueError:
        return 2


def _build_ort_session_options() -> ort.SessionOptions:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = _get_num_threads()
    opts.inter_op_num_threads = 1
    opts.enable_mem_pattern = False
    opts.enable_cpu_mem_arena = False
    return opts


def _models_dir() -> Path:
    return settings.ocr_models_path


def _get_det_engine() -> RapidOCR:
    """Lazy thread-safe text detector (4.6MB ONNX mobile model)."""
    global _DET_ENGINE
    if _DET_ENGINE is not None:
        return _DET_ENGINE
    with _OCR_LOCK:
        if _DET_ENGINE is None:
            _DET_ENGINE = RapidOCR(
                params={
                    "Global.use_det": True,
                    "Global.use_cls": False,
                    "Global.use_rec": False,
                    "EngineConfig.onnxruntime.intra_op_num_threads": _get_num_threads(),
                    "EngineConfig.onnxruntime.inter_op_num_threads": 1,
                    "EngineConfig.onnxruntime.enable_cpu_mem_arena": False,
                    "Det.engine_type": EngineType.ONNXRUNTIME,
                    "Det.ocr_version": OCRVersion.PPOCRV5,
                    "Det.lang_type": LangDet.CH,
                    "Det.model_type": ModelType.MOBILE,
                    "Det.limit_side_len": 1600,
                    "Det.limit_type": "max",
                }
            )
    return _DET_ENGINE


def _get_foreign_ocr_engine() -> RapidOCR:
    """Lazy thread-safe multilingual detector + recognizer for English/Japanese/Korean panels."""
    global _FOREIGN_OCR_ENGINE
    if _FOREIGN_OCR_ENGINE is not None:
        return _FOREIGN_OCR_ENGINE
    with _OCR_LOCK:
        if _FOREIGN_OCR_ENGINE is None:
            _FOREIGN_OCR_ENGINE = RapidOCR(
                params={
                    "Global.use_cls": False,
                    "EngineConfig.onnxruntime.intra_op_num_threads": _get_num_threads(),
                    "EngineConfig.onnxruntime.inter_op_num_threads": 1,
                    "EngineConfig.onnxruntime.enable_cpu_mem_arena": False,
                    "Det.engine_type": EngineType.ONNXRUNTIME,
                    "Det.ocr_version": OCRVersion.PPOCRV6,
                    "Det.model_type": ModelType.SMALL,
                    "Det.limit_side_len": 1600,
                    "Det.limit_type": "max",
                    "Rec.engine_type": EngineType.ONNXRUNTIME,
                    "Rec.ocr_version": OCRVersion.PPOCRV6,
                    "Rec.model_type": ModelType.SMALL,
                }
            )
    return _FOREIGN_OCR_ENGINE


def _get_vietocr_onnx() -> tuple[ort.InferenceSession, ort.InferenceSession, _VietOcrVocab, dict]:
    """Lazy thread-safe VietOCR vgg_seq2seq ONNX Runtime sessions on CPU."""
    global _VIETOCR_ONNX
    if _VIETOCR_ONNX is not None:
        return _VIETOCR_ONNX
    with _OCR_LOCK:
        if _VIETOCR_ONNX is None:
            model_dir = _models_dir()
            cfg_path = model_dir / "vietocr_config.json"
            enc_path = model_dir / "vietocr_encoder.onnx"
            dec_path = model_dir / "vietocr_decoder.onnx"
            for required in (cfg_path, enc_path, dec_path):
                if not required.is_file():
                    raise FileNotFoundError(f"Thiếu file model VietOCR ONNX: {required}")

            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            vocab = _VietOcrVocab(cfg["vocab"])
            opts = _build_ort_session_options()
            enc_sess = ort.InferenceSession(
                str(enc_path),
                sess_options=opts,
                providers=["CPUExecutionProvider"],
            )
            dec_sess = ort.InferenceSession(
                str(dec_path),
                sess_options=opts,
                providers=["CPUExecutionProvider"],
            )
            _VIETOCR_ONNX = (enc_sess, dec_sess, vocab, cfg)
    return _VIETOCR_ONNX


def _process_crop_numpy(crop: Image.Image, h: int, min_w: int, max_w: int) -> np.ndarray:
    rgb = crop.convert("RGB")
    orig_w, orig_h = rgb.size
    new_w = int(h * float(orig_w) / float(max(1, orig_h)))
    new_w = math.ceil(new_w / 10) * 10
    new_w = max(min_w, min(max_w, new_w))
    resized = rgb.resize((new_w, h), Image.Resampling.LANCZOS)
    return np.asarray(resized, dtype=np.float32).transpose(2, 0, 1) / 255.0


def _translate_batch_onnx(
    batch_np: np.ndarray,
    enc_sess: ort.InferenceSession,
    dec_sess: ort.InferenceSession,
    max_seq_length: int = 128,
    sos_token: int = 1,
    eos_token: int = 2,
) -> list[list[int]]:
    enc_out, hidden = enc_sess.run(None, {"img": batch_np})
    bsz = batch_np.shape[0]
    tgt = np.full((bsz,), sos_token, dtype=np.int64)
    tokens = np.zeros((bsz, max_seq_length + 1), dtype=np.int64)
    tokens[:, 0] = sos_token
    finished = np.zeros((bsz,), dtype=bool)
    seq_len = 1

    for step in range(max_seq_length):
        logits, hidden = dec_sess.run(
            None,
            {
                "tgt": tgt,
                "hidden": hidden,
                "encoder_outputs": enc_out,
            },
        )
        nxt = np.argmax(logits, axis=-1).astype(np.int64)
        tokens[:, step + 1] = nxt
        seq_len = step + 2
        finished |= nxt == eos_token
        if bool(np.all(finished)):
            break
        tgt = nxt

    return tokens[:, :seq_len].tolist()


def _predict_lines_batch(crops: list[Image.Image]) -> list[str]:
    if not crops:
        return []
    enc_sess, dec_sess, vocab, cfg = _get_vietocr_onnx()
    h = int(cfg["image_height"])
    min_w = int(cfg["image_min_width"])
    max_w = int(cfg["image_max_width"])
    sos = int(cfg.get("sos_token", 1))
    eos = int(cfg.get("eos_token", 2))

    bucket: dict[int, list[np.ndarray]] = defaultdict(list)
    bucket_idx: dict[int, list[int]] = defaultdict(list)
    outputs = [""] * len(crops)

    for idx, crop in enumerate(crops):
        arr = _process_crop_numpy(crop, h, min_w, max_w)
        width_key = int(arr.shape[-1])
        bucket[width_key].append(arr)
        bucket_idx[width_key].append(idx)

    for width_key, arrs in bucket.items():
        orig_indices = bucket_idx[width_key]
        for start in range(0, len(arrs), 8):
            batch = np.stack(arrs[start : start + 8], axis=0)
            sent_ids = _translate_batch_onnx(
                batch,
                enc_sess,
                dec_sess,
                max_seq_length=128,
                sos_token=sos,
                eos_token=eos,
            )
            decoded = vocab.batch_decode(sent_ids)
            for orig_idx, text in zip(orig_indices[start : start + 8], decoded):
                outputs[orig_idx] = (text or "").strip()
    return outputs


def _deduplicate_seam_boxes(boxes: list[_OcrBox]) -> list[_OcrBox]:
    dedup: list[_OcrBox] = []
    for box in sorted(boxes, key=lambda b: (b.y_center, b.x1)):
        is_dup = False
        for existing in dedup:
            inter_w = max(0, min(box.x2, existing.x2) - max(box.x1, existing.x1))
            min_w = min(box.width, existing.width)
            if abs(box.y_center - existing.y_center) < 22 and inter_w / min_w > 0.6:
                is_dup = True
                break
        if not is_dup:
            dedup.append(box)
    return dedup


def _clean_ocr_line(raw: str) -> str:
    txt = unicodedata.normalize("NFC", raw or "").strip()
    # Clean stray leading dots/slashes and normalize slash misreads between words/exclamations
    txt = re.sub(r"^[,.;:/\\|_~`'\s]+", "", txt)
    txt = re.sub(r"\s*/+\s*", ", ", txt)
    txt = re.sub(r"\s+", " ", txt).strip()
    if not txt:
        return ""

    lower = txt.lower()
    if any(pat in lower for pat in _NOISE_PATTERNS):
        return ""
    if _CHAPTER_BANNER_RE.match(txt):
        return ""
    if _PUNCT_ONLY_RE.match(txt):
        return ""

    alpha_chars = [ch for ch in txt if ch.isalpha()]
    if len(alpha_chars) == 0 or (len(txt) <= 1 and not txt.isalnum()):
        return ""
    return txt


def _normalize_bubble_casing(text: str) -> str:
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return text
    upper_ratio = sum(1 for ch in letters if ch.isupper()) / len(letters)
    if upper_ratio > 0.72:
        lowered = text.lower()
        # Capitalize first alphabetical character and first letter after sentence boundaries
        chars = list(lowered)
        cap_next = True
        for i, ch in enumerate(chars):
            if cap_next and ch.isalpha():
                chars[i] = ch.upper()
                cap_next = False
            elif ch in ".!?":
                cap_next = True
        return "".join(chars)
    return text


def _cluster_and_format_bubbles(boxes: list[_OcrBox]) -> str:
    cleaned_boxes: list[_OcrBox] = []
    for b in boxes:
        line = _clean_ocr_line(b.text)
        if line:
            b.text = line
            cleaned_boxes.append(b)

    if not cleaned_boxes:
        return ""

    # Sort top-to-bottom first, then cluster vertically adjacent lines with horizontal overlap
    cleaned_boxes.sort(key=lambda b: (b.y_center, b.x1))
    clusters: list[list[_OcrBox]] = []

    for box in cleaned_boxes:
        best_cluster: list[_OcrBox] | None = None
        best_dist = float("inf")
        for cluster in clusters:
            ref = cluster[-1]
            avg_h = (box.height + ref.height) * 0.5
            max_h = max(box.height, ref.height)
            v_gap = box.y1 - ref.y2
            if v_gap > 1.25 * max_h or box.y_center < min(c.y_center for c in cluster) - 0.5 * max_h:
                continue

            c_x1 = min(c.x1 for c in cluster)
            c_x2 = max(c.x2 for c in cluster)
            x_gap = max(box.x1 - c_x2, c_x1 - box.x2, 0)
            if x_gap <= 0.55 * avg_h and v_gap < best_dist:
                best_dist = v_gap
                best_cluster = cluster

        if best_cluster is not None:
            best_cluster.append(box)
        else:
            clusters.append([box])

    # Convert each cluster into a bubble entry with bounding box for band-based panel reading order
    bubbles: list[tuple[float, float, str]] = []
    for cluster in clusters:
        cluster.sort(key=lambda b: (b.y_center, b.x1))
        joined = " ".join(b.text for b in cluster)
        joined = re.sub(r"\s+([,.;:?!])", r"\1", joined)
        joined = _normalize_bubble_casing(joined).strip()
        if not joined:
            continue
        top_y = float(min(b.y1 for b in cluster))
        left_x = float(min(b.x1 for b in cluster))
        bubbles.append((top_y, left_x, joined))

    if not bubbles:
        return ""

    # Group bubbles into ~80px vertical bands so side-by-side panels read left-to-right naturally
    bubbles.sort(key=lambda b: (round(b[0] / 80.0), b[1], b[0]))

    parts: list[str] = []
    for _, _, text in bubbles:
        text = text.rstrip()
        if not text:
            continue
        if parts:
            prev = parts[-1]
            if prev[-1] not in ".!?":
                parts[-1] = prev + "."
        parts.append(text)

    combined = " ".join(parts).strip()
    combined = re.sub(r"([.!?])\s*[.]+", r"\1", combined)
    combined = re.sub(r"\s{2,}", " ", combined).strip()
    return combined


def extract_comic_page_text(
    raw_bytes: bytes,
    source_type: str = "hinettruyen",
    chapter_lang: str = "",
) -> str:
    """Extract speech-bubble comic text locally without cloud AI."""
    with Image.open(io.BytesIO(raw_bytes)) as img:
        rgb = img.convert("RGB")
        if rgb.width > 1000:
            new_h = max(1, round(rgb.height * (1000 / rgb.width)))
            rgb = rgb.resize((1000, new_h), Image.Resampling.BILINEAR)
        w, h = rgb.size

    if w < 16 or h < 16:
        return ""

    tile_h = 1400
    overlap = 140
    boxes: list[_OcrBox] = []

    norm_lang = chapter_lang.strip().lower()
    use_foreign_cjk_ocr = source_type == "mangadex" and norm_lang not in ("vi", "en")

    if use_foreign_cjk_ocr:
        engine = _get_foreign_ocr_engine()
        y = 0
        while y < h:
            y2 = min(h, y + tile_h)
            crop = rgb.crop((0, y, w, y2))
            res = engine(np.array(crop)[:, :, ::-1])
            det_boxes = getattr(res, "boxes", None)
            txts = getattr(res, "txts", None)
            scores = getattr(res, "scores", None)
            if det_boxes is not None and txts is not None:
                for i, poly in enumerate(det_boxes):
                    sc = float(scores[i]) if scores is not None and i < len(scores) else 1.0
                    if sc < 0.55:
                        continue
                    xs = [float(pt[0]) for pt in poly]
                    ys = [float(pt[1]) + y for pt in poly]
                    boxes.append(
                        _OcrBox(
                            x1=max(0, int(min(xs))),
                            y1=max(0, int(min(ys))),
                            x2=min(w, int(max(xs))),
                            y2=min(h, int(max(ys))),
                            text=str(txts[i] or ""),
                        )
                    )
            if y2 >= h:
                break
            y = y2 - overlap
        deduped = _deduplicate_seam_boxes(boxes)
        return _cluster_and_format_bubbles(deduped)

    det = _get_det_engine()
    y = 0
    while y < h:
        y2 = min(h, y + tile_h)
        crop = rgb.crop((0, y, w, y2))
        res = det(np.array(crop)[:, :, ::-1])
        det_boxes = getattr(res, "boxes", None)
        if det_boxes is not None and len(det_boxes) > 0:
            for poly in det_boxes:
                xs = [float(pt[0]) for pt in poly]
                ys = [float(pt[1]) + y for pt in poly]
                # Pad each detected line slightly so stacked Vietnamese accents are never clipped
                x1 = max(0, int(min(xs)) - 4)
                y1 = max(0, int(min(ys)) - 4)
                x2 = min(w, int(max(xs)) + 4)
                y2b = min(h, int(max(ys)) + 4)
                if x2 - x1 >= 8 and y2b - y1 >= 8:
                    boxes.append(_OcrBox(x1=x1, y1=y1, x2=x2, y2=y2b))
        if y2 >= h:
            break
        y = y2 - overlap

    deduped = _deduplicate_seam_boxes(boxes)
    if not deduped:
        return ""

    crops = [rgb.crop((b.x1, b.y1, b.x2, b.y2)) for b in deduped]
    texts = _predict_lines_batch(crops)
    for box, txt in zip(deduped, texts):
        box.text = txt

    return _cluster_and_format_bubbles(deduped)


def needs_vietnamese_translation(text: str, source_type: str, chapter_lang: str = "") -> bool:
    """Detect whether OCR-extracted text is in a foreign language requiring AI translation."""
    cleaned = (text or "").strip()
    if not cleaned:
        return False

    if _CJK_RE.search(cleaned):
        return True

    letters = [ch for ch in cleaned if ch.isalpha()]
    if not letters:
        return False

    viet_count = sum(1 for ch in letters if ch in _VIET_DIACRITICS)
    norm_lang = chapter_lang.strip().lower()
    if source_type == "mangadex" and norm_lang != "vi":
        return len(letters) >= 6 and (viet_count / len(letters)) < 0.04

    words = [w for w in re.split(r"\s+", cleaned) if any(ch.isalpha() for ch in w)]
    ascii_letters = sum(1 for ch in letters if ch.isascii())
    return len(words) >= 6 and viet_count == 0 and (ascii_letters / len(letters)) > 0.85
