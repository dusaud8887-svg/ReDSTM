from __future__ import annotations

import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

from crawler.archive import connect_archive, initialize_archive
from scripts import backup_archive
from scripts.backup_archive import create_backup, main


@pytest.mark.parametrize(
    "snapshot_name,manifest_name",
    [
        ("same", "same"),
        ("source.sqlite", "manifest"),
        ("snapshot", "source.sqlite"),
        ("snapshot", "snapshot.partial"),
        ("manifest.partial", "manifest"),
        ("source.sqlite", "source.sqlite.partial"),
    ],
)
def test_backup_rejects_colliding_paths_before_creating_outputs(
    tmp_path: Path, snapshot_name: str, manifest_name: str
) -> None:
    source = tmp_path / "source.sqlite"
    initialize_archive(source)
    before = source.read_bytes()
    existing = set(tmp_path.iterdir())
    with pytest.raises(ValueError, match="paths must differ"):
        create_backup(source, tmp_path / snapshot_name, tmp_path / manifest_name)
    assert source.read_bytes() == before
    assert set(tmp_path.iterdir()) == existing


def test_create_backup_verifies_snapshot_and_refuses_overwrite(tmp_path: Path) -> None:
    source = tmp_path / "source.sqlite"
    snapshot = tmp_path / "backups" / "snapshot.sqlite"
    manifest = tmp_path / "backups" / "snapshot.manifest.json"
    initialize_archive(source)
    with connect_archive(source) as connection:
        connection.execute(
            """
            INSERT INTO boards (
                board_id, name, canonical_url, first_seen_at, last_seen_at
            ) VALUES ('test', 'Test', 'https://example.test/board', 'now', 'now')
            """
        )

    report = create_backup(source, snapshot, manifest)

    assert report["ok"] is True
    assert report["source"]["health"] is None
    assert report["snapshot"]["health"]["quick_check"] == ["ok"]
    assert snapshot.exists()
    assert json.loads(manifest.read_text(encoding="utf-8"))["snapshot"]["sha256"]
    with connect_archive(snapshot, read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM boards").fetchone()[0] == 1

    with pytest.raises(FileExistsError):
        create_backup(source, snapshot, manifest)


def test_resume_partial_verifies_without_recopying(tmp_path: Path) -> None:
    source = tmp_path / "source.sqlite"
    snapshot = tmp_path / "snapshot.sqlite"
    manifest = tmp_path / "snapshot.manifest.json"
    initialize_archive(source)
    # A real resumable partial is produced by the WAL-aware backup API. This test fabricates
    # one with a raw file copy, so it must first fold the WAL back into the main file —
    # copying a live WAL database's main file alone would miss the still-uncheckpointed
    # schema writes and fail verification.
    with connect_archive(source) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    partial = snapshot.with_name(f"{snapshot.name}.partial")
    shutil.copyfile(source, partial)

    report = create_backup(source, snapshot, manifest, resume_partial=True)

    assert report["ok"] is True
    assert snapshot.exists()
    assert not partial.exists()


@pytest.mark.parametrize("advance_before_copy", [False, True])
def test_online_backup_verifies_the_copied_snapshot_when_source_advances(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, advance_before_copy: bool
) -> None:
    source = tmp_path / "source.sqlite"
    snapshot = tmp_path / "snapshot.sqlite"
    manifest = tmp_path / "snapshot.manifest.json"
    initialize_archive(source)
    original_evidence = backup_archive._evidence
    original_counts = backup_archive._connection_table_counts

    def advance() -> None:
        with connect_archive(source) as connection:
            connection.execute(
                "INSERT INTO boards "
                "(board_id, name, canonical_url, first_seen_at, last_seen_at) "
                "VALUES ('later', 'Later', 'https://example.test/later', 'now', 'now')"
            )

    def counts(connection: sqlite3.Connection) -> dict[str, int]:
        result = original_counts(connection)
        if (
            advance_before_copy
            and Path(connection.execute("PRAGMA database_list").fetchone()[2]) == source
        ):
            advance()
        return result

    def evidence(path: Path, **kwargs: Any) -> dict[str, Any]:
        if path == source and not advance_before_copy:
            advance()
        return original_evidence(path, **kwargs)

    monkeypatch.setattr(backup_archive, "_connection_table_counts", counts)
    monkeypatch.setattr(backup_archive, "_evidence", evidence)
    report = create_backup(source, snapshot, manifest)
    assert report["ok"] is True
    assert report["source"]["counts"]["boards"] == 0
    assert report["snapshot"]["counts"]["boards"] == 0
    with connect_archive(source, read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM boards").fetchone()[0] == 1


def test_backup_cli_pings_dead_man_check_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "source.sqlite"
    snapshot = tmp_path / "snapshot.sqlite"
    manifest = tmp_path / "snapshot.manifest.json"
    initialize_archive(source)
    pinged: list[tuple[bool, str]] = []
    monkeypatch.setattr(
        "scripts.backup_archive.notify_dead_man",
        lambda ok, url: pinged.append((ok, url)),
    )
    monkeypatch.setenv("REDSTM_BACKUP_HEALTHCHECK_URL", "https://hc.example.test/backup")
    monkeypatch.setattr(
        sys,
        "argv",
        ["backup", str(source), "--snapshot", str(snapshot), "--manifest", str(manifest)],
    )

    assert main() == 0
    assert pinged == [(True, "https://hc.example.test/backup")]
    assert json.loads(capsys.readouterr().out)["ok"] is True
