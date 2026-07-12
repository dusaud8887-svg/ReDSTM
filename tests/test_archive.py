from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from crawler.archive import (
    APPLICATION_ID,
    SCHEMA_VERSION,
    archive_health,
    compress_body,
    connect_archive,
    decompress_body,
    initialize_archive,
)


def _board(connection: sqlite3.Connection, board_id: str) -> None:
    connection.execute(
        """
        INSERT INTO boards (
            board_id, name, canonical_url, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, '2026-07-11T00:00:00+00:00', '2026-07-11T00:00:00+00:00')
        """,
        (board_id, board_id, f"https://www.typemoon.net/{board_id}"),
    )


def _post(connection: sqlite3.Connection, board_id: str, external_post_id: int) -> int:
    cursor = connection.execute(
        """
        INSERT INTO posts (
            board_id, external_post_id, canonical_url, title, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, 'title', '2026-07-11T00:00:00+00:00',
                  '2026-07-11T00:00:00+00:00')
        """,
        (
            board_id,
            external_post_id,
            f"https://www.typemoon.net/{board_id}/{external_post_id}",
        ),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def _version(connection: sqlite3.Connection, post_id: int, marker: str) -> int:
    cursor = connection.execute(
        """
        INSERT INTO post_versions (
            post_id, content_sha256, parser_version, capture_origin, body_html_zstd,
            body_text_zstd, comments_sha256, captured_at
        ) VALUES (?, ?, 'test', 'legacy_import', ?, ?, ?,
                  '2026-07-11T00:00:00+00:00')
        """,
        (post_id, marker * 64, compress_body("<p>body</p>"), compress_body("body"), "c" * 64),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def test_initialize_archive_is_idempotent_and_healthy(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)
    initialize_archive(path)

    health = archive_health(path)
    assert health == {
        "schema_version": SCHEMA_VERSION,
        "application_id": APPLICATION_ID,
        "quick_check": ["ok"],
        "foreign_key_errors": [],
        "table_count": 13,
    }

    with connect_archive(path) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 3
        assert (
            connection.execute("SELECT inventory_next_page FROM boards LIMIT 1").fetchone() is None
        )


def test_schema_v2_indexes_raw_capture_hash(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)
    with connect_archive(path) as connection:
        _board(connection, "ss_temp01")
        connection.execute("DROP INDEX captures_raw_sha256_idx")
        connection.execute("DELETE FROM schema_migrations WHERE version = 2")
        connection.execute("PRAGMA user_version = 1")

    initialize_archive(path)

    with connect_archive(path) as connection:
        index = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE name = 'captures_raw_sha256_idx'"
        ).fetchone()
        assert index is not None
        assert "raw_sha256" in index["sql"]
        assert connection.execute("SELECT COUNT(*) FROM boards").fetchone()[0] == 1
        assert connection.execute("SELECT inventory_next_page FROM boards").fetchone()[0] == 1


def test_body_compression_round_trip() -> None:
    body = "본문 text " * 1_000
    compressed = compress_body(body)

    assert len(compressed) < len(body.encode())
    assert decompress_body(compressed) == body


def test_archive_uses_board_and_external_id_as_post_identity(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)

    with connect_archive(path) as connection:
        _board(connection, "ss_temp01")
        _board(connection, "ss_temp02")
        _post(connection, "ss_temp01", 123)
        _post(connection, "ss_temp02", 123)
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            _post(connection, "ss_temp01", 123)


def test_latest_version_must_belong_to_the_same_post(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)

    with connect_archive(path) as connection:
        _board(connection, "ss_temp01")
        first_post = _post(connection, "ss_temp01", 1)
        second_post = _post(connection, "ss_temp01", 2)
        first_version = _version(connection, first_post, "a")
        second_version = _version(connection, second_post, "b")
        connection.execute(
            "UPDATE posts SET latest_version_id = ? WHERE id = ?",
            (first_version, first_post),
        )
        with pytest.raises(sqlite3.IntegrityError, match="another post"):
            connection.execute(
                "UPDATE posts SET latest_version_id = ? WHERE id = ?",
                (second_version, first_post),
            )


def test_running_frontier_requires_a_complete_lease(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)

    with connect_archive(path) as connection:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            connection.execute(
                """
                INSERT INTO crawl_frontier (
                    board_id, external_post_id, url, state, lease_token
                ) VALUES ('ss_temp01', 1, 'https://www.typemoon.net/ss_temp01/1',
                          'running', 'token')
                """
            )


def test_changed_migration_hash_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE schema_migrations SET sha256 = ?", ("0" * 64,))

    with pytest.raises(RuntimeError, match="hash does not match"):
        initialize_archive(path)
