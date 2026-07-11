FROM ghcr.io/astral-sh/uv:0.11.28 AS uv
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    REDSTM_DATA_DIR=/data \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY crawler ./crawler
COPY scripts ./scripts
COPY scrapy.cfg ./

RUN groupadd --system redstm && \
    useradd --system --gid redstm --home-dir /app redstm && \
    mkdir -p /data && \
    chown -R redstm:redstm /app /data

USER redstm

ENTRYPOINT ["uv", "run", "--frozen", "--no-dev"]
CMD ["scrapy", "version", "-v"]
