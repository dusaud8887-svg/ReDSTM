from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import crawler.archive as archive_module
from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    SCHEMA_VERSION,
    archive_health,
    compress_body,
    connect_archive,
    decompress_body,
    initialize_archive,
    validate_archive_for_release,
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
        assert connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 4
        assert (
            connection.execute("SELECT inventory_next_page FROM boards LIMIT 1").fetchone() is None
        )
        column = connection.execute(
            "SELECT name, type, [notnull], dflt_value, pk "
            "FROM pragma_table_info('crawl_frontier') "
            "WHERE name = 'expected_comment_count'"
        ).fetchone()
        assert tuple(column) == ("expected_comment_count", "INTEGER", 0, None, 0)
        assert MIGRATIONS[-1].version == 4
        assert MIGRATIONS[-1].static_projection_compatible is True
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            connection.execute(
                "INSERT INTO crawl_frontier "
                "(board_id, external_post_id, url, expected_comment_count) "
                "VALUES ('ss_temp01', 1, 'https://www.typemoon.net/ss_temp01/1', -1)"
            )


def test_schema_v4_backfills_frontier_comment_expectation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "archive.sqlite"
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "SCHEMA_VERSION", 3)
        patch.setattr(archive_module, "MIGRATIONS", MIGRATIONS[:3])
        initialize_archive(path)

    with connect_archive(path) as connection:
        _board(connection, "ss_temp01")
        _post(connection, "ss_temp01", 1)
        connection.execute(
            "UPDATE posts SET comment_count = 5 "
            "WHERE board_id = 'ss_temp01' AND external_post_id = 1"
        )
        connection.executemany(
            "INSERT INTO crawl_frontier (board_id, external_post_id, url) VALUES (?, ?, ?)",
            [
                ("ss_temp01", 1, "https://www.typemoon.net/ss_temp01/1"),
                ("ss_temp01", 2, "https://www.typemoon.net/ss_temp01/2"),
            ],
        )

    initialize_archive(path)

    with connect_archive(path, read_only=True) as connection:
        rows = [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, expected_comment_count "
                "FROM crawl_frontier ORDER BY external_post_id"
            )
        ]
        assert rows == [(1, 5), (2, None)]
        assert (
            connection.execute("SELECT incremental_anchor_post_id FROM boards").fetchone()[0] == 2
        )
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4


def test_release_schema_guard_accepts_exact_v4_and_rejects_v3_target(
    tmp_path: Path,
) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)
    hashes = {migration.version: migration.sha256 for migration in MIGRATIONS}

    with connect_archive(path, read_only=True) as connection:
        validate_archive_for_release(
            connection,
            target_schema_version=4,
            target_migration_hashes=hashes,
        )
        with pytest.raises(RuntimeError, match="does not support canonical schema v4"):
            validate_archive_for_release(
                connection,
                target_schema_version=3,
                target_migration_hashes={version: hashes[version] for version in range(1, 4)},
            )


@pytest.mark.parametrize(
    "column_sql",
    [None, "ALTER TABLE crawl_frontier ADD COLUMN expected_comment_count TEXT"],
)
def test_release_schema_guard_rejects_missing_or_wrong_v4_column(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    column_sql: str | None,
) -> None:
    path = tmp_path / "archive.sqlite"
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "SCHEMA_VERSION", 3)
        patch.setattr(archive_module, "MIGRATIONS", MIGRATIONS[:3])
        initialize_archive(path)
    with connect_archive(path) as connection:
        if column_sql is not None:
            connection.execute(column_sql)
        connection.execute(
            "INSERT INTO schema_migrations (version, sha256) VALUES (4, ?)",
            (MIGRATIONS[3].sha256,),
        )
        connection.execute("PRAGMA user_version = 4")

    with connect_archive(path, read_only=True) as connection:
        with pytest.raises(RuntimeError, match="physical shape"):
            validate_archive_for_release(
                connection,
                target_schema_version=4,
                target_migration_hashes={
                    migration.version: migration.sha256 for migration in MIGRATIONS[:4]
                },
            )


def test_release_schema_guard_rejects_inconsistent_ledger_and_target_metadata(
    tmp_path: Path,
) -> None:
    path = tmp_path / "archive.sqlite"
    initialize_archive(path)
    hashes = {migration.version: migration.sha256 for migration in MIGRATIONS}
    with connect_archive(path) as connection:
        connection.execute("DELETE FROM schema_migrations WHERE version = 4")

    with connect_archive(path, read_only=True) as connection:
        with pytest.raises(RuntimeError, match="ledger is inconsistent"):
            validate_archive_for_release(
                connection,
                target_schema_version=4,
                target_migration_hashes=hashes,
            )
        with pytest.raises(RuntimeError, match="target migration metadata"):
            validate_archive_for_release(
                connection,
                target_schema_version=4,
                target_migration_hashes={version: hashes[version] for version in range(1, 4)},
            )


def test_schema_v2_indexes_raw_capture_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "archive.sqlite"
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "SCHEMA_VERSION", 1)
        patch.setattr(archive_module, "MIGRATIONS", MIGRATIONS[:1])
        initialize_archive(path)
        with connect_archive(path) as connection:
            _board(connection, "ss_temp01")

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
