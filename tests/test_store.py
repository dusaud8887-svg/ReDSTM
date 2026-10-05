from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from crawler.archive import connect_archive, decompress_body, initialize_archive
from crawler.frontier import FrontierLease, FrontierStore, listing_fingerprint
from crawler.items import CapturedPostItem, CommentItem, DiscoveredPostItem
from crawler.pipelines import NormalizedPost, normalize_captured_post
from crawler.settings import REDSTM_FRONTIER_MAX_ATTEMPTS, REDSTM_NETWORK_MAX_ATTEMPTS
from crawler.store import PARSER_VERSION, ArchiveStore

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


def _post(*, body: str = "body", comment: str | None = "comment") -> NormalizedPost:
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
            comments=(
                []
                if comment is None
                else [
                    CommentItem(
                        position=1,
                        source_comment_id="101",
                        parent_position=None,
                        depth=0,
                        author="commenter",
                        content_html=f"<p>{comment}</p>",
                        created_at_raw="2026.07.11 10:01",
                    )
                ]
            ),
            warc_record_id="<urn:uuid:test>",
        )
    )


def test_stale_crawl_runs_are_interrupted_without_touching_imports(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    sync_run = store.start_run("sync", now=_NOW)
    retry_run = store.start_run("retry", now=_NOW)
    inventory_run = store.start_run("inventory", now=_NOW)
    import_run = store.start_run("import", now=_NOW)

    assert store.interrupt_stale_crawl_runs(now=_NOW + timedelta(minutes=1)) == 3

    with connect_archive(path, read_only=True) as connection:
        rows = {
            row["run_id"]: (row["status"], row["finished_at"], row["summary_json"])
            for row in connection.execute(
                "SELECT run_id, status, finished_at, summary_json FROM crawl_runs"
            )
        }
    assert rows[sync_run] == (
        "interrupted",
        "2026-07-11T02:01:00+00:00",
        '{"error":"process_interrupted"}',
    )
    assert rows[retry_run] == rows[sync_run]
    assert rows[inventory_run] == rows[sync_run]
    assert rows[import_run] == ("running", None, "{}")


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
        post_dates = connection.execute(
            "SELECT created_at_source, created_at_raw FROM posts"
        ).fetchone()
        assert tuple(post_dates) == ("2026-07-11T01:00:00+00:00", "2026.07.11 10:00")
        comment_dates = connection.execute(
            "SELECT created_at_source, created_at_raw FROM comments"
        ).fetchone()
        assert tuple(comment_dates) == ("2026-07-11T01:01:00+00:00", "2026.07.11 10:01")
        version = connection.execute(
            "SELECT body_html_zstd, body_text_zstd, parser_version FROM post_versions"
        ).fetchone()
        assert version is not None
        assert decompress_body(version["body_html_zstd"]) == "<p>body</p>"
        assert decompress_body(version["body_text_zstd"]) == "body"
        assert version["parser_version"] == PARSER_VERSION


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


def test_metadata_only_change_is_reported_for_static_publish(tmp_path: Path) -> None:
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

    updated = store.store_post(
        run_id,
        replace(_post(), title="Updated title", views=11, is_aa=True),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="two.warc.gz",
    )
    views_only = store.store_post(
        run_id,
        replace(_post(), title="Updated title", views=12, is_aa=True),
        captured_at=_NOW + timedelta(minutes=2),
        raw_sha256="c" * 64,
        warc_file="three.warc.gz",
    )

    assert updated.changed is True
    assert updated.version_id == first.version_id
    assert views_only.changed is False
    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        row = connection.execute("SELECT title, views, is_aa FROM posts").fetchone()
        assert tuple(row) == ("Updated title", 12, 1)
        outcomes = [
            row[0] for row in connection.execute("SELECT outcome FROM captures ORDER BY id")
        ]
        assert outcomes == ["stored", "stored", "unchanged"]


def test_missing_optional_metadata_preserves_existing_projection(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    original = replace(_post(), category="series")
    store.store_post(
        run_id,
        original,
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
    )

    result = store.store_post(
        run_id,
        replace(original, author=None, category=None, created_at_raw=None),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="two.warc.gz",
    )

    assert result.changed is False
    with connect_archive(path, read_only=True) as connection:
        row = connection.execute(
            "SELECT author, category, created_at_raw, created_at_source FROM posts"
        ).fetchone()
        assert tuple(row) == (
            "author",
            "series",
            "2026.07.11 10:00",
            "2026-07-11T01:00:00+00:00",
        )
        assert [
            capture[0] for capture in connection.execute("SELECT outcome FROM captures ORDER BY id")
        ] == ["stored", "unchanged"]


def test_return_to_a_prior_version_reactivates_that_projection(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    first = store.store_post(
        run_id,
        _post(body="first"),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
    )
    second = store.store_post(
        run_id,
        _post(body="second"),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="two.warc.gz",
    )

    returned = store.store_post(
        run_id,
        _post(body="first"),
        captured_at=_NOW + timedelta(minutes=2),
        raw_sha256="c" * 64,
        warc_file="three.warc.gz",
    )

    assert first.version_id != second.version_id
    assert returned.changed is True
    assert returned.version_id == first.version_id
    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 2
        assert (
            connection.execute("SELECT latest_version_id FROM posts").fetchone()[0]
            == first.version_id
        )


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
    frontier.seed("ss_temp01", 7, url, expected_comment_count=1)
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
        assert (
            connection.execute("SELECT expected_comment_count FROM crawl_frontier").fetchone()[0]
            == 1
        )

    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
        lease=lease,
    )
    with connect_archive(path) as connection:
        row = connection.execute(
            "SELECT state, expected_comment_count FROM crawl_frontier"
        ).fetchone()
        assert tuple(row) == ("done", 1)


def test_successful_empty_comment_capture_refreshes_frontier_expectation(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url, expected_comment_count=0)
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    assert lease.expected_comment_count == 0
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)

    store.store_post(
        run_id,
        _post(comment=None),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
        lease=lease,
    )

    with connect_archive(path, read_only=True) as connection:
        row = connection.execute(
            "SELECT state, expected_comment_count FROM crawl_frontier"
        ).fetchone()
    assert tuple(row) == ("done", 0)


@pytest.mark.parametrize(
    ("outcome", "error_code", "frontier_state"),
    [
        ("restricted", "permission_denied", "dead"),
        ("parse_failed", "parse_drift", "dead"),
        ("fetch_failed", "network_error", "retry"),
    ],
)
def test_non_stored_outcome_preserves_frontier_expectation(
    tmp_path: Path, outcome: str, error_code: str, frontier_state: str
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url, expected_comment_count=6)
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)

    store.record_outcome(
        run_id,
        url=url,
        outcome=outcome,
        fetched_at=_NOW,
        board_id="ss_temp01",
        external_post_id=7,
        error_code=error_code,
        lease=lease,
        frontier_state=frontier_state,
    )

    with connect_archive(path, read_only=True) as connection:
        assert (
            connection.execute("SELECT expected_comment_count FROM crawl_frontier").fetchone()[0]
            == 6
        )


def test_store_keeps_body_and_retries_when_comments_are_incomplete(
    tmp_path: Path,
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url, expected_comment_count=2)
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)

    result = store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="capture.warc.gz",
        lease=lease,
    )

    assert result.changed is True
    with connect_archive(path, read_only=True) as connection:
        post = connection.execute(
            "SELECT latest_version_id, comment_count FROM posts WHERE external_post_id = 7"
        ).fetchone()
        assert post["latest_version_id"] is not None
        assert post["comment_count"] == 1
        frontier_row = connection.execute(
            "SELECT state, last_error_code FROM crawl_frontier"
        ).fetchone()
        assert tuple(frontier_row) == ("retry", "incomplete_comments")


def test_listing_only_post_stores_its_body_when_comments_are_incomplete(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    # Inventory saw the post (5 comments on the listing) before any body was captured.
    store.store_discovered_post(
        DiscoveredPostItem(
            board_id="ss_temp01",
            external_post_id=7,
            canonical_url=url,
            title="listing title",
            author=None,
            category=None,
            created_at_raw=None,
            comment_count=5,
        ),
        seen_at=_NOW,
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, url, expected_comment_count=5)
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    run_id = store.start_run("sync", now=_NOW)

    result = store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="c.warc.gz", lease=lease
    )

    assert result.changed is True
    with connect_archive(path, read_only=True) as connection:
        assert (
            connection.execute(
                "SELECT latest_version_id FROM posts WHERE external_post_id = 7"
            ).fetchone()[0]
            is not None
        )
        frontier_row = connection.execute(
            "SELECT state, last_error_code FROM crawl_frontier"
        ).fetchone()
        assert tuple(frontier_row) == ("retry", "incomplete_comments")


def test_incomplete_comments_end_dead_after_the_capped_attempts(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="a.warc.gz")
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url, expected_comment_count=9)
    lease = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(minutes=1)
    )
    assert lease is not None
    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="b.warc.gz",
        lease=replace(lease, attempts=REDSTM_FRONTIER_MAX_ATTEMPTS),
    )
    with connect_archive(path, read_only=True) as connection:
        frontier_row = connection.execute(
            "SELECT state, last_error_code FROM crawl_frontier"
        ).fetchone()
        assert tuple(frontier_row) == ("dead", "incomplete_comments")


def test_partial_comment_retry_preserves_existing_projection(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    first = store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="first.warc.gz"
    )
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url, expected_comment_count=1)
    lease = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(minutes=1)
    )
    assert lease is not None
    second = store.store_post(
        run_id,
        _post(body="changed", comment=None),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="partial.warc.gz",
        lease=lease,
    )
    assert second.changed is False
    assert second.version_id == first.version_id
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1
        assert db.execute("SELECT comment_count FROM posts").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert db.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "retry"


def test_short_comment_capture_still_stores_a_changed_body(tmp_path: Path) -> None:
    # Not lossy: the capture has as many comments as the stored version, just fewer than the
    # listing count (hidden or deleted comments), so the edited body must not be discarded.
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    first = store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="first.warc.gz"
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7", expected_comment_count=3)
    lease = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(minutes=1)
    )
    assert lease is not None
    second = store.store_post(
        run_id,
        _post(body="edited"),
        captured_at=_NOW + timedelta(minutes=1),
        raw_sha256="b" * 64,
        warc_file="second.warc.gz",
        lease=lease,
    )
    assert second.changed is True
    assert second.version_id != first.version_id
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1
        row = db.execute("SELECT state, last_error_code FROM crawl_frontier").fetchone()
        assert tuple(row) == ("retry", "incomplete_comments")


def test_stale_replay_does_not_regress_view_counts(tmp_path: Path) -> None:
    # A later capture replaying an older page (stale cache) carries a lower origin view
    # counter. The projection keeps the higher value; a genuinely edited body still stores
    # and counts as changed (the revert contract of
    # test_return_to_a_prior_version_reactivates_that_projection is untouched).
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="first.warc.gz"
    )
    stale = store.store_post(
        run_id,
        replace(_post(body="stale replay"), views=3),
        captured_at=_NOW + timedelta(hours=1),
        raw_sha256="b" * 64,
        warc_file="second.warc.gz",
    )
    assert stale.changed is True
    fresh = store.store_post(
        run_id,
        replace(_post(body="fresh edit"), views=12),
        captured_at=_NOW + timedelta(hours=2),
        raw_sha256="c" * 64,
        warc_file="third.warc.gz",
    )
    assert fresh.changed is True
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT views FROM posts").fetchone()[0] == 12


def test_block_activity_summary_counts_recent_failures(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="one.warc.gz"
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert lease is not None
    store.record_outcome(
        run_id,
        url="https://www.typemoon.net/ss_temp01/7",
        outcome="fetch_failed",
        fetched_at=_NOW + timedelta(hours=1),
        http_status=429,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="rate_limited",
        raw_sha256="b" * 64,
        warc_file="two.warc.gz",
        lease=lease,
        frontier_state="retry",
    )
    store.record_outcome(
        run_id,
        url="https://www.typemoon.net/ss_temp01/7",
        outcome="missing",
        fetched_at=_NOW + timedelta(hours=2),
        http_status=404,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="not_found",
    )

    summary = store.block_activity_summary(days=28, now=_NOW + timedelta(days=1))

    assert summary["days"] == 28
    assert summary["by_day"] == {"2026-07-11": {"rate_limited": 1, "not_found": 1}}
    assert summary["removal_outcomes"] == {"missing": 1}


def test_conditional_hit_records_unchanged_without_touching_the_version(tmp_path: Path) -> None:
    # A 304 says "as you were": the stored version, comments, and projection stay
    # authoritative; the capture records outcome='unchanged' with http_status 304 and the
    # lease completes without a retry (docs/31 C5, newtomi F13 regression shape).
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
        etag='"v1"',
        last_modified="Fri, 10 Jul 2026 00:00:00 GMT",
    )
    assert store.latest_conditional_validator("https://www.typemoon.net/ss_temp01/7") == (
        '"v1"',
        "Fri, 10 Jul 2026 00:00:00 GMT",
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    lease = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(hours=1))
    assert lease is not None
    store.record_unmodified_post(
        run_id,
        url="https://www.typemoon.net/ss_temp01/7",
        captured_at=_NOW + timedelta(hours=1),
        http_status=304,
        lease=lease,
    )
    with pytest.raises(ValueError):
        store.record_unmodified_post(
            run_id,
            url="https://www.typemoon.net/ss_temp01/7",
            captured_at=_NOW + timedelta(hours=2),
            http_status=200,
        )
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1
        captures = [
            tuple(row)
            for row in db.execute("SELECT outcome, http_status FROM captures ORDER BY id")
        ]
        assert captures == [("stored", 200), ("unchanged", 304)]
        # The stale-revisit lane must move past a confirmed-unchanged post.
        assert db.execute("SELECT last_collected_at FROM posts").fetchone()[0] == (
            (_NOW + timedelta(hours=1)).isoformat()
        )
        assert tuple(db.execute("SELECT state, lease_token FROM crawl_frontier").fetchone()) == (
            "done",
            None,
        )


def test_validator_requires_a_stored_capture_with_validators(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    url = "https://www.typemoon.net/ss_temp01/7"
    store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="one.warc.gz"
    )
    assert store.latest_conditional_validator(url) is None
    store.record_outcome(
        run_id,
        url=url,
        outcome="fetch_failed",
        fetched_at=_NOW + timedelta(hours=1),
        http_status=429,
        error_code="rate_limited",
    )
    assert store.latest_conditional_validator(url) is None


def test_validator_may_carry_only_one_half(tmp_path: Path) -> None:
    # The origin is not required to send both validators; an ETag-only capture still
    # yields If-None-Match (docs/31 C5 — no artificial all-or-nothing constraint).
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    url = "https://www.typemoon.net/ss_temp01/7"
    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW,
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
        etag='"v1"',
    )
    assert store.latest_conditional_validator(url) == ('"v1"', None)


def test_crash_before_store_leaves_one_clean_capture(tmp_path: Path) -> None:
    # Forced-termination experiment 2 (response before store, docs/31 C6): the worker died
    # after the origin answered but before store_post. The lease expires, another claim
    # reclaims the row, and the fresh capture stores exactly once — no phantom duplicates.
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    reclaimed = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(seconds=61)
    )
    assert reclaimed is not None
    store.store_post(
        run_id,
        _post(),
        captured_at=_NOW + timedelta(seconds=62),
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
        lease=reclaimed,
    )
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM captures").fetchone()[0] == 1
        assert db.execute("SELECT outcome FROM captures").fetchone()[0] == "stored"
        assert db.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1


def test_crash_after_store_before_ack_replays_as_unchanged(tmp_path: Path) -> None:
    # Forced-termination experiment 3 (store committed, lease-complete lost, docs/31 C6):
    # the identical body re-stores idempotently — the version and comments are reused, the
    # replays land as exactly two captures ('stored' then 'unchanged'), and the frontier
    # settles as done.
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    store.store_post(
        run_id, _post(), captured_at=_NOW, raw_sha256="a" * 64, warc_file="one.warc.gz"
    )
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    reclaimed = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(seconds=61)
    )
    assert reclaimed is not None
    replay = store.store_post(
        run_id,
        _post(),
        captured_at=_NOW + timedelta(seconds=62),
        raw_sha256="a" * 64,
        warc_file="one.warc.gz",
        lease=reclaimed,
    )
    assert replay.changed is False
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1
        outcomes = [row[0] for row in db.execute("SELECT outcome FROM captures ORDER BY id")]
        assert outcomes == ["stored", "unchanged"]
        assert db.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "done"


def test_stale_lease_write_is_fenced(tmp_path: Path) -> None:
    # Forced-termination experiment 4 at the store boundary (docs/31 C6): after another
    # worker reclaims an expired lease, the original worker's store_post rolls back
    # entirely — no capture, no version, no post row.
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync", now=_NOW)
    frontier = FrontierStore(path)
    frontier.seed("ss_temp01", 7, "https://www.typemoon.net/ss_temp01/7")
    stale = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert stale is not None
    assert (
        frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(seconds=61))
        is not None
    )
    with pytest.raises(RuntimeError, match="stale or missing frontier lease"):
        store.store_post(
            run_id,
            _post(),
            captured_at=_NOW + timedelta(seconds=62),
            raw_sha256="a" * 64,
            warc_file="one.warc.gz",
            lease=stale,
        )
    with connect_archive(path, read_only=True) as db:
        assert db.execute("SELECT COUNT(*) FROM captures").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 0


def test_retry_backoff_keeps_network_failures_retryable(tmp_path: Path) -> None:
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

    held = _escalated(REDSTM_FRONTIER_MAX_ATTEMPTS + 4, "auth-token")
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

    capped = _escalated(REDSTM_FRONTIER_MAX_ATTEMPTS, "network-token")
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
        assert row["state"] == "retry"
        assert row["next_attempt_at"] == "2026-07-11T02:32:00+00:00"
        assert row["last_error_code"] == "network_error"

    # The same post failing on the network for its whole long budget is broken at the origin:
    # it stops as origin_unresponsive (not auto-revived like a network_error dead row).
    broken = _escalated(REDSTM_NETWORK_MAX_ATTEMPTS, "broken-token")
    store.record_outcome(
        run_id,
        url=broken.url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        board_id="ss_temp01",
        external_post_id=7,
        error_code="network_error",
        lease=broken,
        frontier_state="retry",
    )
    with connect_archive(path) as connection:
        row = connection.execute(
            "SELECT state, next_attempt_at, last_error_code FROM crawl_frontier"
        ).fetchone()
        assert row["state"] == "dead"
        assert row["next_attempt_at"] is None
        assert row["last_error_code"] == "origin_unresponsive"


def test_not_found_requires_two_runs_and_rate_limit_honors_retry_after(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    frontier = FrontierStore(path)
    url = "https://www.typemoon.net/ss_temp01/7"
    frontier.seed("ss_temp01", 7, url)

    first_run = store.start_run("sync", now=_NOW)
    first = frontier.claim_identity("ss_temp01", 7, lease_seconds=60, now=_NOW)
    assert first is not None
    store.record_outcome(
        first_run,
        url=url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        error_code="not_found",
        lease=first,
        frontier_state="retry",
    )
    store.finish_run(first_run, status="partial", now=_NOW)

    second_run = store.start_run("sync", now=_NOW + timedelta(minutes=2))
    second = frontier.claim_identity(
        "ss_temp01", 7, lease_seconds=60, now=_NOW + timedelta(minutes=2)
    )
    assert second is not None
    store.record_outcome(
        second_run,
        url=url,
        outcome="fetch_failed",
        fetched_at=_NOW + timedelta(minutes=2),
        error_code="not_found",
        lease=second,
        frontier_state="retry",
    )

    frontier.seed("ss_temp01", 8, "https://www.typemoon.net/ss_temp01/8")
    limited = frontier.claim_identity("ss_temp01", 8, lease_seconds=60, now=_NOW)
    assert limited is not None
    store.record_outcome(
        second_run,
        url=limited.url,
        outcome="fetch_failed",
        fetched_at=_NOW,
        error_code="rate_limited",
        lease=limited,
        frontier_state="retry",
        retry_after_at=_NOW + timedelta(minutes=30),
    )

    with connect_archive(path, read_only=True) as connection:
        assert [
            row["outcome"]
            for row in connection.execute(
                "SELECT outcome FROM captures WHERE url = ? ORDER BY id", (url,)
            )
        ] == ["fetch_failed", "missing"]
        rows = {
            row["external_post_id"]: (row["state"], row["next_attempt_at"])
            for row in connection.execute(
                "SELECT external_post_id, state, next_attempt_at FROM crawl_frontier"
            )
        }
    assert rows[7] == ("done", None)
    assert rows[8] == ("retry", "2026-07-11T02:30:00+00:00")


def test_listing_refresh_preserves_full_title_and_uses_separate_listing_metadata(
    tmp_path: Path,
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    frontier = FrontierStore(path)
    post = replace(_post(), title="The complete title of the captured post")
    run = store.start_run("sync", now=_NOW)
    frontier.seed(
        post.board_id,
        post.external_post_id,
        post.canonical_url,
        listing_sha256=listing_fingerprint("The complete...", None, 1),
    )
    lease = frontier.claim_identity(post.board_id, post.external_post_id, lease_seconds=60)
    store.store_post(run, post, captured_at=_NOW, raw_sha256=None, warc_file=None, lease=lease)
    store.store_discovered_post(
        DiscoveredPostItem(
            board_id=post.board_id,
            external_post_id=post.external_post_id,
            canonical_url=post.canonical_url,
            title="The complete...",
            comment_count=1,
        )
    )
    with connect_archive(path) as connection:
        assert connection.execute("SELECT title FROM posts").fetchone()[0] == post.title
    assert frontier.listing_is_unchanged(
        post.board_id,
        post.external_post_id,
        title="The complete...",
        category=None,
        comment_count=1,
    )
    assert not frontier.listing_is_unchanged(
        post.board_id,
        post.external_post_id,
        title="A changed title...",
        category=None,
        comment_count=1,
    )
