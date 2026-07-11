from __future__ import annotations

import json
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from crawler.archive import initialize_archive
from scripts.doctor import inspect_archive, main

_NOW = datetime(2026, 7, 11, 12, 0, tzinfo=UTC)


def test_doctor_accepts_healthy_archive(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    warc_dir = tmp_path / "warc"
    warc_dir.mkdir()
    initialize_archive(archive)

    report = inspect_archive(archive, warc_dir, now=_NOW)

    assert report["ok"] is True
    assert report["issues"] == []


def test_doctor_reports_failures_without_sensitive_capture_data(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    warc_dir = tmp_path / "warc"
    warc_dir.mkdir()
    initialize_archive(archive)
    expired = (_NOW - timedelta(minutes=1)).isoformat(timespec="seconds")
    with sqlite3.connect(archive) as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute(
            """
            INSERT INTO crawl_frontier (
                board_id, external_post_id, url, state, lease_token, lease_expires_at
            ) VALUES ('board', 7, 'https://secret.example/post/7', 'running', 'secret-token', ?)
            """,
            (expired,),
        )
        connection.execute(
            """
            INSERT INTO captures (
                run_id, url, entity_type, fetched_at, outcome, warc_file
            ) VALUES ('missing-run', 'https://secret.example/post/7', 'post', ?, 'stored',
                      'missing.warc.gz')
            """,
            (_NOW.isoformat(timespec="seconds"),),
        )
    (warc_dir / "interrupted.warc.gz.partial").write_bytes(b"partial")

    report = inspect_archive(archive, warc_dir, now=_NOW)
    rendered = json.dumps(report)

    assert report["ok"] is False
    assert report["issues"] == [
        "sqlite_health_failed",
        "expired_running_leases",
        "missing_warc_files",
        "orphan_partial_warcs",
    ]
    assert report["checks"]["expired_running_leases"]["count"] == 1
    assert report["checks"]["missing_warc_files"]["count"] == 1
    assert report["checks"]["orphan_partial_warcs"]["count"] == 1
    assert "secret-token" not in rendered
    assert "secret.example" not in rendered


def test_doctor_cli_writes_atomic_failure_report(
    tmp_path: Path, monkeypatch: object, capsys: object
) -> None:
    archive = tmp_path / "archive.sqlite"
    warc_dir = tmp_path / "warc"
    output = tmp_path / "reports" / "doctor.json"
    warc_dir.mkdir()
    initialize_archive(archive)
    (warc_dir / "orphan.partial").write_bytes(b"partial")
    monkeypatch.setattr(
        sys,
        "argv",
        ["doctor", str(archive), "--warc-dir", str(warc_dir), "--output", str(output)],
    )

    assert main() == 2
    assert json.loads(output.read_text(encoding="utf-8"))["ok"] is False
    assert not output.with_name(f"{output.name}.partial").exists()
    assert json.loads(capsys.readouterr().out)["ok"] is False
