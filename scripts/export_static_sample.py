from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any

from crawler.items import CapturedPostItem, CommentItem
from crawler.pipelines import normalize_captured_post
from crawler.static_archive import StaticPostSummary, build_static_post, summary_dict
from scripts.legacy_common import normalize_source_timestamp

_POST_COLUMNS = {
    "id",
    "board_id",
    "title",
    "author",
    "category",
    "content_html",
    "is_aa",
    "views",
    "created_at",
}
_COMMENT_COLUMNS = {
    "id",
    "post_id",
    "board_id",
    "author",
    "content",
    "created_at",
    "parent_id",
    "depth",
}
_SEARCH_FIELDS = [
    "board_id",
    "external_post_id",
    "title",
    "author",
    "category",
    "created_at_raw",
    "payload_sha256",
]


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _write_gzip_object(output: Path, prefix: str, payload: bytes) -> tuple[str, str, int]:
    payload_sha256 = hashlib.sha256(payload).hexdigest()
    key = f"{prefix}-{payload_sha256}.json.gz"
    body = gzip.compress(payload, compresslevel=6, mtime=0)
    target = output / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    return key, payload_sha256, len(body)


def _sample_rowids(connection: sqlite3.Connection, sample_size: int) -> tuple[int, list[int]]:
    rowids = [int(row[0]) for row in connection.execute("SELECT rowid FROM posts ORDER BY rowid")]
    population = len(rowids)
    if population == 0:
        raise ValueError("posts table is empty")
    wanted = min(sample_size, population)
    if wanted == 1:
        return population, [rowids[0]]
    return population, [
        rowids[round(index * (population - 1) / (wanted - 1))] for index in range(wanted)
    ]


def _comments(
    connection: sqlite3.Connection, board_id: str, external_post_id: int
) -> list[CommentItem]:
    rows = connection.execute(
        """
        SELECT id, author, content, created_at, parent_id, depth
        FROM comments
        WHERE post_id = ? AND board_id = ?
        ORDER BY id
        """,
        (external_post_id, board_id),
    ).fetchall()
    positions = {int(row["id"]): position for position, row in enumerate(rows, start=1)}
    return [
        CommentItem(
            position=position,
            source_comment_id=str(row["id"]),
            parent_position=positions.get(int(row["parent_id"]))
            if row["parent_id"] is not None
            else None,
            depth=int(row["depth"] or 0),
            author=row["author"],
            content_html=row["content"],
            created_at_raw=row["created_at"],
        )
        for position, row in enumerate(rows, start=1)
    ]


def export_static_sample(source: Path, output: Path, *, sample_size: int) -> dict[str, Any]:
    if sample_size < 1:
        raise ValueError("sample_size must be positive")
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"not a file: {source}")
    output = output.expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite: {output}")
    source_before = source.stat()

    summaries: dict[str, list[StaticPostSummary]] = defaultdict(list)
    object_bytes = 0
    comment_count = 0
    collection_rows: list[sqlite3.Row] = []
    with sqlite3.connect(f"{source.as_uri()}?mode=ro&immutable=1", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        post_columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(posts)")}
        comment_columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(comments)")}
        missing = sorted((_POST_COLUMNS - post_columns) | (_COMMENT_COLUMNS - comment_columns))
        if missing:
            raise ValueError(f"legacy database is missing columns: {', '.join(missing)}")
        population, rowids = _sample_rowids(connection, sample_size)
        output.mkdir(parents=True)

        for rowid in rowids:
            row = connection.execute(
                """
                SELECT id, board_id, title, author, category, content_html,
                       is_aa, views, created_at
                FROM posts WHERE rowid = ?
                """,
                (rowid,),
            ).fetchone()
            assert row is not None
            board_id = str(row["board_id"])
            external_post_id = int(row["id"])
            comments = _comments(connection, board_id, external_post_id)
            normalized = normalize_captured_post(
                CapturedPostItem(
                    board_id=board_id,
                    external_post_id=external_post_id,
                    canonical_url=f"https://www.typemoon.net/{board_id}/{external_post_id}",
                    outcome="stored",
                    title=row["title"],
                    author=row["author"],
                    category=row["category"],
                    created_at_raw=row["created_at"],
                    views=int(row["views"] or 0),
                    is_aa=bool(row["is_aa"]),
                    body_html=row["content_html"],
                    comments=comments,
                )
            )
            static_post = build_static_post(normalized, capture_origin="legacy_import")
            target = output / static_post.summary.object_key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(static_post.body)
            summaries[board_id].append(static_post.summary)
            object_bytes += len(static_post.body)
            comment_count += len(comments)

        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
        }
        if {"collections", "collection_episodes"} <= tables:
            selected = {
                (summary.board_id, summary.external_post_id)
                for board_summaries in summaries.values()
                for summary in board_summaries
            }
            collection_rows = [
                row
                for row in connection.execute(
                    """
                    SELECT c.id, c.board_id, c.collection_type, c.title,
                           ce.board_id AS episode_board_id, ce.post_id,
                           ce.episode_number, ce.id AS episode_id
                    FROM collections AS c
                    JOIN collection_episodes AS ce ON ce.collection_id = c.id
                    ORDER BY c.id, COALESCE(ce.episode_number, ce.id), ce.id
                    """
                )
                if (str(row["episode_board_id"]), int(row["post_id"])) in selected
            ]

    board_manifests = []
    for board_id, board_summaries in sorted(summaries.items()):
        manifest = _json_bytes(
            {
                "schema_version": 1,
                "board_id": board_id,
                "posts": [
                    summary_dict(summary)
                    for summary in sorted(
                        board_summaries,
                        key=lambda summary: summary.external_post_id,
                        reverse=True,
                    )
                ],
            }
        )
        key, manifest_sha256, _ = _write_gzip_object(
            output, f"boards/{board_id}/manifest", manifest
        )
        board_manifests.append(
            {
                "board_id": board_id,
                "object_key": key,
                "post_count": len(board_summaries),
                "payload_sha256": manifest_sha256,
            }
        )

    search_summaries = sorted(
        (summary for board_summaries in summaries.values() for summary in board_summaries),
        key=lambda item: (
            # Legacy dates mix dot and dash formats; raw string order ranks every
            # dot date above dash dates, so sort on the normalized UTC timestamp.
            normalize_source_timestamp(item.created_at_raw) or "",
            item.external_post_id,
            item.board_id,
        ),
        reverse=True,
    )
    search_posts = [
        [
            summary.board_id,
            summary.external_post_id,
            summary.title,
            summary.author,
            summary.category,
            summary.created_at_raw,
            summary.payload_sha256,
        ]
        for summary in search_summaries
    ]
    search_payload = _json_bytes(
        {"schema_version": 1, "fields": _SEARCH_FIELDS, "posts": search_posts}
    )
    search_key, search_sha256, search_bytes = _write_gzip_object(
        output, "search/title-author", search_payload
    )

    collections: dict[int, dict[str, Any]] = {}
    for row in collection_rows:
        collection_id = int(row["id"])
        collection = collections.setdefault(
            collection_id,
            {
                "id": collection_id,
                "board_id": row["board_id"],
                "kind": row["collection_type"],
                "title": row["title"],
                "entries": [],
            },
        )
        collection["entries"].append(
            {
                "position": len(collection["entries"]) + 1,
                "board_id": row["episode_board_id"],
                "external_post_id": int(row["post_id"]),
                "episode_number": row["episode_number"],
            }
        )
    collection_payload = _json_bytes(
        {"schema_version": 1, "collections": list(collections.values())}
    )
    collection_key, collection_sha256, collection_bytes = _write_gzip_object(
        output, "collections/all", collection_payload
    )

    release = _json_bytes(
        {
            "schema_version": 1,
            "source": "typemoon",
            "capture_origin": "legacy_import",
            "sampling": {
                "method": "equally spaced by SQLite rowid",
                "population_rows": population,
                "sample_rowids": rowids,
            },
            "post_count": len(rowids),
            "comment_count": comment_count,
            "boards": board_manifests,
            "search": {
                "object_key": search_key,
                "payload_sha256": search_sha256,
                "post_count": len(search_posts),
            },
            "collections": {
                "object_key": collection_key,
                "payload_sha256": collection_sha256,
                "collection_count": len(collections),
            },
        }
    )
    release_sha256 = hashlib.sha256(release).hexdigest()
    release_key = f"releases/{release_sha256}.json"
    versioned_release = output / release_key
    versioned_release.parent.mkdir(parents=True, exist_ok=True)
    versioned_release.write_bytes(release)
    (output / "release.json").write_bytes(release)

    source_after = source.stat()
    source_unchanged = (source_before.st_size, source_before.st_mtime_ns) == (
        source_after.st_size,
        source_after.st_mtime_ns,
    )
    if not source_unchanged:
        raise RuntimeError("source database changed during export")
    return {
        "population_rows": population,
        "post_count": len(rowids),
        "comment_count": comment_count,
        "board_count": len(board_manifests),
        "post_object_bytes": object_bytes,
        "search_object_bytes": search_bytes,
        "collection_object_bytes": collection_bytes,
        "collection_count": len(collections),
        "release_sha256": release_sha256,
        "release_object_key": release_key,
        "source_unchanged": True,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a deterministic static legacy sample.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=2_000)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = export_static_sample(args.source, args.output, sample_size=args.sample_size)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
