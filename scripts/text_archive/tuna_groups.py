"""Correct how Tunaground threads are grouped into works (docs/34 §5).

The title rule groups threads by trip and title stem. When it joins two works or splits one,
an operator pins a thread here instead of changing the rule for everyone:

    python -m scripts.text_archive.tuna_groups merge 14690 --into 14012
    python -m scripts.text_archive.tuna_groups split 14690
    python -m scripts.text_archive.tuna_groups auto 14690      # back to the title rule
    python -m scripts.text_archive.tuna_groups list

The next publish lists the new grouping; a work key that disappears stays an alias of its
successor, so 나중에 읽기 and 분류 made on the old work keep opening it.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from scripts.text_archive import tuna
from scripts.text_archive.importer import _connect

_DB_PATH = Path("/srv/redstm-text/text-archive.sqlite")


def main(argv: list[str] | None = None, db_path: Path = _DB_PATH) -> int:
    parser = argparse.ArgumentParser(description="Pin Tunaground threads to works")
    commands = parser.add_subparsers(dest="command", required=True)
    merge = commands.add_parser("merge", help="put a thread in another thread's work")
    merge.add_argument("thread", type=int)
    merge.add_argument("--into", type=int, required=True, metavar="THREAD")
    commands.add_parser("split", help="give a thread a work of its own").add_argument(
        "thread", type=int
    )
    commands.add_parser("auto", help="let the title rule group the thread again").add_argument(
        "thread", type=int
    )
    commands.add_parser("list", help="show pinned threads and work aliases")
    args = parser.parse_args(argv)
    db = _connect(db_path)
    try:
        db.executescript(tuna._SCHEMA)
        report: dict[str, Any]
        if args.command == "list":
            report = {
                "pinned": [
                    dict(row)
                    for row in db.execute(
                        "SELECT thread_id,series_key,series_title,set_at "
                        "FROM text_tuna_series_overrides ORDER BY thread_id"
                    )
                ],
                "aliases": [
                    dict(row)
                    for row in db.execute(
                        "SELECT old_key,new_key,recorded_at FROM text_tuna_work_aliases "
                        "ORDER BY old_key"
                    )
                ],
            }
        else:
            key = tuna.regroup(
                db,
                args.thread,
                into=args.into if args.command == "merge" else None,
                split=args.command == "split",
            )
            report = {"thread": args.thread, "work_id": f"tuna:{key}"}
    except tuna.TunaError as exc:
        parser.exit(2, f"{exc}\n")
    finally:
        db.close()
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
