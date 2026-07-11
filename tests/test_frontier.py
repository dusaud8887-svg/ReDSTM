from __future__ import annotations

import multiprocessing
import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from crawler.archive import SCHEMA_VERSION, connect_archive
from crawler.frontier import FrontierLease, FrontierStore


def _claim_then_crash(path: str, now_text: str) -> None:
    leases = FrontierStore(Path(path)).claim(
        limit=1,
        lease_seconds=60,
        now=datetime.fromisoformat(now_text),
    )
    os._exit(17 if len(leases) == 1 else 2)


def test_expired_lease_recovers_after_process_crash(tmp_path: Path) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    url = "https://www.typemoon.net/write_free21/62068"
    store.seed("write_free21", 62068, url, priority=10)

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    store.seed("write_free21", 62068, url, priority=10)
    started_at = datetime(2026, 7, 11, tzinfo=UTC)

    process = multiprocessing.get_context("spawn").Process(
        target=_claim_then_crash,
        args=(str(path), started_at.isoformat()),
    )
    process.start()
    process.join(10)
    assert process.exitcode == 17

    with sqlite3.connect(path) as connection:
        row = connection.execute(
            """
            SELECT board_id, external_post_id, url, attempts, lease_token, lease_expires_at
            FROM crawl_frontier
            """
        ).fetchone()
    assert row is not None
    old_lease = FrontierLease(
        board_id=row[0],
        external_post_id=row[1],
        url=row[2],
        attempts=row[3],
        lease_token=row[4],
        lease_expires_at=datetime.fromisoformat(row[5]),
    )

    assert store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(seconds=59)) == []
    recovered = store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(seconds=60))
    assert len(recovered) == 1
    assert recovered[0].attempts == 2
    assert recovered[0].lease_token != old_lease.lease_token

    with pytest.raises(RuntimeError, match="stale or missing frontier lease"):
        store.complete(old_lease)
    store.complete(recovered[0])
    assert store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(minutes=3)) == []


def test_reopen_done_and_claim_only_requested_identity(tmp_path: Path) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    first_url = "https://www.typemoon.net/write_free21/1"
    second_url = "https://www.typemoon.net/write_free21/2"
    store.seed("write_free21", 1, first_url)
    store.seed("write_free21", 2, second_url)
    first = store.claim_identity("write_free21", 1, lease_seconds=60)
    assert first is not None
    store.complete(first)

    assert store.claim_identity("write_free21", 1, lease_seconds=60) is None
    store.seed("write_free21", 1, first_url, reopen_done=True)
    reopened = store.claim_identity("write_free21", 1, lease_seconds=60)
    assert reopened is not None
    assert reopened.attempts == 1

    second = store.claim_identity("write_free21", 2, lease_seconds=60)
    assert second is not None
    assert second.external_post_id == 2


def test_site_outage_restores_network_attempt_without_reviving_other_failures(
    tmp_path: Path,
) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    for post_id, state, error in ((1, "dead", "network_error"), (2, "retry", "auth_required")):
        store.seed("write_free21", post_id, f"https://www.typemoon.net/write_free21/{post_id}")
        with connect_archive(path) as connection:
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = ?, attempts = 5, last_error_code = ?
                WHERE board_id = 'write_free21' AND external_post_id = ?
                """,
                (state, error, post_id),
            )
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO crawl_runs (run_id, kind, status, started_at, finished_at)
            VALUES ('sync-outage', 'sync', 'failed', 'now', 'now')
            """
        )
        connection.executemany(
            """
            INSERT INTO captures (run_id, url, entity_type, fetched_at, outcome, error_code)
            VALUES ('sync-outage', ?, 'post', 'now', 'fetch_failed', ?)
            """,
            [
                ("https://www.typemoon.net/write_free21/1", "network_error"),
                ("https://www.typemoon.net/write_free21/2", "auth_required"),
            ],
        )

    assert store.preserve_network_attempts(["sync-outage", "sync-outage"]) == 1

    with connect_archive(path, read_only=True) as connection:
        rows = [
            tuple(row)
            for row in connection.execute(
                """
                SELECT external_post_id, state, attempts, last_error_code
                FROM crawl_frontier ORDER BY external_post_id
                """
            )
        ]
    assert rows == [(1, "retry", 4, None), (2, "retry", 5, "auth_required")]
