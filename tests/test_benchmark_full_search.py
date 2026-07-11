from __future__ import annotations

import gzip
import json
import sqlite3
from pathlib import Path

from scripts.benchmark_full_search import SEARCH_FIELDS, build_benchmark_index


def test_builds_deterministic_search_shape_without_changing_source(tmp_path: Path) -> None:
    source = tmp_path / "legacy.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute(
            """
            CREATE TABLE posts (
                id INTEGER, board_id TEXT, title TEXT, author TEXT, category TEXT,
                created_at TEXT, is_aa INTEGER, content_hash TEXT,
                comment_count INTEGER, views INTEGER
            )
            """
        )
        connection.executemany(
            "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (1, "a", "첫 글", "가", None, "2026-01-01", 0, "a" * 64, 2, 10),
                (2, "b", "둘째", None, "AA", "2026-01-02", 1, None, 0, 20),
            ],
        )
    source_before = source.stat()

    output = tmp_path / "search.json.gz"
    report = build_benchmark_index(source, output)

    payload = json.loads(gzip.decompress(output.read_bytes()))
    assert report["rows"] == 2
    assert report["source_unchanged"] is True
    assert payload["fields"] == SEARCH_FIELDS
    assert payload["posts"][0][:4] == ["b", 2, "둘째", None]
    assert payload["posts"][1][6] == "a" * 64
    assert len(payload["posts"][0][6]) == 64
    source_after = source.stat()
    assert (source_after.st_size, source_after.st_mtime_ns) == (
        source_before.st_size,
        source_before.st_mtime_ns,
    )
