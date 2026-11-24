"""Verify bundled VietOCR ONNX assets and pre-download RapidOCR detector during build."""

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import settings  # noqa: E402
from app.services.ocr_service import (  # noqa: E402
    _get_det_engine,
    _get_vietocr_onnx,
)


def main() -> None:
    """Verify ONNX VietOCR assets load and pre-download the lightweight RapidOCR text detector."""
    model_dir = settings.ocr_models_path
    enc_path = model_dir / "vietocr_encoder.onnx"
    dec_path = model_dir / "vietocr_decoder.onnx"
    cfg_path = model_dir / "vietocr_config.json"

    _get_vietocr_onnx()
    det = _get_det_engine()

    mb = 1024 * 1024
    print(f"VietOCR ONNX dir: {model_dir}")
    print(f"  vietocr_encoder.onnx: {enc_path.stat().st_size / mb:.2f} MB")
    print(f"  vietocr_decoder.onnx: {dec_path.stat().st_size / mb:.2f} MB")
    print(f"  vietocr_config.json:  {cfg_path.stat().st_size} B")
    print(f"RapidOCR det ready: {type(det).__name__}")


if __name__ == "__main__":
    main()
