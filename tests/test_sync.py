from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from scrapy import Request
from scrapy.http import HtmlResponse

from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.items import CapturedPostItem
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore
from scripts.sync import _capture_summary

_FIXTURES = Path(__file__).parent / "fixtures" / "typemoon"


def _session() -> SessionExport:
    now = datetime(2026, 7, 11, tzinfo=UTC)
    return SessionExport(
        (SessionCookie("PHPSESSID", "secret", ".typemoon.net", "/", True, True),),
        now,
        now + timedelta(hours=4),
        "ReDSTM-test/1.0",
    )


def _initialize(path: Path) -> None:
    initialize_archive(path)
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('write_free21', 'Board', 'https://www.typemoon.net/write_free21',
                    '2026-07-11T00:00:00+00:00', '2026-07-11T00:00:00+00:00')
            """
        )


def _run_fixture(path: Path, run_id: str) -> None:
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_posts=1,
    )
    listing_url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        listing_url,
        request=Request(
            listing_url,
            meta={
                "raw_sha256": "b" * 64,
                "warc_file": "listing.warc.gz",
                "warc_record_id": "<urn:uuid:listing>",
            },
        ),
        body=(_FIXTURES / "listing.html").read_bytes(),
        encoding="utf-8",
    )
    outputs = list(spider.parse_listing(listing))
    [detail_request] = [output for output in outputs if isinstance(output, Request)]
    assert detail_request.cookies
    detail = HtmlResponse(
        detail_request.url,
        request=detail_request,
        body=(_FIXTURES / "detail.html").read_bytes(),
        encoding="utf-8",
    )
    [item] = list(spider.parse_detail(detail))
    assert isinstance(item, CapturedPostItem)
    ArchivePipeline(path, run_id).process_item(item, spider)


def test_bounded_sync_fixture_is_idempotent_across_runs(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    first_run = store.start_run("sync")
    _run_fixture(path, first_run)
    store.finish_run(first_run, status="succeeded", discovered=1)

    second_run = store.start_run("sync")
    _run_fixture(path, second_run)
    store.finish_run(second_run, status="succeeded", discovered=1)

    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert [
            row[0]
            for row in connection.execute(
                "SELECT outcome FROM captures WHERE entity_type = 'post' ORDER BY id"
            )
        ] == ["stored", "unchanged"]
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM captures WHERE entity_type = 'listing'"
            ).fetchone()[0]
            == 2
        )
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "done"
    assert _capture_summary(path, second_run) == {"unchanged": 2}


def test_failed_detail_records_retry_without_error_text(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_posts=1,
    )
    listing_url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        listing_url,
        request=Request(listing_url),
        body=(_FIXTURES / "listing.html").read_bytes(),
        encoding="utf-8",
    )
    [detail_request] = [
        output for output in spider.parse_listing(listing) if isinstance(output, Request)
    ]

    spider.detail_error(SimpleNamespace(request=detail_request, value=OSError("secret detail")))

    with connect_archive(path) as connection:
        capture = connection.execute(
            "SELECT outcome, error_code FROM captures WHERE entity_type = 'post'"
        ).fetchone()
        assert tuple(capture) == ("fetch_failed", "network_error")
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "retry"
