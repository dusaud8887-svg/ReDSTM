from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from crawler.archive import compress_body, connect_archive
from crawler.frontier import (
    MAX_NETWORK_ATTEMPTS,
    FrontierLease,
    complete_lease,
    retry_backoff,
    transition_lease,
)
from crawler.pipelines import NormalizedPost


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

    def store_post(
        self,
        run_id: str,
        post: NormalizedPost,
        *,
        captured_at: datetime,
        raw_sha256: str | None,
        warc_file: str | None,
        http_status: int = 200,
        parser_version: str = "1",
        lease: FrontierLease | None = None,
    ) -> StoreResult:
        captured_at_text = _timestamp(captured_at)
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO posts (
                    board_id, external_post_id, canonical_url, title, author, category,
                    created_at_raw, first_seen_at, last_seen_at, last_collected_at,
                    availability, views, comment_count, is_aa
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    canonical_url = excluded.canonical_url,
                    title = excluded.title,
                    author = excluded.author,
                    category = excluded.category,
                    created_at_raw = excluded.created_at_raw,
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
            changed = version_row is None
            if changed:
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
                self._replace_comments(connection, post_id, post)
                connection.execute(
                    "UPDATE posts SET latest_version_id = ? WHERE id = ?",
                    (version_id, post_id),
                )
            else:
                assert version_row is not None
                version_id = int(version_row["id"])

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
                complete_lease(connection, lease)
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
    ) -> int:
        fetched_at_text = _timestamp(fetched_at)
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
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
                    if error_code == "network_error" and lease.attempts >= MAX_NETWORK_ATTEMPTS:
                        state = "dead"
                    else:
                        next_attempt_at = retry_backoff(lease.attempts, fetched_at)
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
    ) -> int:
        fetched_at_text = _timestamp(fetched_at)
        with connect_archive(self.path) as connection:
            self._require_running_run(connection, run_id)
            previous = connection.execute(
                "SELECT 1 FROM captures WHERE entity_type = 'listing' AND url = ? "
                "AND raw_sha256 = ? LIMIT 1",
                (url, raw_sha256),
            ).fetchone()
            cursor = connection.execute(
                """
                INSERT INTO captures (
                    run_id, url, entity_type, fetched_at, http_status, outcome,
                    raw_sha256, warc_file, warc_record_id
                ) VALUES (?, ?, 'listing', ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    url,
                    fetched_at_text,
                    http_status,
                    "unchanged" if previous is not None else "stored",
                    raw_sha256,
                    warc_file,
                    warc_record_id,
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
                created_at_raw, parent_position, depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    post_id,
                    comment.position,
                    comment.source_comment_id,
                    comment.author,
                    comment.content_html,
                    comment.content_text,
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
