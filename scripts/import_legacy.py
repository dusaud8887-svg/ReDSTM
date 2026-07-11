from __future__ import annotations

import argparse
import json
import sqlite3
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from crawler.archive import compress_body, connect_archive, initialize_archive
from crawler.pipelines import NormalizedPost
from scripts.import_legacy_auxiliary import import_auxiliary
from scripts.legacy_common import (
    build_legacy_post_item,
    normalize_legacy_post,
    normalize_source_timestamp,
)

_REQUIRED_POST_COLUMNS = {
    "id",
    "board_id",
    "url",
    "title",
    "author",
    "category",
    "content_html",
    "is_aa",
    "views",
    "created_at",
    "crawled_at",
}
_REQUIRED_COMMENT_COLUMNS = {
    "id",
    "post_id",
    "board_id",
    "author",
    "content",
    "created_at",
    "parent_id",
    "depth",
}


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _validate_source(connection: sqlite3.Connection) -> None:
    missing_posts = _REQUIRED_POST_COLUMNS - _columns(connection, "posts")
    missing_comments = _REQUIRED_COMMENT_COLUMNS - _columns(connection, "comments")
    if missing_posts or missing_comments:
        missing = sorted(missing_posts | missing_comments)
        raise ValueError(f"legacy database is missing columns: {', '.join(missing)}")


def _prepare_post(task: tuple[dict[str, Any], str]) -> tuple[NormalizedPost, str, int]:
    item, captured_at = task
    normalized, replacements = normalize_legacy_post(item)
    return normalized, captured_at, replacements


def _upsert_board(target: sqlite3.Connection, row: sqlite3.Row, imported_at: str) -> None:
    board_id = str(row["id"])
    last_seen_at = normalize_source_timestamp(row["last_crawled_at"]) or imported_at
    target.execute(
        """
        INSERT INTO boards (
            board_id, name, group_name, canonical_url, is_enabled,
            first_seen_at, last_seen_at, reported_post_count, last_inventory_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (board_id) DO UPDATE SET
            name = excluded.name,
            group_name = excluded.group_name,
            canonical_url = excluded.canonical_url,
            is_enabled = excluded.is_enabled,
            last_seen_at = excluded.last_seen_at,
            reported_post_count = excluded.reported_post_count,
            last_inventory_at = excluded.last_inventory_at
        """,
        (
            board_id,
            str(row["name"]),
            row["group_id"],
            f"https://www.typemoon.net/{board_id}",
            int(bool(row["is_active"])),
            imported_at,
            last_seen_at,
            int(row["post_count"] or 0),
            last_seen_at,
        ),
    )


def _upsert_post(
    target: sqlite3.Connection, normalized: NormalizedPost, captured_at: str
) -> tuple[int, bool]:
    created_at_source = normalize_source_timestamp(normalized.created_at_raw)
    target.execute(
        """
        INSERT INTO posts (
            board_id, external_post_id, canonical_url, title, author, category,
            created_at_source, created_at_raw, first_seen_at, last_seen_at,
            last_collected_at, availability, views, comment_count, is_aa
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
        ON CONFLICT (board_id, external_post_id) DO UPDATE SET
            canonical_url = excluded.canonical_url,
            title = excluded.title,
            author = excluded.author,
            category = excluded.category,
            created_at_source = excluded.created_at_source,
            created_at_raw = excluded.created_at_raw,
            last_seen_at = excluded.last_seen_at,
            last_collected_at = excluded.last_collected_at,
            availability = 'available',
            views = excluded.views,
            comment_count = excluded.comment_count,
            is_aa = excluded.is_aa
        """,
        (
            normalized.board_id,
            normalized.external_post_id,
            normalized.canonical_url,
            normalized.title,
            normalized.author,
            normalized.category,
            created_at_source,
            normalized.created_at_raw,
            captured_at,
            captured_at,
            captured_at,
            normalized.views,
            len(normalized.comments),
            int(normalized.is_aa),
        ),
    )
    post_row = target.execute(
        "SELECT id FROM posts WHERE board_id = ? AND external_post_id = ?",
        (normalized.board_id, normalized.external_post_id),
    ).fetchone()
    assert post_row is not None
    post_id = int(post_row["id"])

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
    version_cursor = target.execute(
        """
        INSERT OR IGNORE INTO post_versions (
            post_id, content_sha256, raw_sha256, parser_version, capture_origin,
            body_html_zstd, body_text_zstd, comments_sha256, captured_at, warc_record_id
        ) VALUES (?, ?, NULL, 'legacy-v1', 'legacy_import', ?, ?, ?, ?, NULL)
        """,
        (
            post_id,
            normalized.content_sha256,
            compress_body(normalized.body_html),
            compress_body(normalized.body_text),
            normalized.comments_sha256,
            captured_at,
        ),
    )
    version_row = target.execute(
        """
        SELECT id FROM post_versions
        WHERE post_id = ? AND content_sha256 = ? AND comments_sha256 = ?
        """,
        (post_id, normalized.content_sha256, normalized.comments_sha256),
    ).fetchone()
    assert version_row is not None
    target.execute(
        "UPDATE posts SET latest_version_id = ? WHERE id = ?",
        (int(version_row["id"]), post_id),
    )
    return post_id, version_cursor.rowcount == 1


def _assert_target_is_import_only(connection: sqlite3.Connection) -> None:
    non_legacy_versions = connection.execute(
        "SELECT COUNT(*) FROM post_versions WHERE capture_origin <> 'legacy_import'"
    ).fetchone()[0]
    captures = connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
    if non_legacy_versions or captures:
        raise ValueError("target archive contains non-legacy data; refusing import")


def import_legacy(
    source_path: Path,
    target_path: Path,
    *,
    batch_size: int = 500,
    limit_posts: int | None = None,
    workers: int = 1,
) -> dict[str, Any]:
    if batch_size < 1 or workers < 1 or (limit_posts is not None and limit_posts < 1):
        raise ValueError("batch_size, workers, and limit_posts must be positive")
    source_path = source_path.expanduser().resolve(strict=True)
    target_path = target_path.expanduser().resolve()
    if source_path == target_path:
        raise ValueError("source and target databases must differ")
    source_before = source_path.stat()
    target_existed = target_path.exists()
    initialize_archive(target_path)

    imported_at = datetime.now(UTC).isoformat(timespec="seconds")
    run_id = f"legacy-import-{uuid.uuid4().hex}"
    post_count = 0
    comment_count = 0
    new_version_count = 0
    empty_comment_count = 0
    auxiliary: dict[str, int] = {}
    with (
        sqlite3.connect(f"{source_path.as_uri()}?mode=ro&immutable=1", uri=True) as source,
        connect_archive(target_path) as target,
    ):
        source.row_factory = sqlite3.Row
        _validate_source(source)
        _assert_target_is_import_only(target)
        target.execute(
            """
            UPDATE crawl_runs SET status = 'interrupted', finished_at = ?
            WHERE kind = 'import' AND status = 'running'
            """,
            (imported_at,),
        )
        resume_offset = 0
        if limit_posts is None:
            resume_offset = int(
                target.execute(
                    "SELECT COUNT(*) FROM post_versions WHERE capture_origin = 'legacy_import'"
                ).fetchone()[0]
            )
        target.execute(
            """
            INSERT INTO crawl_runs (run_id, kind, status, started_at)
            VALUES (?, 'import', 'running', ?)
            """,
            (run_id, imported_at),
        )
        for board in source.execute(
            """
            SELECT id, name, group_id, post_count, last_crawled_at, is_active
            FROM boards ORDER BY id
            """
        ):
            _upsert_board(target, board, imported_at)
        target.commit()

        query = """
            SELECT id, board_id, url, title, author, category, content_html,
                   is_aa, views, created_at, crawled_at
            FROM posts ORDER BY rowid
        """
        parameters: tuple[int, ...]
        if limit_posts is not None:
            query += " LIMIT ? OFFSET 0"
            parameters = (limit_posts,)
        else:
            query += " LIMIT -1 OFFSET ?"
            parameters = (resume_offset,)
        try:
            tasks = (
                build_legacy_post_item(source, row) for row in source.execute(query, parameters)
            )
            executor = ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
            prepared = (
                executor.map(_prepare_post, tasks, chunksize=1, buffersize=workers * 2)
                if executor is not None
                else map(_prepare_post, tasks)
            )
            for normalized, captured_at, replacements in prepared:
                _, created_version = _upsert_post(target, normalized, captured_at)
                post_count += 1
                comment_count += len(normalized.comments)
                new_version_count += int(created_version)
                empty_comment_count += replacements
                if post_count % batch_size == 0:
                    target.commit()
            if executor is not None:
                executor.shutdown()
            if limit_posts is None:
                auxiliary = import_auxiliary(source, target, imported_at=imported_at)
            finished_at = datetime.now(UTC).isoformat(timespec="seconds")
            summary = {
                "source": str(source_path),
                "target_existed": target_existed,
                "limited": limit_posts is not None,
                "workers": workers,
                "resume_offset": resume_offset,
                "posts": post_count,
                "comments": comment_count,
                "new_versions": new_version_count,
                "empty_comments_replaced": empty_comment_count,
                "auxiliary": auxiliary,
            }
            target.execute(
                """
                UPDATE crawl_runs
                SET status = 'succeeded', finished_at = ?, discovered = ?,
                    fetched = ?, changed = ?, summary_json = ?
                WHERE run_id = ?
                """,
                (
                    finished_at,
                    post_count,
                    post_count,
                    new_version_count,
                    json.dumps(summary, ensure_ascii=False, separators=(",", ":")),
                    run_id,
                ),
            )
            target.commit()
        except Exception:
            if "executor" in locals() and executor is not None:
                executor.shutdown(wait=False, cancel_futures=True)
            target.rollback()
            target.execute(
                """
                UPDATE crawl_runs SET status = 'failed', finished_at = ?
                WHERE run_id = ? AND status = 'running'
                """,
                (datetime.now(UTC).isoformat(timespec="seconds"), run_id),
            )
            target.commit()
            raise

    source_after = source_path.stat()
    source_unchanged = (source_before.st_size, source_before.st_mtime_ns) == (
        source_after.st_size,
        source_after.st_mtime_ns,
    )
    if not source_unchanged:
        raise RuntimeError("source database changed during import")
    return {
        "run_id": run_id,
        "posts": post_count,
        "comments": comment_count,
        "new_versions": new_version_count,
        "empty_comments_replaced": empty_comment_count,
        "resume_offset": resume_offset,
        "auxiliary": auxiliary,
        "source_unchanged": True,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import a legacy TypeMoon SQLite archive.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--limit-posts", type=int)
    parser.add_argument("--workers", type=int, default=4)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = import_legacy(
        args.source,
        args.target,
        batch_size=args.batch_size,
        limit_posts=args.limit_posts,
        workers=args.workers,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
