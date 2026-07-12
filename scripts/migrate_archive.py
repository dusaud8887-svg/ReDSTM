from __future__ import annotations

import argparse
import json
import os
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from crawler.archive import (
    SCHEMA_VERSION,
    archive_health,
    connect_archive,
    initialize_archive,
    require_archive_schema,
)


def migrate_archive(archive: Path, *, control_lock: Path) -> dict[str, Any]:
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
            with connect_archive(archive, read_only=True) as connection:
                before = int(connection.execute("PRAGMA user_version").fetchone()[0])
            initialize_archive(archive)
            require_archive_schema(archive)
            health = archive_health(archive)
    except Timeout as error:
        raise RuntimeError("archive migration lock is held") from error

    return {
        "ok": True,
        "before_schema_version": before,
        "schema_version": health["schema_version"],
        "target_schema_version": SCHEMA_VERSION,
        "quick_check": health["quick_check"],
        "foreign_key_errors": len(health["foreign_key_errors"]),
    }


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
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        report = migrate_archive(args.archive, control_lock=args.control_lock)
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
