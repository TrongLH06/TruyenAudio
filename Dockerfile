# Lightweight Render Free Docker image for Lười Truyện Backend (Pure ONNX OCR + Google gTTS + AI)
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
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user:user backend/ ./

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2 \
    OCR_NUM_THREADS=1 \
    OCR_CONCURRENCY=1 \
    PORT=10000 \
    STORAGE_DIR=/home/user/app/backend/storage \
    OCR_MODELS_DIR=/home/user/app/backend/models/vietocr_onnx \
    DATABASE_URL=sqlite:////home/user/app/backend/storage/app.db

RUN mkdir -p /home/user/app/backend/storage \
    && python scripts/prefetch_ocr_models.py

EXPOSE 10000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
