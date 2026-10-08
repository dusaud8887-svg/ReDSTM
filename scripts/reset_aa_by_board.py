from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from crawler.archive import archive_transaction

# Only TypeMoon's AA boards are AA (user decision 2026-10-08); the spider no longer reads
# AA_Text classes or AA fonts in prose boards. This brings stored posts in line with it.
_AA_BOARD = r"board_id LIKE 'aa\_%' ESCAPE '\'"


def reset_aa(connection: sqlite3.Connection, *, apply: bool = False) -> dict[str, object]:
    """Set posts.is_aa from the board alone; the next export republishes changed posts."""
    changes = {
        str(row["board_id"]): {"to_aa": int(row["to_aa"]), "to_prose": int(row["to_prose"])}
        for row in connection.execute(
            f"""SELECT board_id,
                       SUM(is_aa = 0 AND {_AA_BOARD}) AS to_aa,
                       SUM(is_aa = 1 AND NOT {_AA_BOARD}) AS to_prose
                FROM posts GROUP BY board_id
                HAVING to_aa > 0 OR to_prose > 0 ORDER BY board_id"""
        )
    }
    if apply:
        connection.execute(f"UPDATE posts SET is_aa = ({_AA_BOARD}) WHERE is_aa != ({_AA_BOARD})")
    return {
        "applied": apply,
        "to_aa": sum(change["to_aa"] for change in changes.values()),
        "to_prose": sum(change["to_prose"] for change in changes.values()),
        "boards": changes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Set TypeMoon is_aa from the board only.")
    parser.add_argument("--archive", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with archive_transaction(args.archive, read_only=not args.apply) as connection:
        report = reset_aa(connection, apply=args.apply)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
