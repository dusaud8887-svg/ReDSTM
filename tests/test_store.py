from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from crawler.archive import connect_archive, decompress_body, initialize_archive
from crawler.frontier import MAX_NETWORK_ATTEMPTS, FrontierLease, FrontierStore
from crawler.items import CapturedPostItem, CommentItem
from crawler.pipelines import NormalizedPost, normalize_captured_post
from crawler.store import ArchiveStore

_NOW = datetime(2026, 7, 11, 2, tzinfo=UTC)


def _initialize(path: Path) -> None:
    initialize_archive(path)
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO boards (
                board_id, name, canonical_url, first_seen_at, last_seen_at
            ) VALUES ('ss_temp01', 'Board', 'https://www.typemoon.net/ss_temp01',
                      '2026-07-11T00:00:00+00:00', '2026-07-11T00:00:00+00:00')
            """
        )


def _post(*, body: str = "body", comment: str = "comment") -> NormalizedPost:
    return normalize_captured_post(
        CapturedPostItem(
            board_id="ss_temp01",
            external_post_id=7,
            canonical_url="https://www.typemoon.net/ss_temp01/7",
            outcome="stored",
            title="Title",
            author="author",
            created_at_raw="2026.07.11 10:00",
            views=10,
            body_html=f"<p>{body}</p>",
            comments=[
                CommentItem(
                    position=1,
                    source_comment_id="101",
                    parent_position=None,
                    depth=0,
                    author="commenter",
                    content_html=f"<p>{comment}</p>",
                    created_at_raw="2026.07.11 10:01",
                )
            ],
            warc_record_id="<urn:uuid:test>",
        )
    )


def test_store_deduplicates_versions_and_tracks_every_capture(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)

    first = store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
    )
    second = store.store_post(
        run_id,
        _post(),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
    )

    assert first.changed is True
    assert second.changed is False
    assert first.version_id == second.version_id
    assert store.find_warc_capture("a" * 64, "https://www.typemoon.net/ss_temp01/7") == (
        "capture.warc.gz",
        "<urn:uuid:test>",
    )
    assert store.find_warc_capture("a" * 64, "https://www.typemoon.net/ss_temp01/8") is None
    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0] == 2
        outcomes = [
            row[0] for row in connection.execute("SELECT outcome FROM captures ORDER BY id")
        ]
        assert outcomes == ["stored", "unchanged"]
        version = connection.execute(
            "SELECT body_html_zstd, body_text_zstd FROM post_versions"
        ).fetchone()
        assert version is not None
        assert decompress_body(version["body_html_zstd"]) == "<p>body</p>"
        assert decompress_body(version["body_text_zstd"]) == "body"


def test_changed_comments_create_version_and_replace_projection(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    first = store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
    )
    changed = store.store_post(
        run_id,
        _post(comment="updated"),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="two.warc.gz",
    )

    assert changed.changed is True
    assert changed.version_id != first.version_id
    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 2
        assert connection.execute("SELECT content_text FROM comments").fetchone()[0] == "updated"
        latest = connection.execute("SELECT latest_version_id FROM posts").fetchone()[0]
        assert latest == changed.version_id


def test_outcome_updates_availability_and_finish_run_counters(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    store.record_outcome(
        run_id,
        url="https://www.typemoon.net/ss_temp01/7",
        outcome="restricted",
        fetched_at=_NOW + timedelta(minutes=1),
        http_status=200,
        board_id="ss_temp01",
        external_post_id=7,
        raw_sha256="b" * 64,
        warc_file="restricted.warc.gz",
        warc_record_id="<urn:uuid:restricted>",
        error_code="permission_denied",
        lease=lease,
        frontier_state="dead",
    )
    store.finish_run(run_id, status="succeeded", discovered=1, now=_NOW + timedelta(minutes=2))

    with connect_archive(path) as connection:
        assert connection.execute("SELECT availability FROM posts").fetchone()[0] == "restricted"
        run = connection.execute(
            """
            SELECT status, discovered, fetched, changed, unchanged, failed
            FROM crawl_runs WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        assert run is not None
        assert tuple(run) == ("succeeded", 1, 2, 1, 0, 0)
        capture = connection.execute(
            "SELECT raw_sha256, warc_file, warc_record_id FROM captures ORDER BY id DESC LIMIT 1"
        ).fetchone()
        assert tuple(capture) == (
            "b" * 64,
            "restricted.warc.gz",
            "<urn:uuid:restricted>",
        )
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "dead"


def test_store_and_frontier_completion_are_atomic(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url)
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)

    stale = FrontierLease(
        board_id=lease.board_id,
        external_post_id=lease.external_post_id,
        url=lease.url,
        attempts=lease.attempts,
        lease_token="stale",
        lease_expires_at=lease.lease_expires_at,
    )
    with pytest.raises(RuntimeError, match="stale or missing frontier lease"):
        store.store_post(
            run_id,
            _post(),
            captured_at=_NOW,
            raw_sha256="a" * 64,
            warc_file="capture.warc.gz",
            lease=stale,
        )

    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM captures").fetchone()[0] == 0

    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
        lease=lease,
    )
    with connect_archive(path) as connection:
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "done"


def test_retry_backoff_and_network_attempt_cap(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")

    first = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert first is not None
    store.record_outcome(
        run_id,
        url=first.url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="network_error",
        lease=first,
        frontier_state="retry",
    )
    with connect_archive(path) as connection:
        row = connection.execute("SELECT state, next_attempt_at FROM crawl_frontier").fetchone()
        assert row["state"] == "retry"
        assert row["next_attempt_at"] == "2026-07-11T02:02:00+00:00"

    def _escalated(attempts: int, token: str) -> FrontierLease:
        expires_at = _NOW + timedelta(minutes=5)
        with connect_archive(path) as connection:
            connection.execute(
                """
                UPDATE crawl_frontier
                SET state = 'running', attempts = ?, lease_token = ?, lease_expires_at = ?
                WHERE board_id = 'ss_temp01' AND external_post_id = 7
                """,
                (attempts, token, expires_at.isoformat(timespec="seconds")),
            )
        return FrontierLease(
            board_id="ss_temp01",
            external_post_id=7,
            url="https://www.typemoon.net/ss_temp01/7",
            attempts=attempts,
            lease_token=token,
            lease_expires_at=expires_at,
        )

    held = _escalated(MAX_NETWORK_ATTEMPTS + 4, "auth-token")
    store.record_outcome(
        run_id,
        url=held.url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="auth_required",
        lease=held,
        frontier_state="retry",
    )
    with connect_archive(path) as connection:
        row = connection.execute("SELECT state, next_attempt_at FROM crawl_frontier").fetchone()
        assert row["state"] == "retry"
        assert row["next_attempt_at"] == "2026-07-11T08:00:00+00:00"

    capped = _escalated(MAX_NETWORK_ATTEMPTS, "network-token")
    store.record_outcome(
        run_id,
        url=capped.url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="network_error",
        lease=capped,
        frontier_state="retry",
    )
    with connect_archive(path) as connection:
        row = connection.execute(
            "SELECT state, next_attempt_at, last_error_code FROM crawl_frontier"
        ).fetchone()
        assert row["state"] == "dead"
        assert row["next_attempt_at"] is None
        assert row["last_error_code"] == "network_error"
