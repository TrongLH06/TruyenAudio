"""Pre-download RapidOCR and VietOCR weights during Docker image build."""

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.ocr_service import (  # noqa: E402
    _ensure_vietocr_assets,
    _get_det_engine,
    _get_foreign_ocr_engine,
)


def main() -> None:
    """Ensure VietOCR and RapidOCR assets exist on disk before server boot."""
    _, weights_path = _ensure_vietocr_assets()
    det = _get_det_engine()
    foreign = _get_foreign_ocr_engine()
    size_mb = weights_path.stat().st_size / (1024 * 1024)
    print(f"VietOCR weights ready: {weights_path} ({size_mb:.2f} MB)")
    print(f"RapidOCR det ready: {type(det).__name__}")
    print(f"RapidOCR foreign ready: {type(foreign).__name__}")


if __name__ == "__main__":
    main()
