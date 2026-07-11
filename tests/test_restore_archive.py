from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from crawler.archive import connect_archive, initialize_archive
from scripts.backup_archive import create_backup
from scripts.restore_archive import main, restore_backup


def _backup(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "source.sqlite"
    snapshot = tmp_path / "snapshot.sqlite"
    manifest = tmp_path / "snapshot.manifest.json"
    initialize_archive(source)
    with connect_archive(source) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('test', 'Test', 'https://example.test/board', 'now', 'now')
            """
        )
    create_backup(source, snapshot, manifest)
    return snapshot, manifest


def test_restore_backup_verifies_and_atomically_publishes(tmp_path: Path) -> None:
    snapshot, manifest = _backup(tmp_path)
    target = tmp_path / "restored" / "archive.sqlite"

    report = restore_backup(snapshot, manifest, target)

    assert report["ok"] is True
    assert target.exists()
    assert not target.with_name("archive.sqlite.partial").exists()
    with connect_archive(target, read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM boards").fetchone()[0] == 1


def test_restore_backup_rejects_corrupt_snapshot(tmp_path: Path) -> None:
    snapshot, manifest = _backup(tmp_path)
    target = tmp_path / "restored.sqlite"
    with snapshot.open("ab") as stream:
        stream.write(b"corrupt")

    with pytest.raises(ValueError, match="does not match"):
        restore_backup(snapshot, manifest, target)

    assert not target.exists()
    assert not target.with_name("restored.sqlite.partial").exists()


def test_restore_backup_rejects_corrupt_manifest_with_json_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    snapshot, manifest = _backup(tmp_path)
    target = tmp_path / "restored.sqlite"
    manifest.write_text("{not-json", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        ["restore_archive", str(snapshot), "--manifest", str(manifest), "--target", str(target)],
    )

    assert main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is False
    assert output["error"] == "JSONDecodeError"
    assert not target.exists()


def test_restore_backup_refuses_overwrite(tmp_path: Path) -> None:
    snapshot, manifest = _backup(tmp_path)
    target = tmp_path / "restored.sqlite"
    target.write_bytes(b"keep")

    with pytest.raises(FileExistsError, match="already exists"):
        restore_backup(snapshot, manifest, target)

    assert target.read_bytes() == b"keep"
