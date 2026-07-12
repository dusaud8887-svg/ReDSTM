from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from crawler.archive import connect_archive, initialize_archive
from crawler.settings import (
    REDSTM_CAPPED_RETRY_ERROR_CODES,
    REDSTM_FRONTIER_BACKOFF_BASE_SECONDS,
    REDSTM_FRONTIER_BACKOFF_CAP_SECONDS,
    REDSTM_RECOVERY_GROUP_ORDER,
)


@dataclass(frozen=True, slots=True)
class FrontierLease:
    board_id: str
    external_post_id: int
    url: str
    attempts: int
    lease_token: str
    lease_expires_at: datetime
    expected_comment_count: int | None = None


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("frontier timestamps must be timezone-aware")
    return value.astimezone(UTC).isoformat(timespec="seconds")


def retry_backoff(attempts: int, now: datetime) -> datetime:
    if attempts < 1:
        raise ValueError("attempts must be positive")
    delay = min(
        REDSTM_FRONTIER_BACKOFF_BASE_SECONDS * 2 ** (attempts - 1),
        REDSTM_FRONTIER_BACKOFF_CAP_SECONDS,
    )
    return now.astimezone(UTC) + timedelta(seconds=delay)


def transition_lease(
    connection: sqlite3.Connection,
    lease: FrontierLease,
    *,
    state: str,
    error_code: str | None = None,
    next_attempt_at: datetime | None = None,
) -> None:
    if state not in {"done", "retry", "dead"}:
        raise ValueError("frontier terminal state must be done, retry, or dead")
    if state != "retry" and next_attempt_at is not None:
        raise ValueError("only retry state may have next_attempt_at")
    cursor = connection.execute(
        """
        UPDATE crawl_frontier
        SET state = ?, next_attempt_at = ?, last_error_code = ?,
            lease_token = NULL, lease_expires_at = NULL
        WHERE board_id = ? AND external_post_id = ?
          AND state = 'running' AND lease_token = ?
        """,
        (
            state,
            _timestamp(next_attempt_at) if next_attempt_at is not None else None,
            error_code,
            lease.board_id,
            lease.external_post_id,
            lease.lease_token,
        ),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("stale or missing frontier lease")


def complete_lease(
    connection: sqlite3.Connection,
    lease: FrontierLease,
    *,
    stored_comment_count: int | None = None,
) -> None:
    if stored_comment_count is not None and (
        type(stored_comment_count) is not int or stored_comment_count < 0
    ):
        raise ValueError("stored_comment_count must be a non-negative integer or None")
    cursor = connection.execute(
        """
        UPDATE crawl_frontier
        SET state = 'done', next_attempt_at = NULL, last_error_code = NULL,
            lease_token = NULL, lease_expires_at = NULL,
            expected_comment_count = COALESCE(?, expected_comment_count)
        WHERE board_id = ? AND external_post_id = ?
          AND state = 'running' AND lease_token = ?
        """,
        (
            stored_comment_count,
            lease.board_id,
            lease.external_post_id,
            lease.lease_token,
        ),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("stale or missing frontier lease")


class FrontierStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        return connect_archive(self.path)

    def initialize(self) -> None:
        initialize_archive(self.path)

    def seed(
        self,
        board_id: str,
        external_post_id: int,
        url: str,
        priority: int = 0,
        *,
        reopen_done: bool = False,
        expected_comment_count: int | None = None,
    ) -> None:
        if expected_comment_count is not None and (
            type(expected_comment_count) is not int or expected_comment_count < 0
        ):
            raise ValueError("expected_comment_count must be a non-negative integer or None")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO crawl_frontier (
                    board_id, external_post_id, url, priority, expected_comment_count
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    url = excluded.url,
                    priority = excluded.priority,
                    expected_comment_count = excluded.expected_comment_count,
                    state = CASE
                        WHEN ? AND crawl_frontier.state = 'done' THEN 'pending'
                        ELSE crawl_frontier.state
                    END,
                    attempts = CASE
                        WHEN ? AND crawl_frontier.state = 'done' THEN 0
                        ELSE crawl_frontier.attempts
                    END,
                    next_attempt_at = CASE
                        WHEN ? AND crawl_frontier.state = 'done' THEN NULL
                        ELSE crawl_frontier.next_attempt_at
                    END,
                    last_error_code = CASE
                        WHEN ? AND crawl_frontier.state = 'done' THEN NULL
                        ELSE crawl_frontier.last_error_code
                    END
                """,
                (
                    board_id,
                    external_post_id,
                    url,
                    priority,
                    expected_comment_count,
                    reopen_done,
                    reopen_done,
                    reopen_done,
                    reopen_done,
                ),
            )

    def listing_is_unchanged(
        self,
        board_id: str,
        external_post_id: int,
        *,
        title: str,
        category: str | None,
        comment_count: int,
    ) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT title, category, comment_count
                FROM posts
                WHERE board_id = ? AND external_post_id = ?
                """,
                (board_id, external_post_id),
            ).fetchone()
        return bool(
            row is not None
            and row["title"] == title
            and (category is None or row["category"] == category)
            and row["comment_count"] == comment_count
        )

    def claim_identity(
        self,
        board_id: str,
        external_post_id: int,
        *,
        lease_seconds: int,
        now: datetime | None = None,
    ) -> FrontierLease | None:
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        claimed_at = now or datetime.now(UTC)
        claimed_at_text = _timestamp(claimed_at)
        expires_at = claimed_at.astimezone(UTC) + timedelta(seconds=lease_seconds)
        lease_token = uuid.uuid4().hex
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'retry', lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = ?
                WHERE board_id = ? AND external_post_id = ?
                  AND state = 'running' AND lease_expires_at <= ?
                """,
                (claimed_at_text, board_id, external_post_id, claimed_at_text),
            )
            row = connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'running', attempts = attempts + 1, last_attempt_at = ?,
                    lease_token = ?, lease_expires_at = ?
                WHERE board_id = ? AND external_post_id = ?
                  AND state IN ('pending', 'retry')
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                RETURNING url, attempts, expected_comment_count
                """,
                (
                    claimed_at_text,
                    lease_token,
                    _timestamp(expires_at),
                    board_id,
                    external_post_id,
                    claimed_at_text,
                ),
            ).fetchone()
        if row is None:
            return None
        return FrontierLease(
            board_id=board_id,
            external_post_id=external_post_id,
            url=str(row["url"]),
            attempts=int(row["attempts"]),
            lease_token=lease_token,
            lease_expires_at=expires_at,
            expected_comment_count=(
                int(row["expected_comment_count"])
                if row["expected_comment_count"] is not None
                else None
            ),
        )

    def recovery_candidates(
        self,
        *,
        limit: int,
        now: datetime | None = None,
    ) -> list[tuple[str, int]]:
        if limit < 1:
            raise ValueError("limit must be positive")
        selected_at = _timestamp(now or datetime.now(UTC))
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'retry', lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = ?
                WHERE state = 'running' AND lease_expires_at <= ?
                """,
                (selected_at, selected_at),
            )
            group_order_sql = " ".join(
                f"WHEN ? THEN {rank}" for rank, _group in enumerate(REDSTM_RECOVERY_GROUP_ORDER)
            )
            rows = connection.execute(
                f"""
                SELECT frontier.board_id, frontier.external_post_id
                FROM crawl_frontier AS frontier
                LEFT JOIN boards AS board ON board.board_id = frontier.board_id
                WHERE frontier.state IN ('pending', 'retry')
                  AND (frontier.next_attempt_at IS NULL OR frontier.next_attempt_at <= ?)
                ORDER BY
                    CASE board.group_name
                        {group_order_sql}
                        ELSE 3
                    END,
                    frontier.priority DESC,
                    frontier.attempts,
                    frontier.board_id,
                    frontier.external_post_id
                LIMIT ?
                """,
                (selected_at, *REDSTM_RECOVERY_GROUP_ORDER, limit),
            ).fetchall()
        return [(str(row["board_id"]), int(row["external_post_id"])) for row in rows]

    def requeue_full_content(
        self,
        *,
        limit: int,
        max_rowid: int,
        attempted_before: datetime,
        board_id: str | None = None,
        now: datetime | None = None,
    ) -> list[tuple[str, int]]:
        if limit < 1 or max_rowid < 0:
            raise ValueError("full-content bounds are invalid")
        if attempted_before.tzinfo is None:
            raise ValueError("attempted_before must be timezone-aware")
        selected_at = _timestamp(now or datetime.now(UTC))
        cutoff = _timestamp(attempted_before)
        board_clause = " AND board_id = ?" if board_id is not None else ""
        parameters: list[object] = [max_rowid, cutoff]
        if board_id is not None:
            parameters.append(board_id)
        parameters.append(limit)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'retry', lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = ?
                WHERE state = 'running' AND lease_expires_at <= ?
                """,
                (selected_at, selected_at),
            )
            rows = connection.execute(
                f"""
                SELECT board_id, external_post_id
                FROM crawl_frontier
                WHERE rowid <= ?
                  AND (last_attempt_at IS NULL OR julianday(last_attempt_at) < julianday(?))
                  AND state <> 'running'
                  {board_clause}
                ORDER BY last_attempt_at IS NOT NULL, julianday(last_attempt_at),
                         board_id, external_post_id
                LIMIT ?
                """,
                parameters,
            ).fetchall()
            connection.executemany(
                """
                UPDATE crawl_frontier
                SET state = 'pending', attempts = 0, next_attempt_at = NULL,
                    last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL
                WHERE board_id = ? AND external_post_id = ? AND state <> 'running'
                """,
                [(row["board_id"], row["external_post_id"]) for row in rows],
            )
        return [(str(row["board_id"]), int(row["external_post_id"])) for row in rows]

    def full_content_remaining(
        self,
        *,
        max_rowid: int,
        attempted_before: datetime,
        board_id: str | None = None,
    ) -> int:
        if max_rowid < 0 or attempted_before.tzinfo is None:
            raise ValueError("full-content checkpoint is invalid")
        board_clause = " AND board_id = ?" if board_id is not None else ""
        parameters: list[object] = [max_rowid, _timestamp(attempted_before)]
        if board_id is not None:
            parameters.append(board_id)
        with self._connect() as connection:
            row = connection.execute(
                f"""
                SELECT COUNT(*)
                FROM crawl_frontier
                WHERE rowid <= ?
                  AND (last_attempt_at IS NULL OR julianday(last_attempt_at) < julianday(?))
                  {board_clause}
                """,
                parameters,
            ).fetchone()
        assert row is not None
        return int(row[0])

    def requeue_stale_details(
        self,
        *,
        limit: int,
        stale_before: datetime,
    ) -> list[tuple[str, int]]:
        if limit < 1:
            raise ValueError("limit must be positive")
        stale_before_text = _timestamp(stale_before)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT frontier.board_id, frontier.external_post_id
                FROM crawl_frontier AS frontier
                LEFT JOIN posts AS post
                  ON post.board_id = frontier.board_id
                 AND post.external_post_id = frontier.external_post_id
                WHERE frontier.state = 'done'
                  AND julianday(
                    COALESCE(post.last_collected_at, frontier.last_attempt_at)
                  ) <= julianday(?)
                ORDER BY julianday(
                           COALESCE(post.last_collected_at, frontier.last_attempt_at)
                         ),
                         frontier.board_id, frontier.external_post_id
                LIMIT ?
                """,
                (stale_before_text, limit),
            ).fetchall()
            connection.executemany(
                """
                UPDATE crawl_frontier
                SET state = 'pending', attempts = 0, next_attempt_at = NULL,
                    last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL
                WHERE board_id = ? AND external_post_id = ? AND state = 'done'
                """,
                [(row["board_id"], row["external_post_id"]) for row in rows],
            )
        return [(str(row["board_id"]), int(row["external_post_id"])) for row in rows]

    def requeue_dead(self, *, error_code: str, limit: int) -> int:
        if error_code not in REDSTM_CAPPED_RETRY_ERROR_CODES:
            raise ValueError("unsupported dead frontier error code")
        if limit < 1:
            raise ValueError("limit must be positive")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'retry', attempts = 0, next_attempt_at = NULL,
                    last_error_code = NULL, lease_token = NULL, lease_expires_at = NULL
                WHERE (board_id, external_post_id) IN (
                    SELECT board_id, external_post_id FROM crawl_frontier
                    WHERE state = 'dead' AND last_error_code = ?
                    ORDER BY priority DESC, board_id, external_post_id LIMIT ?
                )
                """,
                (error_code, limit),
            )
        return cursor.rowcount

    def preserve_network_attempts(self, run_ids: list[str]) -> int:
        unique_run_ids = list(dict.fromkeys(run_ids))
        if not unique_run_ids:
            return 0
        placeholders = ",".join("?" for _ in unique_run_ids)
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                UPDATE crawl_frontier
                SET attempts = MAX(attempts - 1, 0), state = 'retry',
                    next_attempt_at = NULL, last_error_code = NULL
                WHERE state IN ('retry', 'dead') AND url IN (
                    SELECT url FROM captures
                    WHERE run_id IN ({placeholders}) AND error_code = 'network_error'
                )
                """,
                unique_run_ids,
            )
        return cursor.rowcount

    def claim(
        self,
        *,
        limit: int,
        lease_seconds: int,
        now: datetime | None = None,
    ) -> list[FrontierLease]:
        if limit < 1 or lease_seconds < 1:
            raise ValueError("limit and lease_seconds must be positive")

        claimed_at = now or datetime.now(UTC)
        claimed_at_text = _timestamp(claimed_at)
        expires_at = claimed_at.astimezone(UTC) + timedelta(seconds=lease_seconds)
        expires_at_text = _timestamp(expires_at)
        lease_token = uuid.uuid4().hex

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'retry', lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = ?
                WHERE state = 'running' AND lease_expires_at <= ?
                """,
                (claimed_at_text, claimed_at_text),
            )
            rows = connection.execute(
                """
                SELECT board_id, external_post_id, url, attempts, expected_comment_count
                FROM crawl_frontier
                WHERE state IN ('pending', 'retry')
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY priority DESC, board_id, external_post_id
                LIMIT ?
                """,
                (claimed_at_text, limit),
            ).fetchall()
            connection.executemany(
                """
                UPDATE crawl_frontier
                SET state = 'running', attempts = attempts + 1, last_attempt_at = ?,
                    lease_token = ?, lease_expires_at = ?
                WHERE board_id = ? AND external_post_id = ?
                """,
                [
                    (
                        claimed_at_text,
                        lease_token,
                        expires_at_text,
                        row["board_id"],
                        row["external_post_id"],
                    )
                    for row in rows
                ],
            )

        return [
            FrontierLease(
                board_id=row["board_id"],
                external_post_id=row["external_post_id"],
                url=row["url"],
                attempts=row["attempts"] + 1,
                lease_token=lease_token,
                lease_expires_at=expires_at,
                expected_comment_count=(
                    int(row["expected_comment_count"])
                    if row["expected_comment_count"] is not None
                    else None
                ),
            )
            for row in rows
        ]

    def complete(self, lease: FrontierLease) -> None:
        with self._connect() as connection:
            complete_lease(connection, lease)
