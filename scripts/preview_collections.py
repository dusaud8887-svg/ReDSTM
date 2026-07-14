from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from crawler.archive import connect_archive
from crawler.collections import PostTitle, preview_collections


def preview(source: Path, board_id: str | None = None) -> dict[str, Any]:
    query = """
        SELECT board_id, external_post_id, title, author, created_at_source
        FROM posts
        WHERE availability != 'deleted'
    """
    parameters: tuple[str, ...] = ()
    if board_id:
        query += " AND board_id = ?"
        parameters = (board_id,)
    query += " ORDER BY board_id, external_post_id"
    with connect_archive(source, read_only=True) as connection:
        current = connection.execute(
            """
            SELECT COUNT(DISTINCT c.id), COUNT(ce.position)
            FROM collections AS c
            LEFT JOIN collection_entries AS ce ON ce.collection_id = c.id
            WHERE ? IS NULL OR c.board_id = ?
            """,
            (board_id, board_id),
        ).fetchone()
        result = preview_collections(
            PostTitle(
                board_id=str(row["board_id"]),
                external_post_id=int(row["external_post_id"]),
                title=str(row["title"]),
                author=row["author"],
                created_at_source=row["created_at_source"],
            )
            for row in connection.execute(query, parameters)
        )
    groups = sorted(
        result.groups,
        key=lambda group: (-len(group.posts), group.board_id, group.base_key),
    )
    return {
        "schema_version": 1,
        "algorithm": "exact-explicit-episode-v1",
        "board_id": board_id,
        "current": {"collections": int(current[0]), "entries": int(current[1])},
        "proposed": {
            "collections": len(groups),
            "entries": sum(len(group.posts) for group in groups),
            "parsed_posts": result.parsed_posts,
            "rejected": result.rejected,
        },
        "largest": [
            {
                "board_id": group.board_id,
                "base_key": group.base_key,
                "title": group.title,
                "entries": len(group.posts),
                "authors": len({post.author for post in group.posts if post.author}),
                "first_post_id": group.posts[0].external_post_id,
                "last_post_id": group.posts[-1].external_post_id,
            }
            for group in groups[:50]
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Preview high-precision work collections.")
    parser.add_argument("--source", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--board")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    body = json.dumps(preview(args.source, args.board), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(body, encoding="utf-8")
    else:
        print(body, end="")


if __name__ == "__main__":
    main()
