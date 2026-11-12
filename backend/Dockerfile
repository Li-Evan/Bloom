# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

ARG UV_VERSION=0.7.6

ENV PATH="/app/.venv/bin:$PATH" \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////app/storage/bloom.sqlite3 \
    IMAGE_STORE_DIR=/app/storage/images

RUN --mount=type=cache,target=/root/.cache/pip pip install "uv==${UV_VERSION}"

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

COPY alembic.ini ./
COPY alembic alembic/
COPY data data/
COPY app app/

# 数据库和图片在 /app/storage（compose 把它挂成卷）；随代码发布的知识数据在 /app/data，不能被卷盖住
RUN useradd --create-home appuser && mkdir -p /app/storage && chown appuser /app/storage
USER appuser

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
