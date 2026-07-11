from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from crawler.archive import connect_archive, initialize_archive
from scripts.backup_archive import create_backup


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
    partial = snapshot.with_name(f"{snapshot.name}.partial")
    shutil.copyfile(source, partial)

    report = create_backup(source, snapshot, manifest, resume_partial=True)

    assert report["ok"] is True
    assert snapshot.exists()
    assert not partial.exists()
