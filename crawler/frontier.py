from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from crawler.archive import connect_archive, initialize_archive


@dataclass(frozen=True, slots=True)
class FrontierLease:
    board_id: str
    external_post_id: int
    url: str
    attempts: int
    lease_token: str
    lease_expires_at: datetime


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("frontier timestamps must be timezone-aware")
    return value.astimezone(UTC).isoformat(timespec="seconds")


# Network failures die after this many attempts; auth failures stay in retry
# with backoff because recovering the session may need operator action.
MAX_NETWORK_ATTEMPTS = 5
_BACKOFF_BASE_SECONDS = 120
_BACKOFF_CAP_SECONDS = 6 * 60 * 60


def retry_backoff(attempts: int, now: datetime) -> datetime:
    if attempts < 1:
        raise ValueError("attempts must be positive")
    delay = min(_BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), _BACKOFF_CAP_SECONDS)
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


def complete_lease(connection: sqlite3.Connection, lease: FrontierLease) -> None:
    transition_lease(connection, lease, state="done")


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
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO crawl_frontier (board_id, external_post_id, url, priority)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    url = excluded.url,
                    priority = excluded.priority,
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
        return row is not None and tuple(row) == (title, category, comment_count)

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
                RETURNING url, attempts
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
            rows = connection.execute(
                """
                SELECT frontier.board_id, frontier.external_post_id
                FROM crawl_frontier AS frontier
                LEFT JOIN boards AS board ON board.board_id = frontier.board_id
                WHERE frontier.state IN ('pending', 'retry')
                  AND (frontier.next_attempt_at IS NULL OR frontier.next_attempt_at <= ?)
                ORDER BY
                    CASE
                        WHEN board.group_name = 'aa' OR frontier.board_id GLOB 'aa_*'
                            THEN 0
                        WHEN board.group_name = 'creation'
                             OR frontier.board_id GLOB 'write_*' THEN 1
                        WHEN board.group_name = 'fanfic'
                             OR frontier.board_id GLOB 'ss_*' THEN 2
                        ELSE 3
                    END,
                    frontier.priority DESC,
                    frontier.attempts,
                    frontier.board_id,
                    frontier.external_post_id
                LIMIT ?
                """,
                (selected_at, limit),
            ).fetchall()
        return [(str(row["board_id"]), int(row["external_post_id"])) for row in rows]

    def requeue_dead(self, *, error_code: str, limit: int) -> int:
        if error_code not in {"network_error", "parse_drift"}:
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
                SELECT board_id, external_post_id, url, attempts
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
            )
            for row in rows
        ]

    def complete(self, lease: FrontierLease) -> None:
        with self._connect() as connection:
            complete_lease(connection, lease)
