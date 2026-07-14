from __future__ import annotations

import json
from argparse import Namespace
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.request import Request as UrlRequest

import pytest
from scrapy import Request
from scrapy.http import HtmlResponse, Response

from crawler import settings as crawler_settings
from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.frontier import FrontierStore
from crawler.items import CapturedPostItem, DiscoveredPostItem
from crawler.session import SessionCookie, SessionExport
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore
from scripts.healthcheck import notify_dead_man, ping_success
from scripts.recover_queue import _parse_args as parse_recovery_args
from scripts.sync import (
    _capture_failure_codes,
    _capture_summary,
    _project_settings,
    _run_status,
    _timed_out,
    run_sync,
)
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


def _detail_requests(outputs: Sequence[object]) -> list[Request]:
    return [
        output
        for output in outputs
        if isinstance(output, Request) and "frontier_lease" in output.meta
    ]


def _listing_requests(outputs: Sequence[object]) -> list[Request]:
    return [
        output
        for output in outputs
        if isinstance(output, Request) and "frontier_lease" not in output.meta
    ]


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
    detail_requests = _detail_requests(outputs)
    if not detail_requests:
        return 0
    [detail_request] = detail_requests
    assert detail_request.cookies
    detail_body = (
        (_FIXTURES / "detail.html")
        .read_bytes()
        .replace("대표 상세 게시물".encode(), "대표 게시물".encode())
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


def test_prevalidated_worker_loads_an_authenticated_expired_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    session_path = tmp_path / "session.json"
    session_path.write_text(
        json.dumps(
            {
                "cookies": [
                    {
                        "name": "PHPSESSID",
                        "value": "secret",
                        "domain": ".typemoon.net",
                        "path": "/",
                        "secure": True,
                        "httpOnly": True,
                    }
                ],
                "created_at": "2000-01-01T00:00:00+00:00",
                "expires_at": "2000-01-01T04:00:00+00:00",
                "user_agent": "ReDSTM-test/1.0",
            }
        ),
        encoding="utf-8",
    )

    class WorkerReachedError(RuntimeError):
        pass

    def process(settings: object) -> None:
        raise WorkerReachedError

    monkeypatch.setattr("scripts.sync.CrawlerProcess", process)

    with pytest.raises(WorkerReachedError):
        run_sync(
            Namespace(
                archive=path,
                board="write_free21",
                session=session_path,
                session_prevalidated=True,
                warc_dir=tmp_path / "warc",
                pause_file=None,
                parent_lock_held=True,
                inventory=False,
                max_seconds=60,
                max_pages=1,
                max_posts=1,
                lease_seconds=60,
            )
        )


def test_listing_metadata_change_reopens_known_post(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    first_run = store.start_run("sync")
    assert _run_fixture(path, first_run) == 1
    store.finish_run(first_run, status="succeeded", discovered=1)
    with connect_archive(path) as connection:
        connection.execute("UPDATE posts SET comment_count = 3")
        connection.execute("UPDATE crawl_frontier SET expected_comment_count = 1")
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

    requests = _detail_requests(list(spider.parse_listing(listing)))

    assert len(requests) == 1
    assert requests[0].url.endswith("/write_free21/62068")
    assert requests[0].meta["expected_comment_count"] == 4
    with connect_archive(path, read_only=True) as connection:
        assert (
            connection.execute("SELECT expected_comment_count FROM crawl_frontier").fetchone()[0]
            == 4
        )


def test_incremental_anchor_requires_configured_overlap_page(tmp_path: Path) -> None:
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
                (100, "https://www.typemoon.net/write_free21/100", "anchor"),
                (99, "https://www.typemoon.net/write_free21/99", "older"),
            ],
        )
        connection.execute(
            "UPDATE boards SET incremental_anchor_post_id = 100 WHERE board_id = 'write_free21'"
        )
    frontier = FrontierStore(path)
    for post_id in (100, 99):
        frontier.seed(
            "write_free21",
            post_id,
            f"https://www.typemoon.net/write_free21/{post_id}",
            expected_comment_count=0,
        )
        lease = frontier.claim_identity("write_free21", post_id, lease_seconds=60)
        assert lease is not None
        frontier.complete(lease)
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_pages=3,
        max_posts=1,
        anchor_post_id=100,
        overlap_pages=1,
    )
    page_one = HtmlResponse(
        "https://www.typemoon.net/write_free21",
        request=Request("https://www.typemoon.net/write_free21"),
        body=(
            b"<table><tbody>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/101'>"
            b"<span class='subject'>new</span></a></td></tr>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/100'>"
            b"<span class='subject'>anchor</span></a></td></tr>"
            b"</tbody></table>"
        ),
        encoding="utf-8",
    )

    outputs = list(spider.parse_listing(page_one))

    assert spider.listing_completed is False
    assert spider.latest_post_id == 101
    assert any(isinstance(item, Request) and item.url.endswith("?page=2") for item in outputs)
    page_two = HtmlResponse(
        "https://www.typemoon.net/write_free21?page=2",
        request=Request("https://www.typemoon.net/write_free21?page=2"),
        body=(
            b"<table><tbody><tr><td class='td-subj-wrap'><a href='/write_free21/99'>"
            b"<span class='subject'>older</span></a></td></tr></tbody></table>"
        ),
        encoding="utf-8",
    )
    list(spider.parse_listing(page_two))
    assert spider.listing_completed is True


def test_exact_anchor_disables_unchanged_streak_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("crawler.spiders.typemoon.REDSTM_LISTING_OVERLAP_UNCHANGED", 2)
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
                for post_id in (3, 2, 1)
            ],
        )
    frontier = FrontierStore(path)
    for post_id in (3, 2, 1):
        frontier.seed(
            "write_free21",
            post_id,
            f"https://www.typemoon.net/write_free21/{post_id}",
            expected_comment_count=0,
        )
        lease = frontier.claim_identity("write_free21", post_id, lease_seconds=60)
        assert lease is not None
        frontier.complete(lease)
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_pages=2,
        max_posts=1,
        anchor_post_id=1,
        overlap_pages=0,
    )
    page_one_url = "https://www.typemoon.net/write_free21"
    page_one = HtmlResponse(
        page_one_url,
        request=Request(page_one_url),
        body=(
            b"<table><tbody>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/3'>"
            b"<span class='subject'>post 3</span></a></td></tr>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/2'>"
            b"<span class='subject'>post 2</span></a></td></tr>"
            b"</tbody></table>"
        ),
        encoding="utf-8",
    )

    requests = _listing_requests(list(spider.parse_listing(page_one)))

    assert [request.url for request in requests] == [f"{page_one_url}?page=2"]
    assert spider.listing_completed is False


@pytest.mark.parametrize(("latest_post_id", "expected_anchor"), [(101, 101), (None, 100)])
def test_successful_listing_pass_commits_anchor_and_timestamp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    latest_post_id: int | None,
    expected_anchor: int,
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    with connect_archive(path) as connection:
        connection.execute(
            "UPDATE boards SET incremental_anchor_post_id = 100 WHERE board_id = 'write_free21'"
        )
    captured: dict[str, object] = {}
    spider = SimpleNamespace(
        scheduled_posts=0,
        failure_codes=set(),
        paused=False,
        next_inventory_page=1,
        inventory_completed=False,
        listing_completed=True,
        latest_post_id=latest_post_id,
    )

    class FakeProcess:
        def __init__(self, _settings: object) -> None:
            self.crawler = SimpleNamespace(spider=spider, stats=None)

        def create_crawler(self, _spider_type: object) -> object:
            return self.crawler

        def crawl(self, _crawler: object, **kwargs: object) -> None:
            captured.update(kwargs)

        def start(self, *, stop_after_crawl: bool) -> None:
            assert stop_after_crawl is True

    monkeypatch.setattr("scripts.sync.CrawlerProcess", FakeProcess)
    monkeypatch.setattr("scripts.sync.ensure_session_export", lambda *_a, **_k: _session())
    report = run_sync(
        Namespace(
            archive=path,
            board="write_free21",
            session=tmp_path / "session.json",
            session_prevalidated=False,
            warc_dir=tmp_path / "warc",
            pause_file=None,
            parent_lock_held=True,
            inventory=False,
            max_seconds=60,
            max_pages=3,
            max_posts=20,
            lease_seconds=60,
        )
    )

    assert captured["anchor_post_id"] == 100
    assert report["latest_post_id"] == latest_post_id
    with connect_archive(path, read_only=True) as connection:
        row = connection.execute(
            "SELECT incremental_anchor_post_id, last_incremental_at FROM boards"
        ).fetchone()
    assert row["incremental_anchor_post_id"] == expected_anchor
    assert row["last_incremental_at"] is not None


def test_incomplete_listing_boundary_does_not_advance_anchor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    with connect_archive(path) as connection:
        connection.execute(
            "UPDATE boards SET incremental_anchor_post_id = 100 WHERE board_id = 'write_free21'"
        )
    spider = SimpleNamespace(
        scheduled_posts=0,
        failure_codes=set(),
        paused=False,
        next_inventory_page=1,
        inventory_completed=False,
        listing_completed=False,
        latest_post_id=101,
    )

    class FakeProcess:
        def __init__(self, _settings: object) -> None:
            self.crawler = SimpleNamespace(spider=spider, stats=None)

        def create_crawler(self, _spider_type: object) -> object:
            return self.crawler

        def crawl(self, _crawler: object, **_kwargs: object) -> None:
            return None

        def start(self, *, stop_after_crawl: bool) -> None:
            assert stop_after_crawl is True

    monkeypatch.setattr("scripts.sync.CrawlerProcess", FakeProcess)
    monkeypatch.setattr("scripts.sync.ensure_session_export", lambda *_a, **_k: _session())

    report = run_sync(
        Namespace(
            archive=path,
            board="write_free21",
            session=tmp_path / "session.json",
            session_prevalidated=False,
            warc_dir=tmp_path / "warc",
            pause_file=None,
            parent_lock_held=True,
            inventory=False,
            max_seconds=60,
            max_pages=1,
            max_posts=20,
            lease_seconds=60,
        )
    )

    assert report["ok"] is False
    assert report["status"] == "failed"
    assert report["failures"] == ["listing_boundary_incomplete"]
    with connect_archive(path, read_only=True) as connection:
        row = connection.execute(
            "SELECT incremental_anchor_post_id, last_incremental_at FROM boards"
        ).fetchone()
    assert tuple(row) == (100, None)


def test_overlap_boundary_scans_two_extra_listing_pages(tmp_path: Path) -> None:
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

    requests = _listing_requests(list(spider.parse_listing(response)))

    assert [request.url for request in requests] == [f"{url}?page=2"]
    assert spider.scheduled_posts == 0

    inventory = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_pages=2,
        inventory=True,
        start_page=3,
    )
    response = response.replace(url=f"{url}?page=3")
    inventory_requests = [
        item for item in inventory.parse_listing(response) if isinstance(item, Request)
    ]
    assert [request.url for request in inventory_requests] == [f"{url}?page=4"]
    assert inventory.next_inventory_page == 4


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
            f"<table><tbody>{rows}<tr><td class='td-subj-wrap'></td></tr></tbody></table>"
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

    requests = _listing_requests(list(spider.parse_listing(response)))

    assert [request.url for request in requests] == [f"{url}?page=2"]
    assert "listing_parse_failed" in spider.failure_codes

    inventory = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        max_pages=2,
        inventory=True,
        start_page=3,
    )
    inventory_response = response.replace(url=f"{url}?page=3")
    inventory_requests = _listing_requests(list(inventory.parse_listing(inventory_response)))
    assert inventory_requests == []
    assert inventory.next_inventory_page == 3


def test_inventory_completes_on_a_notice_only_terminal_page(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    url = "https://www.typemoon.net/write_free21?page=7"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=(
            b"<table><tbody><tr class='board-notice'><td class='td-subj-wrap'>"
            b"<a href='/write_free21/999'><span class='subject'>notice</span></a>"
            b"</td></tr></tbody></table>"
        ),
        encoding="utf-8",
    )
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        max_pages=2,
        inventory=True,
        start_page=7,
    )

    requests = [item for item in spider.parse_listing(response) if isinstance(item, Request)]

    assert requests == []
    assert spider.next_inventory_page == 1
    assert spider.inventory_completed is True


def test_inventory_requires_rows_or_an_explicit_empty_page_marker(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    url = "https://www.typemoon.net/write_free21?page=7"

    unexplained = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        inventory=True,
        start_page=7,
    )
    response = HtmlResponse(
        url,
        request=Request(url),
        body=b"<table><tbody></tbody></table>",
        encoding="utf-8",
    )

    assert list(unexplained.parse_listing(response)) == []
    assert unexplained.failure_codes == {"listing_parse_failed"}
    assert unexplained.next_inventory_page == 7
    assert unexplained.inventory_completed is False

    explicit = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        inventory=True,
        start_page=7,
    )
    empty = response.replace(
        body=(
            "<table><thead><tr><th>번호</th><th>제목</th></tr></thead><tbody>"
            "<tr><td class='text-center'><i class='fas fa-exclamation-circle'></i>"
            "게시물이 없습니다.</td></tr></tbody></table>"
        ).encode()
    )

    assert list(explicit.parse_listing(empty)) == []
    assert explicit.failure_codes == set()
    assert explicit.next_inventory_page == 1
    assert explicit.inventory_completed is True


def test_listing_dataloss_retries_without_advancing_inventory_coverage(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    run_id = ArchiveStore(path).start_run("inventory")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        inventory=True,
        start_page=3,
    )
    url = "https://www.typemoon.net/write_free21?page=3"
    response = HtmlResponse(
        url,
        request=Request(
            url,
            meta={
                "raw_sha256": "d" * 64,
                "warc_file": "listing.warc.gz",
                "warc_record_id": "<urn:uuid:dataloss-listing>",
            },
        ),
        body=(_FIXTURES / "listing.html").read_bytes(),
        encoding="utf-8",
        flags=["dataloss"],
    )

    [retry] = list(spider.parse_listing(response))
    assert isinstance(retry, Request)
    assert retry.dont_filter is True
    assert retry.meta["retry_times"] == 1
    assert "raw_sha256" not in retry.meta
    assert spider.failure_codes == set()
    assert spider.next_inventory_page == 3
    assert spider.inventory_completed is False

    for retry_number in (2, 3):
        retry.meta.update(
            {
                "raw_sha256": str(retry_number) * 64,
                "warc_file": f"listing-{retry_number}.warc.gz",
                "warc_record_id": f"<urn:uuid:dataloss-listing-{retry_number}>",
            }
        )
        retried_response = HtmlResponse(
            url,
            request=retry,
            body=(_FIXTURES / "listing.html").read_bytes(),
            encoding="utf-8",
            flags=["dataloss"],
        )
        outputs = list(spider.parse_listing(retried_response))
        if retry_number == 2:
            [retry] = outputs
            assert retry.meta["retry_times"] == 2
        else:
            assert outputs == []

    assert spider.failure_codes == {"listing_fetch_failed"}
    with connect_archive(path, read_only=True) as connection:
        captures = connection.execute(
            """
            SELECT outcome, error_code, raw_sha256, warc_file, warc_record_id
            FROM captures WHERE run_id = ? AND entity_type = 'listing' ORDER BY id
            """,
            (run_id,),
        ).fetchall()
        assert [tuple(capture) for capture in captures] == [
            (
                "fetch_failed",
                "network_error",
                digest * 64,
                warc_file,
                record_id,
            )
            for digest, warc_file, record_id in (
                ("d", "listing.warc.gz", "<urn:uuid:dataloss-listing>"),
                ("2", "listing-2.warc.gz", "<urn:uuid:dataloss-listing-2>"),
                ("3", "listing-3.warc.gz", "<urn:uuid:dataloss-listing-3>"),
            )
        ]


def test_malformed_listing_comment_count_is_not_synthesized_as_zero(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        inventory=True,
        start_page=4,
    )
    url = "https://www.typemoon.net/write_free21?page=4"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=(
            b"<table><tbody><tr><td class='td-subj-wrap'>"
            b"<a href='/write_free21/1'><span class='subject'>post</span>"
            b"<span class='td-comment'>many</span></a></td></tr></tbody></table>"
        ),
        encoding="utf-8",
    )

    assert list(spider.parse_listing(response)) == []
    assert spider.failure_codes == {"listing_parse_failed"}
    assert spider.next_inventory_page == 4
    assert spider.inventory_completed is False


def test_listing_removes_source_page_query_before_seeding_frontier(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    FrontierStore(path).seed(
        "write_free21",
        9,
        "https://www.typemoon.net/write_free21/9?page=3",
    )
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("inventory"),
        session=_session(),
        inventory=True,
        start_page=4,
        max_pages=1,
        max_posts=1,
    )
    url = "https://www.typemoon.net/write_free21?page=4"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=(
            b"<table><tbody><tr><td class='td-subj-wrap'>"
            b"<a href='/write_free21/9?page=4'><span class='subject'>post</span></a>"
            b"</td></tr></tbody></table>"
        ),
        encoding="utf-8",
    )

    outputs = list(spider.parse_listing(response))
    [discovered] = [item for item in outputs if isinstance(item, DiscoveredPostItem)]
    [detail] = _detail_requests(outputs)
    canonical = "https://www.typemoon.net/write_free21/9"

    assert discovered["canonical_url"] == canonical
    assert detail.url == canonical
    with connect_archive(path, read_only=True) as connection:
        assert (
            connection.execute(
                "SELECT url FROM crawl_frontier WHERE board_id = ? AND external_post_id = ?",
                ("write_free21", 9),
            ).fetchone()[0]
            == canonical
        )


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
    [detail_request] = _detail_requests(list(spider.parse_listing(listing)))

    spider.detail_error(SimpleNamespace(request=detail_request, value=OSError("secret detail")))

    with connect_archive(path) as connection:
        capture = connection.execute(
            "SELECT outcome, error_code FROM captures WHERE entity_type = 'post'"
        ).fetchone()
        assert tuple(capture) == ("fetch_failed", "network_error")
        assert tuple(connection.execute("SELECT state FROM crawl_frontier").fetchone()) == (
            "retry",
        )
    assert _capture_failure_codes(path, run_id) == ["network_error"]


def test_capture_failure_codes_ignores_a_listing_error_resolved_by_retry(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync")
    url = "https://www.typemoon.net/write_free21?page=2"
    captured_at = datetime(2026, 7, 11, tzinfo=UTC)

    store.record_listing(
        run_id,
        url=url,
        fetched_at=captured_at,
        http_status=200,
        raw_sha256="a" * 64,
        warc_file="retry.warc.gz",
        warc_record_id="<urn:uuid:retry>",
        error_code="network_error",
    )
    store.record_listing(
        run_id,
        url=url,
        fetched_at=captured_at,
        http_status=200,
        raw_sha256="b" * 64,
        warc_file="recovered.warc.gz",
        warc_record_id="<urn:uuid:recovered>",
    )

    assert _capture_failure_codes(path, run_id) == []


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

    requests = _detail_requests(list(spider.parse_listing(response)))

    assert len(requests) == 1
    assert requests[0].meta["expected_comment_count"] == 0
    with connect_archive(path, read_only=True) as connection:
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, url, state, expected_comment_count "
                "FROM crawl_frontier ORDER BY external_post_id"
            )
        ] == [
            (1, "https://www.typemoon.net/write_free21/1", "running", 0),
            (2, "https://www.typemoon.net/write_free21/2", "pending", 0),
        ]


def test_sync_stops_current_board_on_auth_response(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_posts=2,
        detail_concurrency=1,
    )
    listing_url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        listing_url,
        request=Request(listing_url),
        body=(
            b"<table><tbody>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/1'>"
            b"<span class='subject'>one</span></a></td></tr>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/2'>"
            b"<span class='subject'>two</span></a></td></tr>"
            b"</tbody></table>"
        ),
        encoding="utf-8",
    )
    [request] = _detail_requests(list(spider.parse_listing(listing)))
    response = HtmlResponse(
        request.url,
        request=request,
        body=(
            b"<form action='/bbs/login_check.php'>"
            b"<input name='mb_id'><input name='mb_password'></form>"
        ),
        encoding="utf-8",
    )

    outputs = list(spider._parse_sync_detail(response))

    assert [item["warnings"] for item in outputs if isinstance(item, CapturedPostItem)] == [
        ["auth_required"]
    ]
    assert not any(isinstance(item, Request) for item in outputs)
    assert spider.failure_codes == {"auth_required"}
    assert list(spider.parse_listing(listing.replace(url=f"{listing_url}?page=2"))) == []


def test_sync_stops_after_three_network_failures(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_posts=4,
        detail_concurrency=1,
    )
    rows = "".join(
        f"<tr><td class='td-subj-wrap'><a href='/write_free21/{post_id}'>"
        f"<span class='subject'>{post_id}</span></a></td></tr>"
        for post_id in range(1, 5)
    )
    url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        url,
        request=Request(url),
        body=f"<table><tbody>{rows}</tbody></table>".encode(),
        encoding="utf-8",
    )
    [request] = _detail_requests(list(spider.parse_listing(listing)))

    for expected_remaining in (1, 1, 0):
        outputs = list(
            spider._sync_error(SimpleNamespace(request=request, value=OSError("offline")))
        )
        assert len(outputs) == expected_remaining
        if outputs:
            request = outputs[0]

    assert spider.failure_codes == {"network_error"}
    assert list(spider.parse_listing(listing.replace(url=f"{url}?page=2"))) == []


def test_detail_dataloss_retries_without_storing_and_trips_breaker(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    run_id = ArchiveStore(path).start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=run_id,
        session=_session(),
        max_posts=4,
        detail_concurrency=1,
    )
    rows = "".join(
        f"<tr><td class='td-subj-wrap'><a href='/write_free21/{post_id}'>"
        f"<span class='subject'>{post_id}</span></a></td></tr>"
        for post_id in range(1, 5)
    )
    url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        url,
        request=Request(url),
        body=f"<table><tbody>{rows}</tbody></table>".encode(),
        encoding="utf-8",
    )
    [request] = _detail_requests(list(spider.parse_listing(listing)))

    for attempt in range(3):
        response = HtmlResponse(
            request.url,
            request=request,
            body=(_FIXTURES / "detail.html").read_bytes(),
            encoding="utf-8",
            flags=["dataloss"],
        )
        outputs = list(spider._parse_sync_detail(response))
        [item] = [item for item in outputs if isinstance(item, CapturedPostItem)]
        assert item["outcome"] == "fetch_failed"
        assert item["error_code"] == "network_error"
        ArchivePipeline(path, run_id).process_item(item)
        requests = [item for item in outputs if isinstance(item, Request)]
        if attempt < 2:
            [request] = requests
        else:
            assert requests == []

    with connect_archive(path, read_only=True) as connection:
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 0
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT outcome, error_code FROM captures "
                "WHERE run_id = ? AND entity_type = 'post' ORDER BY id",
                (run_id,),
            )
        ] == [("fetch_failed", "network_error")] * 3
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT external_post_id, state FROM crawl_frontier ORDER BY external_post_id"
            )
        ] == [(1, "retry"), (2, "retry"), (3, "retry"), (4, "pending")]
    assert spider.failure_codes == {"network_error"}


def test_pause_marker_stops_before_next_detail_lease(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    pause_file = tmp_path / "schedule.paused"
    spider = TypeMoonSpider(
        board_id="write_free21",
        archive_path=path,
        run_id=ArchiveStore(path).start_run("sync"),
        session=_session(),
        max_posts=2,
        detail_concurrency=1,
        pause_file=pause_file,
    )
    url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        url,
        request=Request(url),
        body=(
            b"<table><tbody>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/1'>"
            b"<span class='subject'>one</span></a></td></tr>"
            b"<tr><td class='td-subj-wrap'><a href='/write_free21/2'>"
            b"<span class='subject'>two</span></a></td></tr>"
            b"</tbody></table>"
        ),
        encoding="utf-8",
    )
    [request] = _detail_requests(list(spider.parse_listing(listing)))
    pause_file.touch()
    detail = HtmlResponse(
        request.url,
        request=request,
        body=(_FIXTURES / "detail.html").read_bytes(),
        encoding="utf-8",
    )

    outputs = list(spider._parse_sync_detail(detail))

    assert not any(isinstance(item, Request) for item in outputs)
    assert spider.paused is True
    with connect_archive(path, read_only=True) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM crawl_frontier WHERE state = 'running'"
            ).fetchone()[0]
            == 1
        )


def test_non_html_detail_records_retryable_parse_outcome(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    _initialize(path)
    store = ArchiveStore(path)
    run_id = store.start_run("sync")
    spider = TypeMoonSpider(
        board_id="write_free21", archive_path=path, run_id=run_id, session=_session(), max_posts=1
    )
    url = "https://www.typemoon.net/write_free21"
    listing = HtmlResponse(
        url, request=Request(url), body=(_FIXTURES / "listing.html").read_bytes(), encoding="utf-8"
    )
    [request] = _detail_requests(list(spider.parse_listing(listing)))
    [item] = [
        output
        for output in spider._parse_sync_detail(
            Response(request.url, request=request, status=200, body=b"binary")
        )
        if isinstance(output, CapturedPostItem)
    ]

    ArchivePipeline(path, run_id).process_item(item)

    with connect_archive(path, read_only=True) as connection:
        assert tuple(
            connection.execute(
                "SELECT outcome, error_code FROM captures WHERE entity_type = 'post'"
            ).fetchone()
        ) == ("parse_failed", "parse_drift")
        assert tuple(connection.execute("SELECT state FROM crawl_frontier").fetchone()) == (
            "retry",
        )


def test_captured_post_repr_never_logs_content() -> None:
    item = CapturedPostItem(
        board_id="aa_19",
        external_post_id=1,
        canonical_url="https://www.typemoon.net/aa_19/1",
        outcome="stored",
        title="secret title",
        body_html="<p>secret body</p>",
        comments=[{"content_text": "secret comment"}],
    )

    rendered = repr(item)

    assert rendered == "CapturedPostItem(board_id='aa_19', external_post_id=1, outcome='stored')"
    assert "secret" not in rendered
    assert "secret" not in str(item)


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


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (None, "listing_fetch_failed"),
        (401, "auth_required"),
        (403, "auth_required"),
        (429, "rate_limited"),
    ],
)
def test_listing_errback_classifies_auth_and_rate_limit(status: int | None, expected: str) -> None:
    spider = TypeMoonSpider()
    request = Request("https://www.typemoon.net/write_free21")
    value: object = OSError("offline")
    if status is not None:
        value = SimpleNamespace(response=HtmlResponse(request.url, request=request, status=status))

    spider.listing_error(SimpleNamespace(request=request, value=value))

    assert spider.failure_codes == {expected}


def test_listing_login_form_stops_as_auth_failure() -> None:
    spider = TypeMoonSpider()
    url = "https://www.typemoon.net/write_free21"
    response = HtmlResponse(
        url,
        request=Request(url),
        body=b"<form action='/bbs/login_check.php'><input name='mb_id'></form>",
        encoding="utf-8",
    )

    assert list(spider.parse_listing(response)) == []
    assert spider.failure_codes == {"auth_required"}


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
    assert crawler_settings.DOWNLOAD_FAIL_ON_DATALOSS is False
    assert crawler_settings.REDSTM_LISTING_TIMEOUT_SECONDS == 180
    assert TypeMoonSpider().listing_request("write").meta["download_timeout"] == 180
    assert "download_timeout" not in TypeMoonSpider().detail_request("write", 1, _session()).meta
    project = _project_settings()
    assert project.getint("CONCURRENT_REQUESTS") == 1
    assert project.getfloat("DOWNLOAD_DELAY") == 10
    assert project.getdict("DOWNLOADER_MIDDLEWARES") == {
        "crawler.middlewares.WarcCaptureMiddleware": 595
    }
    assert project.getdict("ITEM_PIPELINES") == {"crawler.archive_pipeline.ArchivePipeline": 300}
    assert _project_settings(123).getint("CLOSESPIDER_TIMEOUT") == 123
    assert _timed_out(
        SimpleNamespace(stats=SimpleNamespace(get_value=lambda _name: "closespider_timeout"))
    )

    monkeypatch.setattr("sys.argv", ["sync", "--archive", str(archive), "--board", "write"])
    assert parse_sync_args().lease_seconds == 900
    assert parse_sync_args().max_seconds is None
    assert parse_sync_args().session_prevalidated is False
    assert parse_sync_args().parent_lock_held is False
    monkeypatch.setattr(
        "sys.argv",
        ["sync", "--archive", str(archive), "--board", "write", "--session-prevalidated"],
    )
    assert parse_sync_args().session_prevalidated is True
    monkeypatch.setattr(
        "sys.argv", ["sync", "--archive", str(archive), "--board", "write", "--parent-lock-held"]
    )
    assert parse_sync_args().parent_lock_held is True
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
