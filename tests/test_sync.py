from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from scrapy import Request
from scrapy.http import HtmlResponse

from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.items import CapturedPostItem
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore
from scripts.healthcheck import notify_dead_man, ping_success
from scripts.sync import _capture_summary, _run_status

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
    ArchivePipeline(path, run_id).process_item(item)


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
    assert _capture_summary(path, second_run) == {"unchanged": 1}


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


def test_sync_claims_only_one_detail_lease_at_a_time(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    run_id = ArchiveStore(path).start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_posts=2,
    )
    url = "https://www.typemoon.net/write_free21"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=b"""
        <table><tbody>
          <tr><td class='td-subj-wrap'><a href='/write_free21/1'>
            <span class='subject'>one</span></a></td></tr>
          <tr><td class='td-subj-wrap'><a href='/write_free21/2'>
            <span class='subject'>two</span></a></td></tr>
        </tbody></table>
        """,
        encoding="utf-8",
    )

    requests = [item for item in spider.parse_listing(response) if isinstance(item, Request)]

    assert len(requests) == 1
    with connect_archive(path, read_only=True) as connection:
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, state FROM crawl_frontier ORDER BY external_post_id"
            )
        ] == [(1, "running"), (2, "pending")]


def test_listing_failure_and_incomplete_capture_cannot_succeed() -> None:
    spider = TypeMoonSpider()
    response = HtmlResponse(
        "https://www.typemoon.net/write_free21",
        request=Request("https://www.typemoon.net/write_free21"),
        body=b"<html><body>maintenance</body></html>",
        encoding="utf-8",
    )

    assert list(spider.parse_listing(response)) == []
    assert spider.failure_codes == {"listing_parse_failed"}
    assert _run_status({}, 0, sorted(spider.failure_codes)) == "failed"
    assert _run_status({"stored": 1}, 2, []) == "partial"
    assert _run_status({"stored": 1}, 1, []) == "succeeded"


def test_healthcheck_ping_requires_secret_free_https(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []

    class Response:
        def close(self) -> None:
            pass

    def open_request(request: Request, timeout: int) -> Response:
        opened.append(request.full_url)
        assert timeout == 15
        return Response()

    monkeypatch.setattr("scripts.healthcheck.urlopen", open_request)
    ping_success("https://hc.example.test/uuid")
    assert opened == ["https://hc.example.test/uuid"]
    with pytest.raises(ValueError, match="credential-free HTTPS"):
        ping_success("https://user:secret@hc.example.test/uuid")


def test_dead_man_ping_skips_partial_and_failed_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []

    class Response:
        def close(self) -> None:
            pass

    monkeypatch.setattr(
        "scripts.healthcheck.urlopen",
        lambda request, timeout: opened.append(request.full_url) or Response(),
    )
    url = "https://hc.example.test/uuid"
    notify_dead_man(False, url)
    notify_dead_man(True, "")
    assert opened == []
    notify_dead_man(True, url)
    assert opened == [url]
