from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from crawler.archive import compress_body, connect_archive
from crawler.frontier import (
    FrontierLease,
    complete_lease,
    retry_backoff,
    transition_lease,
)
from crawler.items import DiscoveredPostItem
from crawler.pipelines import NormalizedPost
from crawler.settings import REDSTM_CAPPED_RETRY_ERROR_CODES, REDSTM_FRONTIER_MAX_ATTEMPTS
from scripts.legacy_common import normalize_source_timestamp

PARSER_VERSION = "2"


@dataclass(frozen=True, slots=True)
class StoreResult:
    post_id: int
    version_id: int
    capture_id: int
    changed: bool


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("archive timestamps must be timezone-aware")
    return value.astimezone(UTC).isoformat(timespec="seconds")


class ArchiveStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def start_run(self, kind: str, *, now: datetime | None = None) -> str:
        run_id = f"{kind}-{uuid.uuid4().hex}"
        started_at = _timestamp(now or datetime.now(UTC))
        with connect_archive(self.path) as connection:
            connection.execute(
                """
                INSERT INTO crawl_runs (run_id, kind, status, started_at)
                VALUES (?, ?, 'running', ?)
                """,
                (run_id, kind, started_at),
            )
        return run_id

    def interrupt_stale_crawl_runs(self, *, now: datetime | None = None) -> int:
        finished_at = _timestamp(now or datetime.now(UTC))
        with connect_archive(self.path) as connection:
            cursor = connection.execute(
                """
                UPDATE crawl_runs
                SET status = 'interrupted', finished_at = ?,
                    summary_json = '{"error":"process_interrupted"}'
                WHERE status = 'running' AND kind IN ('sync', 'retry', 'inventory')
                """,
                (finished_at,),
            )
        return cursor.rowcount

    def store_discovered_post(
        self,
        item: DiscoveredPostItem,
        *,
        seen_at: datetime | None = None,
    ) -> int:
        observed_at = _timestamp(seen_at or datetime.now(UTC))
        board_id = str(item["board_id"])
        external_post_id = int(item["external_post_id"])
        canonical_url = str(item["canonical_url"])
        title = str(item["title"]).strip()
        comment_count = int(item["comment_count"])
        if not title or external_post_id < 1 or comment_count < 0:
            raise ValueError("discovered post metadata is invalid")
        with connect_archive(self.path) as connection:
            connection.execute(
                """
                INSERT INTO posts (
                    board_id, external_post_id, canonical_url, title, author, category,
                    created_at_raw, first_seen_at, last_seen_at, comment_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    canonical_url = excluded.canonical_url,
                    title = excluded.title,
                    author = COALESCE(excluded.author, posts.author),
                    category = COALESCE(excluded.category, posts.category),
                    created_at_raw = COALESCE(excluded.created_at_raw, posts.created_at_raw),
                    last_seen_at = excluded.last_seen_at,
                    comment_count = excluded.comment_count
                """,
                (
                    board_id,
                    external_post_id,
                    canonical_url,
                    title,
                    item.get("author"),
                    item.get("category"),
                    item.get("created_at_raw"),
                    observed_at,
                    observed_at,
                    comment_count,
                ),
            )
            row = connection.execute(
                "SELECT id FROM posts WHERE board_id = ? AND external_post_id = ?",
                (board_id, external_post_id),
            ).fetchone()
        assert row is not None
        return int(row["id"])

    def store_post(
        self,
        run_id: str,
        post: NormalizedPost,
        *,
        captured_at: datetime,
        raw_sha256: str | None,
        warc_file: str | None,
        http_status: int = 200,
        parser_version: str = PARSER_VERSION,
        lease: FrontierLease | None = None,
    ) -> StoreResult:
        if (
            lease is not None
            and lease.expected_comment_count is not None
            and len(post.comments) < lease.expected_comment_count
        ):
            raise ValueError("captured post has fewer comments than the listing advertised")
        captured_at_text = _timestamp(captured_at)
        created_at_source = normalize_source_timestamp(post.created_at_raw)
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            connection.execute("BEGIN IMMEDIATE")
            existing_post = connection.execute(
                """
                SELECT canonical_url, title, author, category, created_at_source,
                       created_at_raw, views, comment_count, is_aa, latest_version_id
                FROM posts WHERE board_id = ? AND external_post_id = ?
                """,
                (post.board_id, post.external_post_id),
            ).fetchone()
            effective_author = (
                post.author
                if post.author is not None
                else existing_post["author"]
                if existing_post is not None
                else None
            )
            effective_category = (
                post.category
                if post.category is not None
                else existing_post["category"]
                if existing_post is not None
                else None
            )
            effective_created_at_source = (
                created_at_source
                if created_at_source is not None
                else existing_post["created_at_source"]
                if existing_post is not None
                else None
            )
            effective_created_at_raw = (
                post.created_at_raw
                if post.created_at_raw is not None
                else existing_post["created_at_raw"]
                if existing_post is not None
                else None
            )
            projection_values = (
                post.canonical_url,
                post.title,
                effective_author,
                effective_category,
                effective_created_at_source,
                effective_created_at_raw,
                len(post.comments),
                int(post.is_aa),
            )
            projection_changed = (
                existing_post is None
                or tuple(
                    existing_post[key]
                    for key in (
                        "canonical_url",
                        "title",
                        "author",
                        "category",
                        "created_at_source",
                        "created_at_raw",
                        "comment_count",
                        "is_aa",
                    )
                )
                != projection_values
            )
            connection.execute(
                """
                INSERT INTO posts (
                    board_id, external_post_id, canonical_url, title, author, category,
                    created_at_source, created_at_raw, first_seen_at, last_seen_at,
                    last_collected_at,
                    availability, views, comment_count, is_aa
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    canonical_url = excluded.canonical_url,
                    title = excluded.title,
                    author = COALESCE(excluded.author, posts.author),
                    category = COALESCE(excluded.category, posts.category),
                    created_at_source = COALESCE(
                        excluded.created_at_source, posts.created_at_source
                    ),
                    created_at_raw = COALESCE(excluded.created_at_raw, posts.created_at_raw),
                    last_seen_at = excluded.last_seen_at,
                    last_collected_at = excluded.last_collected_at,
                    availability = 'available',
                    views = excluded.views,
                    comment_count = excluded.comment_count,
                    is_aa = excluded.is_aa
                """,
                (
                    post.board_id,
                    post.external_post_id,
                    post.canonical_url,
                    post.title,
                    post.author,
                    post.category,
                    created_at_source,
                    post.created_at_raw,
                    captured_at_text,
                    captured_at_text,
                    captured_at_text,
                    post.views,
                    len(post.comments),
                    int(post.is_aa),
                ),
            )
            post_row = connection.execute(
                "SELECT id FROM posts WHERE board_id = ? AND external_post_id = ?",
                (post.board_id, post.external_post_id),
            ).fetchone()
            assert post_row is not None
            post_id = int(post_row["id"])
            version_row = connection.execute(
                """
                SELECT id FROM post_versions
                WHERE post_id = ? AND content_sha256 = ? AND comments_sha256 = ?
                """,
                (post_id, post.content_sha256, post.comments_sha256),
            ).fetchone()
            version_created = version_row is None
            if version_created:
                version_cursor = connection.execute(
                    """
                    INSERT INTO post_versions (
                        post_id, content_sha256, raw_sha256, parser_version, capture_origin,
                        body_html_zstd, body_text_zstd, comments_sha256, captured_at,
                        warc_record_id
                    ) VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?, ?)
                    """,
                    (
                        post_id,
                        post.content_sha256,
                        raw_sha256,
                        parser_version,
                        compress_body(post.body_html),
                        compress_body(post.body_text),
                        post.comments_sha256,
                        captured_at_text,
                        post.warc_record_id,
                    ),
                )
                assert version_cursor.lastrowid is not None
                version_id = version_cursor.lastrowid
            else:
                assert version_row is not None
                version_id = int(version_row["id"])
            version_changed = (
                existing_post is None or existing_post["latest_version_id"] != version_id
            )
            if version_changed:
                self._replace_comments(connection, post_id, post)
                connection.execute(
                    "UPDATE posts SET latest_version_id = ? WHERE id = ?",
                    (version_id, post_id),
                )
            changed = projection_changed or version_changed

            capture_cursor = connection.execute(
                """
                INSERT INTO captures (
                    run_id, url, entity_type, post_id, fetched_at, http_status, outcome,
                    raw_sha256, warc_file, warc_record_id
                ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    post.canonical_url,
                    post_id,
                    captured_at_text,
                    http_status,
                    "stored" if changed else "unchanged",
                    raw_sha256,
                    warc_file,
                    post.warc_record_id,
                ),
            )
            assert capture_cursor.lastrowid is not None
            if lease is not None:
                complete_lease(connection, lease, stored_comment_count=len(post.comments))
            return StoreResult(post_id, version_id, capture_cursor.lastrowid, changed)

    def record_outcome(
        self,
        run_id: str,
        *,
        url: str,
        outcome: str,
        fetched_at: datetime,
        http_status: int | None = None,
        board_id: str | None = None,
        external_post_id: int | None = None,
        error_code: str | None = None,
        raw_sha256: str | None = None,
        warc_file: str | None = None,
        warc_record_id: str | None = None,
        lease: FrontierLease | None = None,
        frontier_state: str = "done",
        retry_after_at: datetime | None = None,
    ) -> int:
        fetched_at_text = _timestamp(fetched_at)
        if retry_after_at is not None and retry_after_at.tzinfo is None:
            raise ValueError("retry_after_at must be timezone-aware")
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            if error_code == "not_found":
                previous = connection.execute(
                    "SELECT 1 FROM captures WHERE entity_type = 'post' AND url = ? "
                    "AND error_code = 'not_found' AND run_id <> ? LIMIT 1",
                    (url, run_id),
                ).fetchone()
                if previous is not None:
                    outcome, frontier_state = "missing", "done"
            post_id = None
            if board_id is not None and external_post_id is not None:
                row = connection.execute(
                    "SELECT id FROM posts WHERE board_id = ? AND external_post_id = ?",
                    (board_id, external_post_id),
                ).fetchone()
                if row is not None:
                    post_id = int(row["id"])
                    availability = {"restricted": "restricted", "missing": "missing"}.get(outcome)
                    if availability is not None:
                        connection.execute(
                            "UPDATE posts SET availability = ?, last_collected_at = ? WHERE id = ?",
                            (availability, fetched_at_text, post_id),
                        )
            cursor = connection.execute(
                """
                INSERT INTO captures (
                    run_id, url, entity_type, post_id, fetched_at, http_status, outcome,
                    raw_sha256, warc_file, warc_record_id, error_code
                ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    url,
                    post_id,
                    fetched_at_text,
                    http_status,
                    outcome,
                    raw_sha256,
                    warc_file,
                    warc_record_id,
                    error_code,
                ),
            )
            assert cursor.lastrowid is not None
            if lease is not None:
                state = frontier_state
                next_attempt_at = None
                if state == "retry":
                    if error_code in REDSTM_CAPPED_RETRY_ERROR_CODES and (
                        lease.attempts >= REDSTM_FRONTIER_MAX_ATTEMPTS
                    ):
                        state = "dead"
                    else:
                        next_attempt_at = retry_backoff(lease.attempts, fetched_at)
                        if retry_after_at is not None:
                            next_attempt_at = max(next_attempt_at, retry_after_at.astimezone(UTC))
                transition_lease(
                    connection,
                    lease,
                    state=state,
                    error_code=error_code,
                    next_attempt_at=next_attempt_at,
                )
            return cursor.lastrowid

    def record_listing(
        self,
        run_id: str,
        *,
        url: str,
        fetched_at: datetime,
        http_status: int,
        raw_sha256: str | None,
        warc_file: str | None,
        warc_record_id: str | None,
        error_code: str | None = None,
    ) -> int:
        fetched_at_text = _timestamp(fetched_at)
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            previous = connection.execute(
                "SELECT 1 FROM captures WHERE entity_type = 'listing' AND url = ? "
                "AND raw_sha256 = ? AND outcome IN ('stored', 'unchanged') LIMIT 1",
                (url, raw_sha256),
            ).fetchone()
            cursor = connection.execute(
                """
                INSERT INTO captures (
                    run_id, url, entity_type, fetched_at, http_status, outcome,
                    raw_sha256, warc_file, warc_record_id, error_code
                ) VALUES (?, ?, 'listing', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    url,
                    fetched_at_text,
                    http_status,
                    (
                        "fetch_failed"
                        if error_code is not None
                        else "unchanged"
                        if previous is not None
                        else "stored"
                    ),
                    raw_sha256,
                    warc_file,
                    warc_record_id,
                    error_code,
                ),
            )
            assert cursor.lastrowid is not None
            return cursor.lastrowid

    def find_warc_capture(self, raw_sha256: str, url: str) -> tuple[str, str] | None:
        with connect_archive(self.path, read_only=True) as connection:
            row = connection.execute(
                """
                SELECT warc_file, warc_record_id
                FROM captures
                WHERE raw_sha256 = ? AND url = ?
                  AND warc_file IS NOT NULL AND warc_record_id IS NOT NULL
                ORDER BY id DESC LIMIT 1
                """,
                (raw_sha256, url),
            ).fetchone()
        if row is None:
            return None
        return str(row["warc_file"]), str(row["warc_record_id"])

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        discovered: int = 0,
        summary: dict[str, object] | None = None,
        now: datetime | None = None,
    ) -> None:
        finished_at = _timestamp(now or datetime.now(UTC))
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            counters = connection.execute(
                """
                SELECT
                    COUNT(*) AS fetched,
                    SUM(outcome = 'stored') AS changed,
                    SUM(outcome = 'unchanged') AS unchanged,
                    SUM(outcome IN ('parse_failed', 'fetch_failed')) AS failed
                FROM captures WHERE run_id = ? AND entity_type = 'post'
                """,
                (run_id,),
            ).fetchone()
            assert counters is not None
            connection.execute(
                """
                UPDATE crawl_runs
                SET status = ?, finished_at = ?, discovered = ?, fetched = ?, changed = ?,
                    unchanged = ?, failed = ?, summary_json = ?
                WHERE run_id = ?
                """,
                (
                    status,
                    finished_at,
                    discovered,
                    int(counters["fetched"] or 0),
                    int(counters["changed"] or 0),
                    int(counters["unchanged"] or 0),
                    int(counters["failed"] or 0),
                    json.dumps(summary or {}, ensure_ascii=False, separators=(",", ":")),
                    run_id,
                ),
            )

    @staticmethod
    def _replace_comments(
        connection: sqlite3.Connection, post_id: int, post: NormalizedPost
    ) -> None:
        connection.execute("DELETE FROM comments WHERE post_id = ?", (post_id,))
        connection.executemany(
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
                for comment in post.comments
            ],
        )

    @staticmethod
    def _require_running_run(connection: sqlite3.Connection, run_id: str) -> None:
        row = connection.execute(
            "SELECT status FROM crawl_runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None or row["status"] != "running":
            raise ValueError("crawl run is missing or not running")
