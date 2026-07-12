from __future__ import annotations

import argparse
import json
import os
import subprocess
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    RUNTIME_SCHEMA_POLICY,
    SCHEMA_VERSION,
    archive_health,
    connect_archive,
    initialize_archive,
    require_archive_schema,
)
from scripts.backup_archive import create_backup


def _release_schema_metadata(release: Path, *, runner: Any = subprocess.run) -> dict[str, object]:
    release = release.expanduser().resolve(strict=True)
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(release)
    result = runner(
        [
            str(release / ".venv/bin/python"),
            "-c",
            "import json; from crawler.archive import MIGRATIONS, RUNTIME_SCHEMA_POLICY, "
            "SCHEMA_VERSION; print(json.dumps({'schema_version': SCHEMA_VERSION, "
            "'schema_policy': RUNTIME_SCHEMA_POLICY, 'migrations': "
            "[[item.version, item.sha256] for item in MIGRATIONS]}))",
        ],
        cwd=release,
        env=environment,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        payload: object = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("release canonical migration metadata is invalid") from error
    if (
        not isinstance(payload, dict)
        or set(payload) != {"schema_version", "schema_policy", "migrations"}
        or type(payload["schema_version"]) is not int
        or not isinstance(payload["schema_policy"], str)
        or not isinstance(payload["migrations"], list)
        or not all(
            isinstance(item, list)
            and len(item) == 2
            and type(item[0]) is int
            and isinstance(item[1], str)
            for item in payload["migrations"]
        )
    ):
        raise RuntimeError("release canonical migration metadata is invalid")
    return payload


def validate_release_pair(current: Path, previous: Path, *, runner: Any = subprocess.run) -> None:
    current = current.expanduser().resolve(strict=True)
    previous = previous.expanduser().resolve(strict=True)
    if current == previous:
        raise RuntimeError("canonical migration requires two distinct compatible releases")
    expected = {
        "schema_version": SCHEMA_VERSION,
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
    }
    if (
        _release_schema_metadata(current, runner=runner) != expected
        or _release_schema_metadata(previous, runner=runner) != expected
    ):
        raise RuntimeError("current and previous releases are not schema-compatible")


def migration_source_version(archive: Path) -> int:
    archive = archive.expanduser().resolve(strict=True)
    with connect_archive(archive, read_only=True) as connection:
        if int(connection.execute("PRAGMA application_id").fetchone()[0]) != APPLICATION_ID:
            raise RuntimeError("canonical archive application id is invalid")
        user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        applied = {
            int(row["version"]): str(row["sha256"])
            for row in connection.execute("SELECT version, sha256 FROM schema_migrations")
        }
    known = {item.version: item.sha256 for item in MIGRATIONS}
    if (
        not 1 <= user_version <= SCHEMA_VERSION
        or set(applied) != set(range(1, user_version + 1))
        or any(known.get(version) != sha256 for version, sha256 in applied.items())
    ):
        raise RuntimeError("canonical migration ledger is incompatible")
    if user_version == SCHEMA_VERSION:
        require_archive_schema(archive)
    return user_version


def migrate_archive_locked(
    archive: Path,
    *,
    snapshot: Path | None,
    manifest: Path | None,
    current_release: Path | None = None,
    previous_release: Path | None = None,
) -> dict[str, Any]:
    archive = archive.expanduser().resolve(strict=True)
    if (current_release is None) != (previous_release is None):
        raise ValueError("current and previous releases must be provided together")
    if current_release is not None and previous_release is not None:
        validate_release_pair(current_release, previous_release)
    before = migration_source_version(archive)
    backup: dict[str, Any] | None = None
    if before < SCHEMA_VERSION:
        if snapshot is None or manifest is None:
            raise ValueError("snapshot and manifest are required before schema migration")
        backup = create_backup(archive, snapshot, manifest)
        initialize_archive(archive)
        require_archive_schema(archive)
    health = archive_health(archive)
    if health["quick_check"] != ["ok"] or health["foreign_key_errors"]:
        raise RuntimeError("migrated canonical archive failed health validation")
    return {
        "ok": True,
        "before_schema_version": before,
        "schema_version": health["schema_version"],
        "target_schema_version": SCHEMA_VERSION,
        "quick_check": health["quick_check"],
        "foreign_key_errors": len(health["foreign_key_errors"]),
        "snapshot": (
            {
                "bytes": backup["snapshot"]["bytes"],
                "sha256": backup["snapshot"]["sha256"],
            }
            if backup is not None
            else None
        ),
    }


def migrate_archive(
    archive: Path,
    *,
    control_lock: Path,
    snapshot: Path | None = None,
    manifest: Path | None = None,
) -> dict[str, Any]:
    archive = archive.expanduser().resolve(strict=True)
    control_lock = control_lock.expanduser().resolve()
    try:
        with ExitStack() as locks:
            for lock_path in (
                control_lock,
                Path(f"{archive}.cycle.lock"),
                Path(f"{archive}.sync.lock"),
            ):
                locks.enter_context(FileLock(str(lock_path), timeout=0))
            return migrate_archive_locked(
                archive,
                snapshot=snapshot,
                manifest=manifest,
            )
    except Timeout as error:
        raise RuntimeError("archive migration lock is held") from error

    raise AssertionError("unreachable")


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f".{path.name}.partial")
    try:
        partial.write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Explicitly migrate one locked ReDSTM canonical archive."
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--control-lock",
        type=Path,
        default=Path("/srv/redstm/state/control.lock"),
    )
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        report = migrate_archive(
            args.archive,
            control_lock=args.control_lock,
            snapshot=args.snapshot,
            manifest=args.manifest,
        )
    except (OSError, RuntimeError, ValueError) as error:
        report = {"ok": False, "error": type(error).__name__, "message": str(error)}
        if args.output is not None:
            _write_report(args.output, report)
        print(json.dumps(report, ensure_ascii=False))
        return 1
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
