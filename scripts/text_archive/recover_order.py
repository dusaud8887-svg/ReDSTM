"""Apply verified source reading positions exported from Newtomi's complete task lists.

`--numbers-only` instead fills missing episode numbers read from explicit chapter labels.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
from contextlib import closing, nullcontext
from pathlib import Path

from scripts.text_archive.runtime import operation_window


def recover(db_path: Path, plan_path: Path, *, backup: Path | None = None) -> dict[str, int]:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if (
        not isinstance(plan, dict)
        or plan.get("schema") != 1
        or not isinstance(plan.get("works"), list)
    ):
        raise ValueError("invalid plan")
    rows: list[tuple[int, str, str, str, str, float | None]] = []
    works: set[tuple[str, str]] = set()
    for work in plan["works"]:
        site, work_id = work["site"], work["work_id"]
        group, items = work["order_group"], work["items"]
        key = (site, work_id)
        if (
            not isinstance(site, str)
            or not site.isascii()
            or not site.isalpha()
            or not isinstance(work_id, str)
            or not work_id.isdigit()
            or not isinstance(group, str)
            or re.fullmatch(r"[a-f0-9]{32}", group) is None
            or key in works
            or not isinstance(items, list)
            or not items
        ):
            raise ValueError("invalid work")
        works.add(key)
        ids: set[str] = set()
        positions: set[int] = set()
        for item in items:
            chapter, position = item["chapter_id"], item["position"]
            number = item.get("episode_number")
            if (
                not isinstance(chapter, str)
                or not chapter.isdigit()
                or chapter in ids
                or type(position) is not int
                or position < 0
                or position in positions
                or (
                    number is not None
                    and (
                        type(number) not in (int, float)
                        or not 0 < number <= 1_000_000_000_000
                        or not math.isfinite(number)
                    )
                )
            ):
                raise ValueError("invalid chapter")
            ids.add(chapter)
            positions.add(position)
            rows.append((position, group, site, work_id, chapter, number))

    mode = "rw" if backup else "ro"
    with (
        operation_window(exclusive=True, need_bytes=150 * 1024 * 1024) if backup else nullcontext()
    ):
        with closing(sqlite3.connect(f"file:{db_path}?mode={mode}", uri=True, timeout=30)) as db:
            if backup:
                if backup.exists():
                    raise FileExistsError(backup)
                with closing(sqlite3.connect(backup)) as copy:
                    db.backup(copy)
                    if copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise ValueError("backup integrity check failed")
            columns = {row[1] for row in db.execute("PRAGMA table_info(text_novel_chapters)")}
            if backup:
                db.execute("BEGIN IMMEDIATE")
                if "source_reading_position" not in columns:
                    db.execute(
                        "ALTER TABLE text_novel_chapters ADD COLUMN source_reading_position INTEGER"
                    )
                    columns.add("source_reading_position")
                if "source_order_group" not in columns:
                    db.execute("ALTER TABLE text_novel_chapters ADD COLUMN source_order_group TEXT")
                    columns.add("source_order_group")
            position_col = (
                "source_reading_position" if "source_reading_position" in columns else "NULL"
            )
            group_col = "source_order_group" if "source_order_group" in columns else "NULL"
            found = changed = 0
            for position, group, site, work_id, chapter, number in rows:
                row = db.execute(
                    f"SELECT {position_col},{group_col},source_episode_number_normalized "
                    "FROM text_novel_chapters "
                    "WHERE site=? AND source_work_id=? AND source_chapter_id=?",
                    (site, work_id, chapter),
                ).fetchone()
                if row is None:
                    continue
                found += 1
                if (
                    (row[0] is not None and row[0] != position)
                    or (row[1] and row[1] != group)
                    or (number is not None and row[2] is not None and row[2] != number)
                ):
                    raise ValueError(f"conflicting position for {site}:{work_id}:{chapter}")
                if row[0] is None or row[1] is None or (number is not None and row[2] is None):
                    changed += 1
                    if backup:
                        db.execute(
                            "UPDATE text_novel_chapters SET source_reading_position=?,"
                            "source_order_group=?,source_episode_number_normalized="
                            "COALESCE(source_episode_number_normalized,?),"
                            "source_episode_number_raw=COALESCE(source_episode_number_raw,?) "
                            "WHERE site=? AND source_work_id=? AND source_chapter_id=?",
                            (
                                position,
                                group,
                                number,
                                str(number) if number is not None else None,
                                site,
                                work_id,
                                chapter,
                            ),
                        )
            if backup:
                db.commit()
            return {"works": len(works), "planned": len(rows), "found": found, "changed": changed}


def recover_numbers(
    db_path: Path, plan_path: Path, *, backup: Path | None = None
) -> dict[str, int]:
    """Fill missing source episode numbers read from explicit Newtomi labels.

    Only empty numbers are filled; a number the source list already gave is kept and counted.
    """
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict) or plan.get("schema") != "episode_numbers/1":
        raise ValueError("invalid plan")
    rows: list[tuple[str, str, str, float]] = []
    keys: set[tuple[str, str, str]] = set()
    for item in plan.get("items") or []:
        site, work_id, chapter, number = item
        if (
            not isinstance(site, str)
            or not site.isascii()
            or not site.isalpha()
            or not isinstance(work_id, str)
            or not work_id.isdigit()
            or not isinstance(chapter, str)
            or not chapter.isdigit()
            or (site, work_id, chapter) in keys
            or type(number) not in (int, float)
            or not math.isfinite(number)
            or not 0 < number <= 1_000_000_000_000
        ):
            raise ValueError("invalid chapter")
        keys.add((site, work_id, chapter))
        rows.append((site, work_id, chapter, number))

    mode = "rw" if backup else "ro"
    with (
        operation_window(exclusive=True, need_bytes=150 * 1024 * 1024) if backup else nullcontext()
    ):
        with closing(sqlite3.connect(f"file:{db_path}?mode={mode}", uri=True, timeout=30)) as db:
            if backup:
                if backup.exists():
                    raise FileExistsError(backup)
                with closing(sqlite3.connect(backup)) as copy:
                    db.backup(copy)
                    if copy.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise ValueError("backup integrity check failed")
                db.execute("BEGIN IMMEDIATE")
            found = changed = same = kept = 0
            for site, work_id, chapter, number in rows:
                row = db.execute(
                    "SELECT source_episode_number_normalized FROM text_novel_chapters "
                    "WHERE site=? AND source_work_id=? AND source_chapter_id=?",
                    (site, work_id, chapter),
                ).fetchone()
                if row is None:
                    continue
                found += 1
                if row[0] is not None:
                    if row[0] == number:
                        same += 1
                    else:
                        kept += 1
                    continue
                changed += 1
                if backup:
                    db.execute(
                        "UPDATE text_novel_chapters SET source_episode_number_normalized=?,"
                        "source_episode_number_raw=COALESCE(source_episode_number_raw,?) "
                        "WHERE site=? AND source_work_id=? AND source_chapter_id=? "
                        "AND source_episode_number_normalized IS NULL",
                        (number, f"{number:g}", site, work_id, chapter),
                    )
            if backup:
                db.commit()
            return {
                "planned": len(rows), "found": found, "changed": changed,
                "same": same, "kept_existing": kept,
            }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--backup", type=Path, help="apply after creating this new SQLite backup")
    parser.add_argument(
        "--numbers-only", action="store_true", help="plan is an episode_numbers/1 export"
    )
    args = parser.parse_args()
    apply = recover_numbers if args.numbers_only else recover
    print(json.dumps(apply(args.db, args.plan, backup=args.backup)))


if __name__ == "__main__":
    main()
