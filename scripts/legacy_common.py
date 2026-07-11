from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from crawler.pipelines import NormalizedPost, normalize_captured_post

_KST = timezone(timedelta(hours=9))
_DATE_FORMATS = (
    "%Y.%m.%d %H:%M:%S",
    "%Y.%m.%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y.%m.%d",
    "%Y-%m-%d",
)
_EMPTY_COMMENT = re.compile(r"comment (\d+) is empty after sanitizing")
_EMPTY_LEGACY_COMMENT = "<p>[Unavailable legacy comment]</p>"


def build_legacy_post_item(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> tuple[dict[str, Any], str]:
    board_id = str(row["board_id"])
    external_post_id = int(row["id"])
    comment_rows = connection.execute(
        """
        SELECT id, author, content, created_at, parent_id, depth
        FROM comments
        WHERE post_id = ? AND board_id = ?
        ORDER BY id
        """,
        (external_post_id, board_id),
    ).fetchall()
    positions = {
        int(comment["id"]): position for position, comment in enumerate(comment_rows, start=1)
    }
    comments = [
        {
            "position": position,
            "source_comment_id": str(comment["id"]),
            "parent_position": (
                positions.get(int(comment["parent_id"]))
                if comment["parent_id"] is not None
                else None
            ),
            "depth": int(comment["depth"] or 0),
            "author": comment["author"],
            "content_html": comment["content"],
            "created_at_raw": comment["created_at"],
        }
        for position, comment in enumerate(comment_rows, start=1)
    ]
    captured_at = normalize_source_timestamp(row["crawled_at"]) or datetime.now(UTC).isoformat(
        timespec="seconds"
    )
    return (
        {
            "board_id": board_id,
            "external_post_id": external_post_id,
            "canonical_url": f"https://www.typemoon.net/{board_id}/{external_post_id}",
            "outcome": "stored",
            "title": row["title"],
            "author": row["author"],
            "category": row["category"],
            "created_at_raw": row["created_at"],
            "views": int(row["views"] or 0),
            "body_html": row["content_html"],
            "is_aa": bool(row["is_aa"]),
            "comments": comments,
        },
        captured_at,
    )


def normalize_legacy_post(item: dict[str, Any]) -> tuple[NormalizedPost, int]:
    replacements = 0
    while True:
        try:
            return normalize_captured_post(item), replacements
        except ValueError as error:
            match = _EMPTY_COMMENT.fullmatch(str(error))
            if match is None:
                raise
            comments = item["comments"]
            assert isinstance(comments, list)
            comment = comments[int(match.group(1)) - 1]
            assert isinstance(comment, dict)
            comment["content_html"] = _EMPTY_LEGACY_COMMENT
            replacements += 1


def normalize_source_timestamp(value: object) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    if not rendered:
        return None
    try:
        parsed = datetime.fromisoformat(rendered)
    except ValueError:
        parsed = None
    if parsed is None:
        for date_format in _DATE_FORMATS:
            try:
                parsed = datetime.strptime(rendered, date_format)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_KST)
    return parsed.astimezone(UTC).isoformat(timespec="seconds")
