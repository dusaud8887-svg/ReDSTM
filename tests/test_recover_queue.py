from __future__ import annotations

import asyncio
from argparse import Namespace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from scrapy import Request
from scrapy.http import HtmlResponse

from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.frontier import FrontierStore
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonRecoverySpider
from crawler.store import ArchiveStore
from scripts.recover_queue import run_recovery

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


async def _collect_start(spider: TypeMoonRecoverySpider) -> list[Request]:
    return [request async for request in spider.start()]


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
