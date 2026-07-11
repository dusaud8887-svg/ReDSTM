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


class FrontierStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        return connect_archive(self.path)

    def initialize(self) -> None:
        initialize_archive(self.path)

    def seed(self, board_id: str, external_post_id: int, url: str, priority: int = 0) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO crawl_frontier (board_id, external_post_id, url, priority)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (board_id, external_post_id) DO UPDATE SET
                    url = excluded.url,
                    priority = excluded.priority
                """,
                (board_id, external_post_id, url, priority),
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
            cursor = connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'done', next_attempt_at = NULL, last_error_code = NULL,
                    lease_token = NULL, lease_expires_at = NULL
                WHERE board_id = ? AND external_post_id = ?
                  AND state = 'running' AND lease_token = ?
                """,
                (lease.board_id, lease.external_post_id, lease.lease_token),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("stale or missing frontier lease")
