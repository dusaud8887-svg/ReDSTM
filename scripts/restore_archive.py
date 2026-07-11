from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from crawler.archive import archive_health
from scripts.backup_archive import _sha256, _table_counts
from scripts.healthcheck import notify_dead_man


def _load_expected_snapshot(manifest: Path) -> dict[str, Any]:
    report = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(report, dict) or report.get("format_version") != 1:
        raise ValueError("unsupported backup manifest")
    if report.get("ok") is not True or not isinstance(report.get("snapshot"), dict):
        raise ValueError("backup manifest does not describe a verified snapshot")

    snapshot = report["snapshot"]
    health = snapshot.get("health")
    counts = snapshot.get("counts")
    sha256 = snapshot.get("sha256")
    if (
        not isinstance(snapshot.get("bytes"), int)
        or not isinstance(sha256, str)
        or len(sha256) != 64
        or not isinstance(counts, dict)
        or not all(isinstance(key, str) and isinstance(value, int) for key, value in counts.items())
        or not isinstance(health, dict)
        or not isinstance(health.get("schema_version"), int)
        or not isinstance(health.get("application_id"), int)
        or not isinstance(health.get("quick_check"), list)
        or not isinstance(health.get("foreign_key_errors"), list)
    ):
        raise ValueError("backup manifest snapshot evidence is invalid")
    return snapshot


def _verify_restored(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    health = archive_health(path)
    evidence = {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "health": health,
        "counts": _table_counts(path),
    }
    expected_health = expected["health"]
    checks = {
        "bytes": evidence["bytes"] == expected["bytes"],
        "sha256": evidence["sha256"] == expected["sha256"],
        "table counts": evidence["counts"] == expected["counts"],
        "schema version": health["schema_version"] == expected_health["schema_version"],
        "application id": health["application_id"] == expected_health["application_id"],
        "quick check": health["quick_check"] == expected_health["quick_check"] == ["ok"],
        "foreign keys": [list(row) for row in health["foreign_key_errors"]]
        == expected_health["foreign_key_errors"]
        == [],
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise ValueError(f"restore verification failed: {', '.join(failed)}")
    return evidence


def restore_backup(snapshot: Path, manifest: Path, target: Path) -> dict[str, Any]:
    snapshot = snapshot.expanduser().resolve(strict=True)
    manifest = manifest.expanduser().resolve(strict=True)
    target = target.expanduser().resolve()
    partial = target.with_name(f"{target.name}.partial")
    if target.exists():
        raise FileExistsError("restore target already exists")
    if partial.exists():
        raise FileExistsError("partial restore target already exists")

    expected = _load_expected_snapshot(manifest)
    if snapshot.stat().st_size != expected["bytes"] or _sha256(snapshot) != expected["sha256"]:
        raise ValueError("snapshot does not match backup manifest")

    target.parent.mkdir(parents=True, exist_ok=True)
    created_partial = False
    try:
        created_partial = True
        shutil.copyfile(snapshot, partial)
        evidence = _verify_restored(partial, expected)
        if target.exists():
            raise FileExistsError("restore target appeared during restore")
        os.replace(partial, target)
        return {
            "format_version": 1,
            "restored_at": datetime.now(UTC).isoformat(),
            "ok": True,
            "target": {**evidence, "path": str(target)},
        }
    except Exception:
        if created_partial:
            partial.unlink(missing_ok=True)
        raise


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Restore and verify a canonical SQLite snapshot.")
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        report = restore_backup(args.snapshot, args.manifest, args.target)
        notify_dead_man(report["ok"] is True, os.environ.get("REDSTM_RESTORE_HEALTHCHECK_URL", ""))
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
