from __future__ import annotations

import json
import sqlite3
from compression import zstd
from pathlib import Path

import pytest

from scripts.export_static_sample import export_static_sample


def _source(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY, board_id TEXT, title TEXT, author TEXT,
                category TEXT, content_html TEXT, is_aa INTEGER, views INTEGER,
                created_at TEXT
            );
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY, post_id INTEGER, board_id TEXT, author TEXT,
                content TEXT, created_at TEXT, parent_id INTEGER, depth INTEGER
            );
            CREATE TABLE collections (
                id INTEGER PRIMARY KEY, board_id TEXT, collection_type TEXT, title TEXT
            );
            CREATE TABLE collection_episodes (
                id INTEGER PRIMARY KEY, collection_id INTEGER, post_id INTEGER,
                board_id TEXT, episode_number REAL
            );
            """
        )
        connection.executemany(
            "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (1, "board_a", "첫 글", "가", None, "<p>본문 1</p>", 0, 10, "2026.01.01"),
                (2, "board_a", "둘째", "나", "AA", "<pre>본문 2</pre>", 1, 20, "2026.01.02"),
                # Dash format on the newest post: raw string order would rank the
                # older dot-format dates above it, normalized order must not.
                (3, "board_b", "셋째", None, None, "<p>본문 3</p>", 0, 30, "2026-01-03"),
            ],
        )
        connection.execute("INSERT INTO collections VALUES (1, 'board_a', 'series', '연작')")
        connection.executemany(
            "INSERT INTO collection_episodes VALUES (?, 1, ?, 'board_a', ?)",
            [(1, 1, 1.0), (2, 2, 2.0)],
        )
        connection.executemany(
            "INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (101, 2, "board_a", "댓글", "<b>root</b>", "2026.01.02", None, 0),
                (102, 2, "board_a", "답글", "<i>reply</i>", "2026.01.02", 101, 1),
            ],
        )


def _tree(path: Path) -> dict[str, bytes]:
    return {
        file.relative_to(path).as_posix(): file.read_bytes()
        for file in path.rglob("*")
        if file.is_file()
    }


def test_legacy_sample_export_is_read_only_and_reproducible(tmp_path: Path) -> None:
    source = tmp_path / "legacy.sqlite"
    _source(source)
    source_before = source.stat()

    first = tmp_path / "first"
    second = tmp_path / "second"
    first_report = export_static_sample(source, first, sample_size=3)
    second_report = export_static_sample(source, second, sample_size=3)

    assert first_report == second_report
    assert first_report["post_count"] == 3
    assert first_report["comment_count"] == 2
    assert first_report["board_count"] == 2
    assert first_report["search_object_bytes"] > 0
    assert first_report["collection_count"] == 1
    assert first_report["source_unchanged"] is True
    assert _tree(first) == _tree(second)

    release = json.loads((first / "release.json").read_bytes())
    assert release["post_count"] == 3
    versioned_release = first / first_report["release_object_key"]
    assert versioned_release.read_bytes() == (first / "release.json").read_bytes()
    search_file = first / release["search"]["object_key"]
    search = json.loads(zstd.decompress(search_file.read_bytes()))
    assert search["fields"] == [
        "board_id",
        "external_post_id",
        "title",
        "author",
        "category",
        "created_at_raw",
        "payload_sha256",
    ]
    assert len(search["posts"]) == 3
    assert search["posts"][0][:4] == ["board_b", 3, "셋째", None]
    collection_file = first / release["collections"]["object_key"]
    collections = json.loads(zstd.decompress(collection_file.read_bytes()))["collections"]
    assert [entry["external_post_id"] for entry in collections[0]["entries"]] == [1, 2]
    post_file = next((first / "posts" / "board_a").glob("2-*.json.zst"))
    post = json.loads(zstd.decompress(post_file.read_bytes()))
    assert post["capture_origin"] == "legacy_import"
    assert post["comments"][1]["parent_position"] == 1
    assert post["comments"][1]["depth"] == 1

    source_after = source.stat()
    assert (source_after.st_size, source_after.st_mtime_ns) == (
        source_before.st_size,
        source_before.st_mtime_ns,
    )
    with pytest.raises(FileExistsError):
        export_static_sample(source, first, sample_size=3)
