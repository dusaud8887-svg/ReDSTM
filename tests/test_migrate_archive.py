from __future__ import annotations

from pathlib import Path

import pytest
from filelock import FileLock

import crawler.archive as archive_module
from crawler.archive import MIGRATIONS, connect_archive, initialize_archive, require_archive_schema
from scripts.migrate_archive import migrate_archive


def _schema_v3_archive(
    path: Path, monkeypatch: pytest.MonkeyPatch, *, comment_count: int = 5
) -> None:
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "SCHEMA_VERSION", 3)
        patch.setattr(archive_module, "MIGRATIONS", MIGRATIONS[:3])
        initialize_archive(path)
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO boards (
                board_id, name, canonical_url, first_seen_at, last_seen_at
            ) VALUES ('write_free21', 'Board', 'https://www.typemoon.net/write_free21',
                      'now', 'now')
            """
        )
        connection.execute(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title, comment_count,
                first_seen_at, last_seen_at
            ) VALUES ('write_free21', 1, 'https://www.typemoon.net/write_free21/1',
                      'post', ?, 'now', 'now')
            """,
            (comment_count,),
        )
        connection.execute(
            """
            INSERT INTO crawl_frontier (board_id, external_post_id, url)
            VALUES ('write_free21', 1, 'https://www.typemoon.net/write_free21/1')
            """
        )


def test_runtime_schema_check_never_auto_migrates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "archive.sqlite"
    _schema_v3_archive(archive, monkeypatch)

    with pytest.raises(RuntimeError, match="explicit archive migration"):
        require_archive_schema(archive)

    with connect_archive(archive, read_only=True) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 3
        assert not any(
            row[1] == "expected_comment_count"
            for row in connection.execute("PRAGMA table_info(crawl_frontier)")
        )


def test_explicit_migration_holds_locks_and_backfills_v4(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "archive.sqlite"
    _schema_v3_archive(archive, monkeypatch, comment_count=5)
    state = tmp_path / "state"
    state.mkdir()

    report = migrate_archive(archive, control_lock=state / "control.lock")

    assert report == {
        "ok": True,
        "before_schema_version": 3,
        "schema_version": 4,
        "target_schema_version": 4,
        "quick_check": ["ok"],
        "foreign_key_errors": 0,
    }
    with connect_archive(archive, read_only=True) as connection:
        assert (
            connection.execute("SELECT expected_comment_count FROM crawl_frontier").fetchone()[0]
            == 5
        )


def test_explicit_migration_refuses_an_active_runner_lock(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    control_lock = tmp_path / "control.lock"

    with FileLock(str(control_lock), timeout=0):
        with pytest.raises(RuntimeError, match="migration lock is held"):
            migrate_archive(archive, control_lock=control_lock)
