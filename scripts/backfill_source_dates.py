from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from crawler.archive import archive_transaction
from scripts.legacy_common import normalize_source_timestamp


def backfill(connection: sqlite3.Connection, *, apply: bool = False) -> dict[str, object]:
    """Resolve source dates left NULL; a relative raw ("24시간 56분전") is anchored at the
    post's last collection, when that raw value was read. The next export reorders them."""
    resolved: list[tuple[str, int]] = []
    unresolved = 0
    for row in connection.execute(
        """SELECT id, created_at_raw, COALESCE(last_collected_at, last_seen_at) AS seen_at
           FROM posts WHERE created_at_source IS NULL AND created_at_raw IS NOT NULL"""
    ):
        value = normalize_source_timestamp(
            row["created_at_raw"], base=datetime.fromisoformat(str(row["seen_at"]))
        )
        if value is None:
            unresolved += 1
        else:
            resolved.append((value, int(row["id"])))
    if apply:
        connection.executemany(
            "UPDATE posts SET created_at_source = ? WHERE id = ? AND created_at_source IS NULL",
            resolved,
        )
    return {"applied": apply, "resolved": len(resolved), "unresolved": unresolved}


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve TypeMoon source dates left NULL.")
    parser.add_argument("--archive", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with archive_transaction(args.archive, read_only=not args.apply) as connection:
        report = backfill(connection, apply=args.apply)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
