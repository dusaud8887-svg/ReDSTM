from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

_HASH_CHUNK_SIZE = 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(_HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _pragma_value(connection: sqlite3.Connection, name: str) -> Any:
    row = connection.execute(f"PRAGMA {name}").fetchone()
    return None if row is None else row[0]


def _table_counts(connection: sqlite3.Connection, table_names: list[str]) -> dict[str, Any]:
    counts: dict[str, Any] = {}
    for table_name in table_names:
        try:
            row = connection.execute(
                f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}"
            ).fetchone()
            counts[table_name] = None if row is None else row[0]
        except sqlite3.DatabaseError as exc:
            counts[table_name] = {"error": str(exc)}
    return counts


def _dbstat_sizes(connection: sqlite3.Connection) -> dict[str, Any]:
    try:
        rows = connection.execute(
            "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC"
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        return {"available": False, "error": str(exc), "objects": {}}

    return {
        "available": True,
        "objects": {str(name): int(size) for name, size in rows},
    }


def profile_database(path: Path, *, include_counts: bool = False) -> dict[str, Any]:
    database_path = path.expanduser().resolve(strict=True)
    if not database_path.is_file():
        raise FileNotFoundError(f"not a file: {database_path}")

    stat = database_path.stat()
    uri = f"{database_path.as_uri()}?mode=ro&immutable=1"

    with sqlite3.connect(uri, uri=True) as connection:
        schema_rows = connection.execute(
            """
            SELECT type, name, tbl_name, sql
            FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        ).fetchall()
        table_names = [
            str(name) for object_type, name, _, _ in schema_rows if object_type == "table"
        ]
        quick_check = [str(row[0]) for row in connection.execute("PRAGMA quick_check")]

        profile: dict[str, Any] = {
            "path": str(database_path),
            "file": {
                "size_bytes": stat.st_size,
                "modified_utc_ns": stat.st_mtime_ns,
                "sha256": _sha256(database_path),
                "wal_exists": Path(f"{database_path}-wal").exists(),
                "shm_exists": Path(f"{database_path}-shm").exists(),
            },
            "sqlite": {
                "runtime_version": sqlite3.sqlite_version,
                "database_version": connection.execute("SELECT sqlite_version()").fetchone()[0],
                "quick_check": quick_check,
                "page_size": _pragma_value(connection, "page_size"),
                "page_count": _pragma_value(connection, "page_count"),
                "freelist_count": _pragma_value(connection, "freelist_count"),
                "journal_mode": _pragma_value(connection, "journal_mode"),
                "user_version": _pragma_value(connection, "user_version"),
            },
            "schema": [
                {
                    "type": object_type,
                    "name": name,
                    "table": table_name,
                    "sql": sql,
                }
                for object_type, name, table_name, sql in schema_rows
            ],
            "dbstat": _dbstat_sizes(connection),
            "table_counts": _table_counts(connection, table_names) if include_counts else None,
        }

    return profile


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Profile a SQLite copy without modifying it.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--counts", action="store_true", help="Run full COUNT(*) scans.")
    parser.add_argument("--output", type=Path, help="Write JSON to this path instead of stdout.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    profile = profile_database(args.database, include_counts=args.counts)
    rendered = json.dumps(profile, ensure_ascii=False, indent=2) + "\n"

    if args.output is None:
        print(rendered, end="")
    else:
        output_path = args.output.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
        temporary_path.write_text(rendered, encoding="utf-8")
        temporary_path.replace(output_path)

    return 0 if profile["sqlite"]["quick_check"] == ["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
