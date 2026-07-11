from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from scripts.profile_legacy import profile_legacy_database


def _create_legacy_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE posts (
                id INTEGER NOT NULL,
                board_id TEXT NOT NULL,
                url TEXT,
                title TEXT NOT NULL,
                author TEXT,
                category TEXT,
                content_html TEXT NOT NULL,
                content_text TEXT,
                raw_html TEXT,
                content_hash TEXT,
                attachments TEXT,
                is_aa INTEGER DEFAULT 0,
                views INTEGER DEFAULT 0,
                created_at TEXT,
                crawled_at TEXT NOT NULL,
                comment_count INTEGER DEFAULT 0,
                UNIQUE(id, board_id)
            );
            CREATE INDEX idx_posts_board_created ON posts(board_id, created_at DESC, id DESC);
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY,
                post_id INTEGER NOT NULL,
                board_id TEXT NOT NULL,
                author TEXT,
                content TEXT NOT NULL,
                created_at TEXT,
                parent_id INTEGER,
                depth INTEGER DEFAULT 0
            );
            CREATE TABLE collections (
                id INTEGER PRIMARY KEY,
                board_id TEXT NOT NULL,
                collection_type TEXT,
                title TEXT,
                episode_count INTEGER,
                total_views INTEGER,
                total_comments INTEGER,
                last_created_at TEXT
            );
            CREATE TABLE collection_episodes (
                collection_id INTEGER,
                post_id INTEGER,
                board_id TEXT
            );
            CREATE TABLE post_queue (status TEXT);
            CREATE TABLE crawl_log (status TEXT);
            CREATE TABLE crawler_runs (status TEXT);
            CREATE VIRTUAL TABLE posts_fts USING fts5(title, author, category, content='posts');
            """
        )
        connection.execute("INSERT INTO boards VALUES ('b1', 'Board')")
        posts = [
            (
                1,
                "b1",
                "u1",
                "첫 글",
                "author",
                "cat",
                "<p>가</p>",
                "가",
                "raw1",
                "same",
                "[]",
                0,
                10,
                "2026-01-01",
                "2026-01-02",
                1,
            ),
            (
                2,
                "b1",
                "u2",
                "둘째 글",
                "author",
                "cat",
                "<p>나</p>",
                "나",
                "raw2",
                "same",
                "[]",
                1,
                20,
                "2026-01-03",
                "2026-01-04",
                0,
            ),
        ]
        connection.executemany(
            "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            posts,
        )
        connection.execute(
            "INSERT INTO comments VALUES (1, 1, 'b1', 'reader', 'comment', '2026-01-02', NULL, 0)"
        )
        connection.execute(
            "INSERT INTO collections VALUES (1, 'b1', 'series', 'Series', 1, 10, 1, '2026-01-03')"
        )
        connection.execute("INSERT INTO collection_episodes VALUES (1, 1, 'b1')")
        connection.execute("INSERT INTO post_queue VALUES ('pending')")
        connection.execute("INSERT INTO crawl_log VALUES ('done')")
        connection.execute("INSERT INTO crawler_runs VALUES ('succeeded')")
        connection.execute(
            """
            INSERT INTO posts_fts(rowid, title, author, category)
            SELECT rowid, title, author, category FROM posts
            """
        )


def test_profile_legacy_database_is_read_only(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.sqlite"
    _create_legacy_database(database_path)
    before = database_path.stat()

    profile = profile_legacy_database(
        database_path,
        benchmark_repeats=2,
        query_timeout_seconds=2,
    )
    after = database_path.stat()

    assert profile["database"]["unchanged"] is True
    assert profile["table_counts"]["posts"] == 2
    assert profile["posts"]["field_sizes"]["content_text_bytes"]["total"] == 6
    assert profile["posts"]["duplicate_content_hashes"]["redundant_rows"] == 1
    assert all(value == 0 for value in profile["relationships"].values())
    benchmark_errors = {
        name: result["error"]
        for name, result in profile["viewer_query_benchmarks"].items()
        if "error" in result and name != "metadata_fts_legacy"
    }
    assert benchmark_errors == {}
    assert "error" in profile["viewer_query_benchmarks"]["metadata_fts_legacy"]
    assert "error" not in profile["viewer_query_benchmarks"]["metadata_fts_page"]
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)


def test_profile_legacy_database_requires_core_tables(tmp_path: Path) -> None:
    database_path = tmp_path / "not-legacy.sqlite"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE something_else (id INTEGER)")

    with pytest.raises(ValueError, match="missing legacy tables"):
        profile_legacy_database(database_path)
