from __future__ import annotations

import argparse
import json
import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from crawler.archive import APPLICATION_ID, SCHEMA_VERSION, archive_health, connect_archive


def _warc_path(value: str, warc_dir: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else warc_dir / path


def inspect_archive(
    archive: Path, warc_dir: Path, *, now: datetime | None = None
) -> dict[str, Any]:
    archive = archive.expanduser().resolve()
    warc_dir = warc_dir.expanduser().resolve()
    checked_at = (now or datetime.now(UTC)).astimezone(UTC)
    issues: list[str] = []

    try:
        health = archive_health(archive)
        health_ok = (
            health["quick_check"] == ["ok"]
            and not health["foreign_key_errors"]
            and health["schema_version"] == SCHEMA_VERSION
            and health["application_id"] == APPLICATION_ID
        )
        if not health_ok:
            issues.append("sqlite_health_failed")

        with closing(connect_archive(archive, read_only=True)) as connection:
            expired_leases = [
                {
                    "board_id": str(row["board_id"]),
                    "external_post_id": int(row["external_post_id"]),
                    "lease_expires_at": str(row["lease_expires_at"]),
                }
                for row in connection.execute(
                    """
                    SELECT board_id, external_post_id, lease_expires_at
                    FROM crawl_frontier
                    WHERE state = 'running'
                      AND julianday(lease_expires_at) <= julianday(?)
                    ORDER BY board_id, external_post_id
                    """,
                    (checked_at.isoformat(timespec="seconds"),),
                )
            ]
            missing_warcs = [
                {"capture_id": int(row["id"]), "warc_file": str(row["warc_file"])}
                for row in connection.execute(
                    """
                    SELECT id, warc_file FROM captures
                    WHERE warc_file IS NOT NULL
                    ORDER BY id
                    """
                )
                if not _warc_path(str(row["warc_file"]), warc_dir).is_file()
            ]
    except sqlite3.Error:
        health = {"error": "sqlite_error"}
        health_ok = False
        expired_leases = []
        missing_warcs = []
        issues.append("sqlite_health_failed")

    orphan_partials = [
        str(path.relative_to(warc_dir)) for path in sorted(warc_dir.rglob("*.partial"))
    ]
    if expired_leases:
        issues.append("expired_running_leases")
    if missing_warcs:
        issues.append("missing_warc_files")
    if orphan_partials:
        issues.append("orphan_partial_warcs")

    return {
        "format_version": 1,
        "checked_at": checked_at.isoformat(timespec="seconds"),
        "ok": not issues,
        "issues": issues,
        "checks": {
            "sqlite_health": {"ok": health_ok, "details": health},
            "expired_running_leases": {
                "ok": not expired_leases,
                "count": len(expired_leases),
                "items": expired_leases,
            },
            "missing_warc_files": {
                "ok": not missing_warcs,
                "count": len(missing_warcs),
                "items": missing_warcs,
            },
            "orphan_partial_warcs": {
                "ok": not orphan_partials,
                "count": len(orphan_partials),
                "items": orphan_partials,
            },
        },
    }


def _write_report(path: Path, rendered: str) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.partial")
    try:
        partial.write_text(rendered, encoding="utf-8")
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only canonical archive health check.")
    parser.add_argument("archive", type=Path)
    parser.add_argument("--warc-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = inspect_archive(args.archive, args.warc_dir)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        _write_report(args.output, rendered)
    print(rendered, end="")
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
