from __future__ import annotations

from pathlib import Path

import pytest
from filelock import FileLock

import crawler.archive as archive_module
from crawler.archive import (
    MIGRATIONS,
    RUNTIME_SCHEMA_POLICY,
    SCHEMA_VERSION,
    connect_archive,
    initialize_archive,
    require_archive_schema,
)
from scripts.migrate_archive import migrate_archive, validate_release_pair


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


def test_explicit_migration_holds_locks_and_backfills_current_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "archive.sqlite"
    _schema_v3_archive(archive, monkeypatch, comment_count=5)
    state = tmp_path / "state"
    state.mkdir()

    snapshot = tmp_path / "snapshot.sqlite"
    manifest = tmp_path / "snapshot.json"
    report = migrate_archive(
        archive,
        control_lock=state / "control.lock",
        snapshot=snapshot,
        manifest=manifest,
    )

    assert {key: report[key] for key in report if key != "snapshot"} == {
        "ok": True,
        "before_schema_version": 3,
        "schema_version": SCHEMA_VERSION,
        "target_schema_version": SCHEMA_VERSION,
        "quick_check": ["ok"],
        "foreign_key_errors": 0,
    }
    assert report["snapshot"]["bytes"] == snapshot.stat().st_size
    assert len(report["snapshot"]["sha256"]) == 64
    assert manifest.is_file()
    with connect_archive(archive, read_only=True) as connection:
        assert (
            connection.execute("SELECT expected_comment_count FROM crawl_frontier").fetchone()[0]
            == 5
        )
        assert (
            connection.execute("SELECT incremental_anchor_post_id FROM boards").fetchone()[0] == 1
        )


def test_explicit_migration_refuses_an_active_runner_lock(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    control_lock = tmp_path / "control.lock"

    with FileLock(str(control_lock), timeout=0):
        with pytest.raises(RuntimeError, match="migration lock is held"):
            migrate_archive(archive, control_lock=control_lock)


def test_release_pair_requires_distinct_exact_explicit_schema_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = tmp_path / "current"
    previous = tmp_path / "previous"
    current.mkdir()
    previous.mkdir()
    expected = {
        "schema_version": SCHEMA_VERSION,
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
    }
    monkeypatch.setattr(
        "scripts.migrate_archive._release_schema_metadata",
        lambda release, **_kwargs: expected if release == current else dict(expected),
    )

    validate_release_pair(current, previous)
    with pytest.raises(RuntimeError, match="two distinct"):
        validate_release_pair(current, current)

    monkeypatch.setattr(
        "scripts.migrate_archive._release_schema_metadata",
        lambda release, **_kwargs: (
            expected if release == current else {**expected, "schema_policy": "automatic"}
        ),
    )
    with pytest.raises(RuntimeError, match="not schema-compatible"):
        validate_release_pair(current, previous)
