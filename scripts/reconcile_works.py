from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from crawler.archive import archive_transaction
from crawler.collections import (
    PostTitle,
    display_collection_title,
    parse_title,
    preview_collections,
)


def reconcile_board(
    connection: sqlite3.Connection, board_id: str, *, apply: bool = False
) -> dict[str, object]:
    """Append certain new chapters to existing collections without changing legacy IDs."""
    rows = list(
        connection.execute(
            """SELECT id, external_post_id, title, author, created_at_source, availability
               FROM posts WHERE board_id = ? AND availability != 'deleted'
               ORDER BY external_post_id""",
            (board_id,),
        )
    )
    post_ids = {int(row["external_post_id"]): int(row["id"]) for row in rows}
    available = {int(row["external_post_id"]) for row in rows if row["availability"] == "available"}
    preview = preview_collections(
        PostTitle(
            board_id,
            int(row["external_post_id"]),
            str(row["title"]),
            row["author"],
            row["created_at_source"],
        )
        for row in rows
    )
    collection_rows = list(
        connection.execute(
            """SELECT c.id AS collection_id, ce.position,
                      COALESCE(p.external_post_id, ce.source_external_post_id)
                          AS external_post_id
               FROM collections AS c
               JOIN collection_entries AS ce ON ce.collection_id = c.id
               LEFT JOIN posts AS p ON p.id = ce.post_id
               WHERE c.board_id = ? ORDER BY c.id, ce.position""",
            (board_id,),
        )
    )
    memberships: dict[int, set[int]] = defaultdict(set)
    positions: dict[int, int] = defaultdict(int)
    last_members: dict[int, int | None] = {}
    for row in collection_rows:
        collection_id = int(row["collection_id"])
        positions[collection_id] = max(positions[collection_id], int(row["position"]))
        external_post_id = row["external_post_id"]
        last_members[collection_id] = (
            int(external_post_id) if external_post_id is not None else None
        )
        if external_post_id is not None:
            memberships[int(external_post_id)].add(collection_id)

    proposed: list[tuple[int, int]] = []
    new_collections: list[tuple[str, list[int]]] = []
    titles = {
        str(row[0])
        for row in connection.execute(
            "SELECT title FROM collections WHERE board_id = ?", (board_id,)
        )
    }
    skipped: Counter[str] = Counter()
    for group in preview.groups:
        if any(not post.author or not post.author.strip() for post in group.posts):
            skipped["unknown_author"] += 1
            continue
        counts: Counter[int] = Counter(
            collection_id
            for post in group.posts
            for collection_id in memberships[post.external_post_id]
        )
        if not counts:
            title = display_collection_title(group)
            if title in titles or any(
                post.external_post_id not in available for post in group.posts
            ):
                skipped["new_collection_conflict"] += 1
                continue
            titles.add(title)
            new_collections.append((title, [post.external_post_id for post in group.posts]))
            continue
        if len(counts) != 1 or next(iter(counts.values()), 0) < 2:
            skipped["ambiguous_or_unanchored"] += 1
            continue
        collection_id = next(iter(counts))
        anchored = [
            post for post in group.posts if collection_id in memberships[post.external_post_id]
        ]
        if last_members[collection_id] != anchored[-1].external_post_id:
            skipped["last_entry_not_anchor"] += 1
            continue
        last_key = parse_title(anchored[-1].title).order_key
        assert last_key is not None
        new = [
            post
            for post in group.posts
            if post.external_post_id in available
            and not memberships[post.external_post_id]
            and (key := parse_title(post.title).order_key) is not None
            and key > last_key
        ]
        proposed.extend((collection_id, post.external_post_id) for post in new)

    if apply and (proposed or new_collections):
        now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        for title, external_post_ids in new_collections:
            cursor = connection.execute(
                """INSERT INTO collections (board_id,kind,title,created_at,updated_at)
                   VALUES (?, 'series', ?, ?, ?)""",
                (board_id, title, now, now),
            )
            connection.executemany(
                """INSERT INTO collection_entries
                   (collection_id,position,post_id,source_external_post_id)
                   VALUES (?,?,?,?)""",
                [
                    (cursor.lastrowid, position, post_ids[external_post_id], external_post_id)
                    for position, external_post_id in enumerate(external_post_ids, 1)
                ],
            )
        for collection_id, external_post_id in proposed:
            positions[collection_id] += 1
            connection.execute(
                """INSERT INTO collection_entries
                   (collection_id, position, post_id, source_external_post_id)
                   VALUES (?, ?, ?, ?)""",
                (
                    collection_id,
                    positions[collection_id],
                    post_ids[external_post_id],
                    external_post_id,
                ),
            )
            connection.execute(
                "UPDATE collections SET updated_at = ? WHERE id = ?", (now, collection_id)
            )
    return {
        "board_id": board_id,
        "proposed": len(proposed),
        "applied": len(proposed) if apply else 0,
        "new_collections": len(new_collections),
        "created_collections": len(new_collections) if apply else 0,
        "skipped": dict(sorted(skipped.items())),
        "changes": [
            {"collection_id": collection_id, "external_post_id": external_post_id}
            for collection_id, external_post_id in proposed
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Reconcile clear new TypeMoon chapters.")
    parser.add_argument("--archive", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--board", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with archive_transaction(args.archive, read_only=not args.apply) as connection:
        report = reconcile_board(connection, args.board, apply=args.apply)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
