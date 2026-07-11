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
