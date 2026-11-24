# Hugging Face Spaces Docker image for Lười Truyện Backend (OCR + TTS + AI)
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user/app/backend

RUN python -m venv /home/user/.venv
ENV PATH="/home/user/.venv/bin:$PATH"

COPY --chown=user:user backend/requirements.txt ./

# Install CPU-only PyTorch first, then remaining deps without pulling GPU torch or vietocr pins
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && grep -ivE '^(torch|torchvision|vietocr)([><=~! ]|$)' requirements.txt > /tmp/requirements-base.txt \
    && pip install --no-cache-dir -r /tmp/requirements-base.txt \
    && rm -f /tmp/requirements-base.txt \
    && pip install --no-cache-dir --no-deps vietocr==0.3.13

COPY --chown=user:user backend/ ./

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    STORAGE_DIR=/home/user/app/backend/storage \
    OCR_MODELS_DIR=/home/user/ocr_models \
    DATABASE_URL=sqlite:////home/user/app/backend/storage/app.db

RUN mkdir -p /home/user/app/backend/storage /home/user/ocr_models \
    && python scripts/prefetch_ocr_models.py

EXPOSE 7860

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
