from __future__ import annotations

import asyncio
from argparse import Namespace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from scrapy import Request
from scrapy.http import HtmlResponse

from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.frontier import FrontierStore
from crawler.items import CapturedPostItem
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonRecoverySpider
from crawler.store import ArchiveStore
from scripts.recover_queue import _parse_args as parse_recovery_args
from scripts.recover_queue import _recovery_batch, run_recovery

_FIXTURE = Path(__file__).parent / "fixtures" / "typemoon" / "detail.html"
_NOW = datetime(2026, 7, 11, tzinfo=UTC)


def _session() -> SessionExport:
    return SessionExport(
        (SessionCookie("PHPSESSID", "secret", ".typemoon.net", "/", True, True),),
        _NOW,
        _NOW + timedelta(hours=4),
        "ReDSTM-test/1.0",
    )


def test_recovery_priority_bound_and_idempotent_transition(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    boards = [
        ("forum01", "misc"),
        ("ss_temp01", "fanfic"),
        ("write_free21", "creation"),
        ("aa_a01", "aa"),
    ]
    with connect_archive(archive) as connection:
        connection.executemany(
            """
            INSERT INTO boards (
                board_id, name, group_name, canonical_url, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, 'https://www.typemoon.net/' || ?, ?, ?)
            """,
            [
                (board_id, board_id, group, board_id, _NOW.isoformat(), _NOW.isoformat())
                for board_id, group in boards
            ],
        )
    frontier = FrontierStore(archive)
    for board_id, _ in boards:
        frontier.seed(board_id, 62068, f"https://www.typemoon.net/{board_id}/62068")

    candidates = frontier.recovery_candidates(limit=3, now=_NOW)
    assert candidates == [
        ("aa_a01", 62068),
        ("write_free21", 62068),
        ("ss_temp01", 62068),
    ]
    assert frontier.recovery_candidates(
        limit=3,
        now=_NOW,
        board_id="forum01",
    ) == [("forum01", 62068)]
    assert _recovery_batch(
        frontier,
        limit=2,
        now=_NOW,
        board_id="forum01",
    ) == ([("forum01", 62068)], 0)
    with connect_archive(archive, read_only=True) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM crawl_frontier WHERE state = 'pending'"
            ).fetchone()[0]
            == 4
        )

    store = ArchiveStore(archive)
    run_id = store.start_run("retry")
    spider = TypeMoonRecoverySpider(
        candidates=candidates[:1],
        archive_path=archive,
        run_id=run_id,
        session=_session(),
        lease_seconds=60,
    )
    [request] = asyncio.run(_collect_start(spider))
    response = HtmlResponse(
        request.url,
        request=request,
        body=_FIXTURE.read_bytes(),
        encoding="utf-8",
    )
    [item] = list(spider._parse_recovery_detail(response))
    ArchivePipeline(archive, run_id).process_item(item)

    with connect_archive(archive, read_only=True) as connection:
        assert (
            connection.execute(
                "SELECT state FROM crawl_frontier WHERE board_id = 'aa_a01'"
            ).fetchone()[0]
            == "done"
        )
    assert frontier.recovery_candidates(limit=1, now=_NOW) == [("write_free21", 62068)]


def test_recovery_uses_free_slots_for_oldest_stale_details(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
        connection.executemany(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title,
                first_seen_at, last_seen_at, last_collected_at
            ) VALUES ('aa_a01', ?, ?, ?, 'now', 'now', ?)
            """,
            [
                (2, "https://www.typemoon.net/aa_a01/2", "oldest", "2025-01-01T00:00:00Z"),
                (3, "https://www.typemoon.net/aa_a01/3", "older", "2025-02-01T00:00:00Z"),
                (4, "https://www.typemoon.net/aa_a01/4", "fresh", "2026-07-01T00:00:00Z"),
            ],
        )
    frontier = FrontierStore(archive)
    for external_post_id in range(1, 5):
        frontier.seed(
            "aa_a01",
            external_post_id,
            f"https://www.typemoon.net/aa_a01/{external_post_id}",
        )
    with connect_archive(archive) as connection:
        connection.execute("UPDATE crawl_frontier SET state = 'done' WHERE external_post_id > 1")

    candidates, revisited = _recovery_batch(frontier, limit=3, now=_NOW)

    assert candidates == [("aa_a01", 1), ("aa_a01", 2), ("aa_a01", 3)]
    assert revisited == 2
    with connect_archive(archive, read_only=True) as connection:
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, state FROM crawl_frontier ORDER BY external_post_id"
            )
        ] == [(1, "pending"), (2, "pending"), (3, "pending"), (4, "done")]

    with connect_archive(archive) as connection:
        connection.execute(
            "UPDATE crawl_frontier SET state = 'done' WHERE external_post_id IN (2, 3)"
        )
    for external_post_id in (5, 6):
        frontier.seed(
            "aa_a01",
            external_post_id,
            f"https://www.typemoon.net/aa_a01/{external_post_id}",
        )

    candidates, revisited = _recovery_batch(frontier, limit=3, now=_NOW)

    assert candidates == [("aa_a01", 1), ("aa_a01", 5), ("aa_a01", 2)]
    assert revisited == 1
    with connect_archive(archive, read_only=True) as connection:
        states = {
            int(row["external_post_id"]): str(row["state"])
            for row in connection.execute("SELECT external_post_id, state FROM crawl_frontier")
        }
    assert states[2] == "pending"
    assert states[3] == "done"
    assert states[6] == "pending"

    with connect_archive(archive) as connection:
        connection.execute(
            "UPDATE crawl_frontier SET state = 'done', expected_comment_count = 2 "
            "WHERE external_post_id = 2"
        )
        connection.execute("UPDATE posts SET comment_count = 1 WHERE external_post_id = 2")
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('a_other', 'Other', 'https://www.typemoon.net/a_other', 'now', 'now')
            """
        )
        connection.execute(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title,
                first_seen_at, last_seen_at, last_collected_at
            ) VALUES ('a_other', 9, 'https://www.typemoon.net/a_other/9', 'older',
                      'now', 'now', '2024-01-01T00:00:00Z')
            """
        )
    frontier.seed("a_other", 9, "https://www.typemoon.net/a_other/9")
    with connect_archive(archive) as connection:
        connection.execute("UPDATE crawl_frontier SET state = 'done' WHERE board_id = 'a_other'")
    assert frontier.requeue_stale_details(
        limit=1,
        stale_before=_NOW - timedelta(days=30),
        board_id="aa_a01",
    ) == [("aa_a01", 2)]
    spider = TypeMoonRecoverySpider(
        candidates=[("aa_a01", 2)],
        archive_path=archive,
        run_id=ArchiveStore(archive).start_run("retry"),
        session=_session(),
        lease_seconds=60,
    )
    [request] = asyncio.run(_collect_start(spider))
    assert request.url.endswith("/aa_a01/2")
    assert request.meta["expected_comment_count"] == 2


def test_stale_revisit_includes_restricted_done_without_a_post_row(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
    frontier = FrontierStore(archive)
    url = "https://www.typemoon.net/aa_a01/7"
    frontier.seed("aa_a01", 7, url)
    attempted_at = datetime(2025, 1, 1, tzinfo=UTC)
    lease = frontier.claim_identity("aa_a01", 7, lease_seconds=60, now=attempted_at)
    assert lease is not None
    store = ArchiveStore(archive)
    run_id = store.start_run("retry", now=attempted_at)
    store.record_outcome(
        run_id,
        url=url,
        outcome="restricted",
        fetched_at=attempted_at,
        board_id="aa_a01",
        external_post_id=7,
        error_code="permission_denied",
        lease=lease,
        frontier_state="done",
    )

    with connect_archive(archive, read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 0
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "done"

    candidates, revisited = _recovery_batch(frontier, limit=1, now=_NOW)

    assert candidates == [("aa_a01", 7)]
    assert revisited == 1
    with connect_archive(archive, read_only=True) as connection:
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "pending"


async def _collect_start(spider: TypeMoonRecoverySpider) -> list[Request]:
    return [request async for request in spider.start()]


def test_recovery_cli_limits_dead_requeue(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "sys.argv",
        [
            "recover",
            "--archive",
            str(tmp_path / "archive.sqlite"),
            "--max-posts",
            "7",
            "--requeue-dead",
            "parse_drift",
        ],
    )

    args = parse_recovery_args()

    assert args.max_posts == 7
    assert args.requeue_dead == "parse_drift"


@pytest.mark.parametrize(
    ("status", "failure_code"), [(None, "network_error"), (429, "rate_limited")]
)
def test_recovery_stops_after_three_consecutive_site_failures(
    tmp_path: Path, status: int | None, failure_code: str
) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
    frontier = FrontierStore(archive)
    for external_post_id in range(1, 5):
        frontier.seed(
            "aa_a01",
            external_post_id,
            f"https://www.typemoon.net/aa_a01/{external_post_id}",
        )
    run_id = ArchiveStore(archive).start_run("retry")
    spider = TypeMoonRecoverySpider(
        candidates=[("aa_a01", external_post_id) for external_post_id in range(1, 5)],
        archive_path=archive,
        run_id=run_id,
        session=_session(),
        lease_seconds=60,
        detail_concurrency=1,
    )
    [request] = asyncio.run(_collect_start(spider))

    for attempt in range(3):
        value: object = OSError("offline")
        if status is not None:
            value = SimpleNamespace(
                response=HtmlResponse(request.url, request=request, status=status)
            )
        next_requests = list(spider._recovery_error(SimpleNamespace(request=request, value=value)))
        if attempt < 2:
            [request] = next_requests
        else:
            assert next_requests == []

    assert spider.scheduled_posts == 3
    assert spider.failure_codes == {failure_code}


def test_recovery_stops_on_auth_response(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
    frontier = FrontierStore(archive)
    for external_post_id in (1, 2):
        frontier.seed(
            "aa_a01",
            external_post_id,
            f"https://www.typemoon.net/aa_a01/{external_post_id}",
        )
    run_id = ArchiveStore(archive).start_run("retry")
    spider = TypeMoonRecoverySpider(
        candidates=[("aa_a01", 1), ("aa_a01", 2)],
        archive_path=archive,
        run_id=run_id,
        session=_session(),
        lease_seconds=60,
        detail_concurrency=1,
    )
    [request] = asyncio.run(_collect_start(spider))
    response = HtmlResponse(
        request.url,
        request=request,
        body=b"<form action='/bbs/login_check.php'>",
        encoding="utf-8",
    )

    [item] = list(spider._parse_recovery_detail(response))

    assert isinstance(item, CapturedPostItem)
    assert item["warnings"] == ["auth_required"]
    assert spider.failure_codes == {"auth_required"}
    assert spider.scheduled_posts == 1


def test_recovery_pause_marker_prevents_frontier_claim(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
    frontier = FrontierStore(archive)
    frontier.seed("aa_a01", 1, "https://www.typemoon.net/aa_a01/1")
    pause_file = tmp_path / "schedule.paused"
    pause_file.touch()
    spider = TypeMoonRecoverySpider(
        candidates=[("aa_a01", 1)],
        archive_path=archive,
        run_id=ArchiveStore(archive).start_run("retry"),
        session=_session(),
        pause_file=pause_file,
    )

    assert asyncio.run(_collect_start(spider)) == []
    assert spider.paused is True
    with connect_archive(archive, read_only=True) as connection:
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "pending"


def test_empty_recovery_writes_success_report_without_session_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    ArchiveStore(archive).start_run("sync", now=_NOW)
    pings: list[bool] = []
    monkeypatch.setattr(
        "scripts.recover_queue.ensure_session_export",
        lambda *args, **kwargs: pytest.fail("empty recovery must not validate a session"),
    )
    monkeypatch.setattr(
        "scripts.recover_queue.notify_dead_man",
        lambda succeeded, url: pings.append(succeeded),
    )

    report = run_recovery(
        Namespace(
            archive=archive,
            session=tmp_path / "session.json",
            warc_dir=tmp_path / "warc",
            max_posts=5,
            max_seconds=60,
            lease_seconds=60,
        )
    )

    assert report["ok"] is True
    assert report["selected_posts"] == report["scheduled_posts"] == 0
    assert report["outcomes"] == {}
    assert report["interrupted_runs"] == 1
    assert pings == [True]


def test_recovery_report_includes_capture_failure_codes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', 'now', 'now')
            """
        )
    frontier = FrontierStore(archive)
    frontier.seed("aa_a01", 62068, "https://www.typemoon.net/aa_a01/62068")
    monkeypatch.setattr(
        "scripts.recover_queue.ensure_session_export", lambda *args, **kwargs: _session()
    )

    class FakeCrawler:
        spider = None

        class Stats:
            @staticmethod
            def get_value(name: str) -> str | None:
                return "closespider_timeout" if name == "finish_reason" else None

        stats = Stats()

    class FakeProcess:
        def __init__(self, settings: object) -> None:
            pass

        def create_crawler(self, spider: object) -> FakeCrawler:
            return FakeCrawler()

        def crawl(self, crawler: FakeCrawler, **kwargs: object) -> None:
            pass

        def start(self, *, stop_after_crawl: bool) -> None:
            pass

    monkeypatch.setattr("scripts.recover_queue.CrawlerProcess", FakeProcess)
    monkeypatch.setattr(
        "scripts.recover_queue._capture_failure_codes",
        lambda archive, run_id: ["auth_required"],
    )

    report = run_recovery(
        Namespace(
            archive=archive,
            session=tmp_path / "session.json",
            warc_dir=tmp_path / "warc",
            max_posts=1,
            max_seconds=60,
            lease_seconds=60,
        )
    )

    assert report["ok"] is False
    assert report["failures"] == ["auth_required", "recovery_time_budget"]
