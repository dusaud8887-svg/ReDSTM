from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from crawler.archive import archive_health, connect_archive
from scripts.healthcheck import notify_dead_man


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 << 20):
            digest.update(block)
    return digest.hexdigest()


def _sync_file(path: Path) -> None:
    with path.open("rb+") as stream:
        os.fsync(stream.fileno())


def _sync_directory(path: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _table_counts(path: Path) -> dict[str, int]:
    with closing(connect_archive(path, read_only=True)) as connection:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_schema "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        return {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in tables
        }


def _evidence(path: Path, *, check_health: bool) -> dict[str, Any]:
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "health": archive_health(path) if check_health else None,
        "counts": _table_counts(path),
    }


def create_backup(
    source: Path, snapshot: Path, manifest: Path, *, resume_partial: bool = False
) -> dict[str, Any]:
    source = source.expanduser().resolve(strict=True)
    snapshot = snapshot.expanduser().resolve()
    manifest = manifest.expanduser().resolve()
    if source == snapshot:
        raise ValueError("source and snapshot must differ")
    if snapshot.exists() or manifest.exists():
        raise FileExistsError("snapshot and manifest must not already exist")

    snapshot.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    snapshot_partial = snapshot.with_name(f"{snapshot.name}.partial")
    manifest_partial = manifest.with_name(f"{manifest.name}.partial")
    if manifest_partial.exists():
        raise FileExistsError("partial backup output already exists")
    if resume_partial and not snapshot_partial.exists():
        raise FileNotFoundError("snapshot partial does not exist")
    if not resume_partial and snapshot_partial.exists():
        raise FileExistsError("partial backup output already exists")

    try:
        if not resume_partial:
            with (
                closing(connect_archive(source, read_only=True)) as source_connection,
                closing(sqlite3.connect(snapshot_partial)) as snapshot_connection,
            ):
                source_connection.backup(snapshot_connection, pages=4096, sleep=0.05)

        source_evidence = _evidence(source, check_health=False)
        snapshot_evidence = _evidence(snapshot_partial, check_health=True)
        issues: list[str] = []
        if source_evidence["counts"] != snapshot_evidence["counts"]:
            issues.append("table counts differ")
        if snapshot_evidence["health"]["quick_check"] != ["ok"]:
            issues.append("snapshot quick_check failed")
        if snapshot_evidence["health"]["foreign_key_errors"]:
            issues.append("snapshot foreign_key_check failed")

        report = {
            "format_version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "ok": not issues,
            "issues": issues,
            "source": source_evidence,
            "snapshot": {**snapshot_evidence, "path": str(snapshot)},
        }
        manifest_partial.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        if issues:
            raise RuntimeError(f"backup verification failed: {', '.join(issues)}")

        _sync_file(snapshot_partial)
        _sync_file(manifest_partial)
        os.replace(snapshot_partial, snapshot)
        _sync_directory(snapshot.parent)
        os.replace(manifest_partial, manifest)
        _sync_directory(manifest.parent)
        return report
    except Exception:
        if not resume_partial:
            snapshot_partial.unlink(missing_ok=True)
        manifest_partial.unlink(missing_ok=True)
        raise


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and verify a canonical SQLite snapshot.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--resume-partial", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = create_backup(
        args.source, args.snapshot, args.manifest, resume_partial=args.resume_partial
    )
    notify_dead_man(report["ok"] is True, os.environ.get("REDSTM_BACKUP_HEALTHCHECK_URL", ""))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
