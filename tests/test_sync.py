from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request as UrlRequest

import pytest
from scrapy import Request
from scrapy.http import HtmlResponse

from crawler import settings as crawler_settings
from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.items import CapturedPostItem
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore
from scripts.healthcheck import notify_dead_man, ping_success
from scripts.recover_queue import _parse_args as parse_recovery_args
from scripts.sync import _capture_failure_codes, _capture_summary, _run_status
from scripts.sync import _parse_args as parse_sync_args

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


def _run_fixture(path: Path, run_id: str) -> int:
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
    detail_requests = [output for output in outputs if isinstance(output, Request)]
    if not detail_requests:
        return 0
    [detail_request] = detail_requests
    assert detail_request.cookies
    detail_body = (_FIXTURES / "detail.html").read_bytes().replace(
        "대표 상세 게시물".encode(), "대표 게시물".encode()
    )
    detail_body = detail_body.replace(
        b"</section>",
        b"<div class='view-comment-item'><div class='comment-cont-txt'>2</div></div>"
        b"<div class='view-comment-item'><div class='comment-cont-txt'>3</div></div>"
        b"<div class='view-comment-item'><div class='comment-cont-txt'>4</div></div></section>",
    )
    detail = HtmlResponse(
        detail_request.url,
        request=detail_request,
        body=detail_body,
        encoding="utf-8",
    )
    [item] = list(spider.parse_detail(detail))
    assert isinstance(item, CapturedPostItem)
    ArchivePipeline(path, run_id).process_item(item)
    return 1


def test_bounded_sync_fixture_is_idempotent_across_runs(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    first_run = store.start_run("sync")
    first_scheduled = _run_fixture(path, first_run)
    store.finish_run(first_run, status="succeeded", discovered=first_scheduled)

    second_run = store.start_run("sync")
    second_scheduled = _run_fixture(path, second_run)
    store.finish_run(second_run, status="succeeded", discovered=second_scheduled)

    with connect_archive(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0] == 1
        assert [
            row[0]
            for row in connection.execute(
                "SELECT outcome FROM captures WHERE entity_type = 'post' ORDER BY id"
            )
        ] == ["stored"]
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM captures WHERE entity_type = 'listing'"
            ).fetchone()[0]
            == 2
        )
        assert connection.execute("SELECT state FROM crawl_frontier").fetchone()[0] == "done"
    assert first_scheduled == 1
    assert second_scheduled == 0
    assert _capture_summary(path, second_run) == {}


def test_listing_metadata_change_reopens_known_post(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    first_run = store.start_run("sync")
    assert _run_fixture(path, first_run) == 1
    store.finish_run(first_run, status="succeeded", discovered=1)
    with connect_archive(path) as connection:
        connection.execute("UPDATE posts SET comment_count = 3")
    run_id = store.start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_posts=1,
    )
    url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        url,
        request=Request(url),
        body=(_FIXTURES / "listing.html").read_bytes(),
        encoding="utf-8",
    )

    requests = [item for item in spider.parse_listing(listing) if isinstance(item, Request)]

    assert len(requests) == 1
    assert requests[0].url.endswith("/write_free21/62068")


def test_overlap_boundary_stops_next_listing_page(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    with connect_archive(path) as connection:
        connection.executemany(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title, first_seen_at,
                last_seen_at, comment_count
            ) VALUES ('write_free21', ?, ?, ?, 'now', 'now', 0)
            """,
            [
                (post_id, f"https://www.typemoon.net/write_free21/{post_id}", f"post {post_id}")
                for post_id in range(1, 21)
            ],
        )
    rows = "".join(
        f"<tr><td class='td-subj-wrap'><a href='/write_free21/{post_id}'>"
        f"<span class='subject'>post {post_id}</span></a></td></tr>"
        for post_id in range(1, 21)
    )
    url = "https://www.typemoon.net/write_free21"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=f"<table><tbody>{rows}</tbody></table>".encode(),
        encoding="utf-8",
    )
    run_id = ArchiveStore(path).start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_pages=2,
    )

    requests = [item for item in spider.parse_listing(response) if isinstance(item, Request)]

    assert requests == []
    assert spider.scheduled_posts == 0

    inventory = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_pages=2,
        inventory=True,
    )
    inventory_requests = [
        item for item in inventory.parse_listing(response) if isinstance(item, Request)
    ]
    assert [request.url for request in inventory_requests] == [f"{url}?page=2"]


def test_listing_warning_disables_overlap_boundary(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    with connect_archive(path) as connection:
        connection.executemany(
            """
            INSERT INTO posts (
                board_id, external_post_id, canonical_url, title, first_seen_at,
                last_seen_at, comment_count
            ) VALUES ('write_free21', ?, ?, ?, 'now', 'now', 0)
            """,
            [
                (post_id, f"https://www.typemoon.net/write_free21/{post_id}", f"post {post_id}")
                for post_id in range(1, 21)
            ],
        )
    rows = "".join(
        f"<tr><td class='td-subj-wrap'><a href='/write_free21/{post_id}'>"
        f"<span class='subject'>post {post_id}</span></a></td></tr>"
        for post_id in range(1, 21)
    )
    url = "https://www.typemoon.net/write_free21"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=(
            f"<table><tbody>{rows}"
            "<tr><td class='td-subj-wrap'></td></tr></tbody></table>"
        ).encode(),
        encoding="utf-8",
    )
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_pages=2,
    )

    requests = [item for item in spider.parse_listing(response) if isinstance(item, Request)]

    assert [request.url for request in requests] == [f"{url}?page=2"]


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
    assert _capture_failure_codes(path, run_id) == ["network_error"]


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


def test_slow_detail_defaults_keep_rate_and_lease_bounds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    archive = tmp_path / "archive.sqlite"
    archive.touch()
    assert crawler_settings.DOWNLOAD_DELAY == 10.0
    assert crawler_settings.AUTOTHROTTLE_ENABLED is True
    assert crawler_settings.AUTOTHROTTLE_MAX_DELAY == 60.0
    assert crawler_settings.DOWNLOAD_MAXSIZE == 64 << 20
    assert crawler_settings.REDSTM_FRONTIER_LEASE_SECONDS == 900
    assert crawler_settings.REDSTM_LISTING_TIMEOUT_SECONDS == 60
    assert TypeMoonSpider().listing_request("write").meta["download_timeout"] == 60
    assert "download_timeout" not in TypeMoonSpider().detail_request(
        "write", 1, _session()
    ).meta

    monkeypatch.setattr("sys.argv", ["sync", "--archive", str(archive), "--board", "write"])
    assert parse_sync_args().lease_seconds == 900
    assert parse_sync_args().session_prevalidated is False
    monkeypatch.setattr(
        "sys.argv",
        ["sync", "--archive", str(archive), "--board", "write", "--session-prevalidated"],
    )
    assert parse_sync_args().session_prevalidated is True
    monkeypatch.setattr("sys.argv", ["recover", "--archive", str(archive)])
    assert parse_recovery_args().lease_seconds == 900


def test_healthcheck_ping_requires_secret_free_https(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []

    class Response:
        def close(self) -> None:
            pass

    def open_request(request: UrlRequest, timeout: int) -> Response:
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

    def open_request(request: UrlRequest, timeout: int) -> Response:
        opened.append(request.full_url)
        return Response()

    monkeypatch.setattr("scripts.healthcheck.urlopen", open_request)
    url = "https://hc.example.test/uuid"
    notify_dead_man(False, url)
    notify_dead_man(True, "")
    assert opened == []
    notify_dead_man(True, url)
    assert opened == [url]

    def unavailable(request: UrlRequest, timeout: int) -> Response:
        raise OSError("monitor unavailable")

    monkeypatch.setattr("scripts.healthcheck.urlopen", unavailable)
    notify_dead_man(True, url)
