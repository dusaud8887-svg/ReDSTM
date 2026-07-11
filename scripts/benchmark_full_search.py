from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

SEARCH_FIELDS = [
    "board_id",
    "external_post_id",
    "title",
    "author",
    "category",
    "created_at_raw",
    "payload_sha256",
]
_REQUIRED_COLUMNS = {
    "id",
    "board_id",
    "title",
    "author",
    "category",
    "created_at",
    "content_hash",
}
_SHA256 = re.compile(r"[0-9a-fA-F]{64}")


def build_benchmark_index(source: Path, output: Path) -> dict[str, Any]:
    source = source.expanduser().resolve(strict=True)
    output = output.expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite: {output}")
    source_before = source.stat()
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    rows = 0
    uncompressed_bytes = 0

    with sqlite3.connect(f"{source.as_uri()}?mode=ro&immutable=1", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(posts)")}
        missing = sorted(_REQUIRED_COLUMNS - columns)
        if missing:
            raise ValueError(f"legacy database is missing columns: {', '.join(missing)}")

        with (
            output.open("xb") as raw,
            gzip.GzipFile(
                filename="", mode="wb", compresslevel=6, mtime=0, fileobj=raw
            ) as compressed,
        ):

            def write(value: str) -> None:
                nonlocal uncompressed_bytes
                encoded = value.encode()
                compressed.write(encoded)
                uncompressed_bytes += len(encoded)

            write(
                '{"schema_version":1,"fields":'
                + json.dumps(SEARCH_FIELDS, ensure_ascii=False, separators=(",", ":"))
                + ',"posts":['
            )
            for row in connection.execute(
                """
                SELECT board_id, id, title, author, category, created_at, content_hash
                FROM posts
                ORDER BY created_at DESC, id DESC, board_id DESC
                """
            ):
                board_id = str(row["board_id"])
                post_id = int(row["id"])
                content_hash = str(row["content_hash"] or "")
                if not _SHA256.fullmatch(content_hash):
                    content_hash = hashlib.sha256(f"{board_id}:{post_id}".encode()).hexdigest()
                item = [
                    board_id,
                    post_id,
                    row["title"],
                    row["author"],
                    row["category"],
                    row["created_at"],
                    content_hash.lower(),
                ]
                if rows:
                    write(",")
                write(json.dumps(item, ensure_ascii=False, separators=(",", ":")))
                rows += 1
            write("]}")

    source_after = source.stat()
    source_unchanged = (source_before.st_size, source_before.st_mtime_ns) == (
        source_after.st_size,
        source_after.st_mtime_ns,
    )
    if not source_unchanged:
        raise RuntimeError("source database changed during benchmark export")
    return {
        "rows": rows,
        "uncompressed_bytes": uncompressed_bytes,
        "compressed_bytes": output.stat().st_size,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "source_unchanged": True,
        "payload_hashes": "benchmark placeholders derived from legacy content_hash",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a full legacy metadata search benchmark.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_benchmark_index(args.source, args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
