from __future__ import annotations

import json
import sqlite3
from itertools import groupby

from scripts.legacy_common import normalize_legacy_post, normalize_source_timestamp


def _post_map(connection: sqlite3.Connection) -> dict[tuple[str, int], int]:
    return {
        (str(row["board_id"]), int(row["external_post_id"])): int(row["id"])
        for row in connection.execute("SELECT id, board_id, external_post_id FROM posts")
    }


def _placeholder_post(
    target: sqlite3.Connection,
    post_ids: dict[tuple[str, int], int],
    *,
    board_id: str,
    external_post_id: int,
    title: str | None,
    imported_at: str,
) -> int:
    key = (board_id, external_post_id)
    existing = post_ids.get(key)
    if existing is not None:
        return existing
    target.execute(
        """
        INSERT INTO posts (
            board_id, external_post_id, canonical_url, title, first_seen_at,
            last_seen_at, availability
        ) VALUES (?, ?, ?, ?, ?, ?, 'missing')
        ON CONFLICT (board_id, external_post_id) DO NOTHING
        """,
        (
            board_id,
            external_post_id,
            f"https://www.typemoon.net/{board_id}/{external_post_id}",
            title or f"Unavailable legacy post {external_post_id}",
            imported_at,
            imported_at,
        ),
    )
    row = target.execute(
        "SELECT id FROM posts WHERE board_id = ? AND external_post_id = ?",
        key,
    ).fetchone()
    assert row is not None
    post_id = int(row["id"])
    post_ids[key] = post_id
    return post_id


def _json_value(value: object) -> str:
    rendered = "" if value is None else str(value)
    try:
        parsed = json.loads(rendered)
    except json.JSONDecodeError:
        parsed = rendered
    return json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))


def _import_orphan_comments(
    source: sqlite3.Connection,
    target: sqlite3.Connection,
    post_ids: dict[tuple[str, int], int],
    *,
    imported_at: str,
) -> int:
    source.execute("DROP TABLE IF EXISTS temp.redstm_orphan_comment_ids")
    source.execute(
        "CREATE TEMP TABLE redstm_orphan_comment_ids (id INTEGER PRIMARY KEY) WITHOUT ROWID"
    )
    identities = source.execute("SELECT id, post_id, board_id FROM comments ORDER BY rowid")
    while batch := identities.fetchmany(10_000):
        source.executemany(
            "INSERT INTO redstm_orphan_comment_ids (id) VALUES (?)",
            [
                (int(row["id"]),)
                for row in batch
                if (str(row["board_id"]), int(row["post_id"])) not in post_ids
            ],
        )
    rows = source.execute(
        """
        SELECT c.id, c.post_id, c.board_id, c.author, c.content,
               c.created_at, c.parent_id, c.depth
        FROM comments AS c
        JOIN redstm_orphan_comment_ids AS orphan ON orphan.id = c.id
        ORDER BY c.board_id, c.post_id, c.id
        """
    )
    imported = 0
    for (board_id, external_post_id), group in groupby(
        rows, key=lambda row: (str(row["board_id"]), int(row["post_id"]))
    ):
        comment_rows = list(group)
        positions = {int(row["id"]): position for position, row in enumerate(comment_rows, start=1)}
        normalized, _ = normalize_legacy_post(
            {
                "board_id": board_id,
                "external_post_id": external_post_id,
                "canonical_url": f"https://www.typemoon.net/{board_id}/{external_post_id}",
                "outcome": "stored",
                "title": f"Unavailable legacy post {external_post_id}",
                "body_html": "<p>Unavailable legacy post</p>",
                "comments": [
                    {
                        "position": position,
                        "source_comment_id": str(row["id"]),
                        "parent_position": (
                            positions.get(int(row["parent_id"]))
                            if row["parent_id"] is not None
                            else None
                        ),
                        "depth": int(row["depth"] or 0),
                        "author": row["author"],
                        "content_html": row["content"],
                        "created_at_raw": row["created_at"],
                    }
                    for position, row in enumerate(comment_rows, start=1)
                ],
            }
        )
        post_id = _placeholder_post(
            target,
            post_ids,
            board_id=board_id,
            external_post_id=external_post_id,
            title=None,
            imported_at=imported_at,
        )
        target.execute("DELETE FROM comments WHERE post_id = ?", (post_id,))
        target.executemany(
            """
            INSERT INTO comments (
                post_id, position, source_comment_id, author, content_html, content_text,
                created_at_source, created_at_raw, parent_position, depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    post_id,
                    comment.position,
                    comment.source_comment_id,
                    comment.author,
                    comment.content_html,
                    comment.content_text,
                    normalize_source_timestamp(comment.created_at_raw),
                    comment.created_at_raw,
                    comment.parent_position,
                    comment.depth,
                )
                for comment in normalized.comments
            ],
        )
        target.execute(
            "UPDATE posts SET comment_count = ? WHERE id = ?",
            (len(normalized.comments), post_id),
        )
        imported += len(normalized.comments)
    return imported


def import_auxiliary(
    source: sqlite3.Connection,
    target: sqlite3.Connection,
    *,
    imported_at: str,
) -> dict[str, int]:
    post_ids = _post_map(target)
    initial_post_count = len(post_ids)

    orphan_comment_count = _import_orphan_comments(
        source, target, post_ids, imported_at=imported_at
    )

    collection_count = 0
    for row in source.execute(
        """
        SELECT id, board_id, collection_type, title, created_at, updated_at
        FROM collections ORDER BY id
        """
    ):
        created_at = normalize_source_timestamp(row["created_at"]) or imported_at
        updated_at = normalize_source_timestamp(row["updated_at"]) or created_at
        target.execute(
            """
            INSERT INTO collections (id, board_id, kind, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
                board_id = excluded.board_id,
                kind = excluded.kind,
                title = excluded.title,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            """,
            (
                int(row["id"]),
                str(row["board_id"]),
                str(row["collection_type"]),
                str(row["title"]),
                created_at,
                updated_at,
            ),
        )
        target.execute("DELETE FROM collection_entries WHERE collection_id = ?", (row["id"],))
        collection_count += 1

    entry_count = 0
    positions: dict[int, int] = {}
    for row in source.execute(
        """
        SELECT collection_id, post_id, board_id, episode_number, id
        FROM collection_episodes
        ORDER BY collection_id, COALESCE(episode_number, id), id
        """
    ):
        collection_id = int(row["collection_id"])
        position = positions.get(collection_id, 0) + 1
        positions[collection_id] = position
        external_post_id = int(row["post_id"])
        post_id = _placeholder_post(
            target,
            post_ids,
            board_id=str(row["board_id"]),
            external_post_id=external_post_id,
            title=None,
            imported_at=imported_at,
        )
        target.execute(
            """
            INSERT INTO collection_entries (
                collection_id, position, post_id, source_external_post_id
            ) VALUES (?, ?, ?, ?)
            """,
            (collection_id, position, post_id, external_post_id),
        )
        entry_count += 1

    bookmark_count = 0
    for row in source.execute(
        """
        SELECT post_id, board_id, title, note, tags, created_at
        FROM bookmarks ORDER BY id
        """
    ):
        post_id = _placeholder_post(
            target,
            post_ids,
            board_id=str(row["board_id"]),
            external_post_id=int(row["post_id"]),
            title=str(row["title"]),
            imported_at=imported_at,
        )
        target.execute(
            """
            INSERT INTO bookmarks (post_id, note, tags_json, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (post_id) DO UPDATE SET
                note = excluded.note,
                tags_json = excluded.tags_json,
                created_at = excluded.created_at
            """,
            (
                post_id,
                row["note"],
                _json_value(row["tags"] or "[]"),
                normalize_source_timestamp(row["created_at"]) or imported_at,
            ),
        )
        bookmark_count += 1

    reading_count = 0
    for row in source.execute(
        """
        SELECT post_id, board_id, post_title, read_at, scroll_position
        FROM reading_history ORDER BY id
        """
    ):
        post_id = _placeholder_post(
            target,
            post_ids,
            board_id=str(row["board_id"]),
            external_post_id=int(row["post_id"]),
            title=row["post_title"],
            imported_at=imported_at,
        )
        target.execute(
            """
            INSERT INTO reading_progress (post_id, read_at, scroll_position)
            VALUES (?, ?, ?)
            ON CONFLICT (post_id) DO UPDATE SET
                read_at = excluded.read_at,
                scroll_position = excluded.scroll_position
            """,
            (
                post_id,
                normalize_source_timestamp(row["read_at"]) or imported_at,
                max(0.0, float(row["scroll_position"] or 0)),
            ),
        )
        reading_count += 1

    setting_count = 0
    for row in source.execute("SELECT key, value, updated_at FROM settings ORDER BY key"):
        target.execute(
            """
            INSERT INTO settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (
                str(row["key"]),
                _json_value(row["value"]),
                normalize_source_timestamp(row["updated_at"]) or imported_at,
            ),
        )
        setting_count += 1

    frontier_count = 0
    state_map = {"completed": "done", "failed": "retry", "auth_blocked": "dead"}
    for row in source.execute(
        """
        SELECT id, board_id, priority, status, retry_count, last_error,
               last_attempt_at
        FROM post_queue ORDER BY board_id, id
        """
    ):
        board_id = str(row["board_id"])
        external_post_id = int(row["id"])
        state = state_map.get(str(row["status"]), "pending")
        target.execute(
            """
            INSERT INTO crawl_frontier (
                board_id, external_post_id, url, priority, state, attempts,
                last_error_code, last_attempt_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                url = excluded.url,
                priority = excluded.priority,
                state = excluded.state,
                attempts = excluded.attempts,
                last_error_code = excluded.last_error_code,
                last_attempt_at = excluded.last_attempt_at,
                lease_token = NULL,
                lease_expires_at = NULL
            """,
            (
                board_id,
                external_post_id,
                f"https://www.typemoon.net/{board_id}/{external_post_id}",
                int(row["priority"] or 0),
                state,
                max(0, int(row["retry_count"] or 0)),
                row["last_error"],
                normalize_source_timestamp(row["last_attempt_at"]),
            ),
        )
        frontier_count += 1

    return {
        "collections": collection_count,
        "collection_entries": entry_count,
        "bookmarks": bookmark_count,
        "reading_progress": reading_count,
        "settings": setting_count,
        "frontier": frontier_count,
        "orphan_comments": orphan_comment_count,
        "placeholder_posts": len(post_ids) - initial_post_count,
    }
