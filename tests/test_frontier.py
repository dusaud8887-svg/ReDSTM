from __future__ import annotations

import multiprocessing
import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from crawler.archive import SCHEMA_VERSION, connect_archive
from crawler.frontier import FrontierLease, FrontierStore, transition_lease


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
    store.seed("write_free21", 62068, url, priority=10, expected_comment_count=9)

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    store.seed("write_free21", 62068, url, priority=10, expected_comment_count=9)
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
            SELECT board_id, external_post_id, url, attempts, lease_token, lease_expires_at,
                   expected_comment_count
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
        expected_comment_count=row[6],
    )

    assert store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(seconds=59)) == []
    recovered = store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(seconds=60))
    assert len(recovered) == 1
    assert recovered[0].attempts == 2
    assert recovered[0].lease_token != old_lease.lease_token
    assert recovered[0].expected_comment_count == 9

    with pytest.raises(RuntimeError, match="stale or missing frontier lease"):
        store.complete(old_lease)
    store.complete(recovered[0])
    assert store.claim(limit=1, lease_seconds=60, now=started_at + timedelta(minutes=3)) == []


def test_latest_listing_expectation_survives_retry_and_can_be_cleared(tmp_path: Path) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    url = "https://www.typemoon.net/write_free21/1"

    store.seed("write_free21", 1, url, expected_comment_count=7)
    store.seed("write_free21", 1, url, expected_comment_count=0)
    lease = store.claim_identity("write_free21", 1, lease_seconds=60)
    assert lease is not None
    assert lease.expected_comment_count == 0

    with connect_archive(path) as connection:
        transition_lease(connection, lease, state="retry", error_code="network_error")
    retried = store.claim_identity("write_free21", 1, lease_seconds=60)
    assert retried is not None
    assert retried.expected_comment_count == 0
    with connect_archive(path) as connection:
        transition_lease(connection, retried, state="dead", error_code="parse_drift")

    assert store.requeue_dead(error_code="parse_drift", limit=1) == 1
    requeued = store.claim_identity("write_free21", 1, lease_seconds=60)
    assert requeued is not None
    assert requeued.expected_comment_count == 0
    with connect_archive(path) as connection:
        transition_lease(connection, requeued, state="done")

    store.seed("write_free21", 1, url, expected_comment_count=None)
    with connect_archive(path, read_only=True) as connection:
        value = connection.execute(
            "SELECT expected_comment_count FROM crawl_frontier "
            "WHERE board_id = 'write_free21' AND external_post_id = 1"
        ).fetchone()[0]
    assert value is None

    for invalid in (-1, True):
        with pytest.raises(ValueError, match="expected_comment_count"):
            store.seed("write_free21", 2, f"{url}2", expected_comment_count=invalid)


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


def test_dead_requeue_is_bounded_and_error_specific(tmp_path: Path) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    for post_id, error in (
        (1, "network_error"),
        (2, "network_error"),
        (3, "parse_drift"),
        (4, "storage_error"),
    ):
        store.seed("write_free21", post_id, f"https://www.typemoon.net/write_free21/{post_id}")
        with connect_archive(path) as connection:
            connection.execute(
                """
                UPDATE crawl_frontier SET state = 'dead', attempts = 5, last_error_code = ?
                WHERE external_post_id = ?
                """,
                (error, post_id),
            )

    assert store.requeue_dead(error_code="network_error", limit=1) == 1

    with connect_archive(path, read_only=True) as connection:
        rows = [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, state, attempts FROM crawl_frontier "
                "ORDER BY external_post_id"
            )
        ]
    assert rows == [
        (1, "retry", 0),
        (2, "dead", 5),
        (3, "dead", 5),
        (4, "dead", 5),
    ]
    assert store.requeue_dead(error_code="storage_error", limit=1) == 1
    with pytest.raises(ValueError, match="unsupported"):
        store.requeue_dead(error_code="auth_required", limit=1)


def test_missing_listing_category_preserves_detail_category_match(tmp_path: Path) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('write_free21', '자유게시판', 'https://www.typemoon.net/write_free21',
                    'now', 'now')
            """
        )
        connection.execute(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title, category,
                first_seen_at, last_seen_at, comment_count
            ) VALUES ('write_free21', 1, 'https://www.typemoon.net/write_free21/1',
                      'title', 'detail-only', 'now', 'now', 2)
            """
        )

    assert store.listing_is_unchanged(
        "write_free21", 1, title="title", category=None, comment_count=2
    )
    assert not store.listing_is_unchanged(
        "write_free21", 1, title="title", category="changed", comment_count=2
    )


def test_full_content_requeue_uses_a_stable_rowid_and_time_checkpoint(
    tmp_path: Path,
) -> None:
    path = tmp_path / "frontier.sqlite"
    store = FrontierStore(path)
    store.initialize()
    cutoff = datetime(2026, 7, 12, tzinfo=UTC)
    for post_id in (1, 2, 3):
        store.seed("write_free21", post_id, f"https://example.test/{post_id}")
    with connect_archive(path) as connection:
        connection.execute(
            "UPDATE crawl_frontier SET state = 'done', last_attempt_at = ?",
            ((cutoff - timedelta(days=1)).isoformat(),),
        )
        max_rowid = int(connection.execute("SELECT MAX(rowid) FROM crawl_frontier").fetchone()[0])
    store.seed("write_free21", 4, "https://example.test/4")

    selected = store.requeue_full_content(
        limit=2,
        max_rowid=max_rowid,
        attempted_before=cutoff,
        now=cutoff,
    )

    assert selected == [("write_free21", 1), ("write_free21", 2)]
    assert store.full_content_remaining(max_rowid=max_rowid, attempted_before=cutoff) == 3
    with connect_archive(path) as connection:
        connection.executemany(
            "UPDATE crawl_frontier SET last_attempt_at = ? "
            "WHERE board_id = ? AND external_post_id = ?",
            [
                ((cutoff + timedelta(seconds=1)).isoformat(), board_id, post_id)
                for board_id, post_id in selected
            ],
        )
    assert store.full_content_remaining(max_rowid=max_rowid, attempted_before=cutoff) == 1
