from __future__ import annotations

import gzip
import hashlib
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import cast

from scrapy import Spider
from scrapy.crawler import Crawler
from scrapy.http import HtmlResponse, Request
from twisted.internet.task import Clock
from warcio.archiveiterator import ArchiveIterator  # type: ignore[import-untyped]

from crawler import settings
from crawler.archive import initialize_archive
from crawler.middlewares import DetailIdleWatchdog, WarcCaptureMiddleware
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore


def test_detail_idle_watchdog_closes_the_batch_but_ignores_listings() -> None:
    abandoned: list[list[Request]] = []
    closed: list[str] = []

    spider = SimpleNamespace(
        download_idle_timeout=lambda requests: abandoned.append(requests),
        logger=SimpleNamespace(warning=lambda *args: None),
    )
    crawler = SimpleNamespace(
        spider=spider,
        stats=SimpleNamespace(inc_value=lambda key: None),
        signals=SimpleNamespace(send_catch_log=lambda **kwargs: closed.append(kwargs["reason"])),
    )
    clock = Clock()
    stopped: list[bool] = []
    watchdog = DetailIdleWatchdog(cast(Crawler, crawler), clock, lambda: stopped.append(True))
    stalled = Request("https://www.typemoon.net/aa/1", meta={"download_idle_timeout": 300})
    sibling = Request("https://www.typemoon.net/aa/2", meta={"download_idle_timeout": 300})
    listing = Request("https://www.typemoon.net/aa")
    impersonated = Request(
        "https://www.typemoon.net/aa/3",
        meta={"download_idle_timeout": 300, "impersonate": "chrome150"},
    )

    for request in (stalled, sibling, listing, impersonated):
        watchdog.request_reached_downloader(request, cast(Spider, spider))
    watchdog.bytes_received(b"part", stalled, cast(Spider, spider))
    clock.advance(300)

    assert abandoned == [[stalled, sibling]]
    assert closed == ["download_idle_timeout"]
    assert stopped == [True]


def test_warc_capture_keeps_raw_response_without_secrets(tmp_path: Path) -> None:
    path = tmp_path / "capture.warc.gz"
    spider = TypeMoonSpider()
    middleware = WarcCaptureMiddleware(path)
    middleware.spider_opened(spider)

    request = Request(
        "https://www.typemoon.net/write_free21/62068",
        headers={"Authorization": "auth-secret", "Cookie": "session=cookie-secret"},
        meta={"redstm_capture": True},
    )
    raw_body = b"<html>raw response</html>"
    compressed_body = gzip.compress(raw_body)
    response = HtmlResponse(
        request.url,
        body=compressed_body,
        headers={
            "Content-Encoding": "gzip",
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": "leak=secret",
        },
        encoding="utf-8",
    )
    assert middleware.process_response(request, response) is response

    post = Request(
        "https://www.typemoon.net/write_free21/62068",
        method="POST",
        body=b"password=post-secret",
        meta={"redstm_capture": True},
    )
    skipped = middleware.process_response(post, HtmlResponse(post.url, request=post))
    assert skipped.meta == post.meta
    query_secret = Request(
        "https://www.typemoon.net/write_free21?page=1&token=query-secret",
        meta={"redstm_capture": True},
    )
    middleware.process_response(
        query_secret,
        HtmlResponse(query_secret.url, request=query_secret),
    )
    middleware.spider_closed(spider, "finished")

    assert request.meta["warc_record_id"].startswith("<urn:uuid:")
    assert request.meta["warc_file"] == str(path)
    assert request.meta["raw_sha256"] == hashlib.sha256(compressed_body).hexdigest()
    assert request.meta["warc_reused"] is False
    assert not list(tmp_path.glob("*.partial"))
    uncompressed = gzip.decompress(path.read_bytes())
    for secret in (
        b"auth-secret",
        b"cookie-secret",
        b"leak=secret",
        b"post-secret",
        b"query-secret",
    ):
        assert secret not in uncompressed

    with path.open("rb") as stream:
        records = ArchiveIterator(stream)
        record = next(records)
        assert record.rec_type == "response"
        assert record.rec_headers.get_header("WARC-Target-URI") == request.url
        assert record.rec_headers.get_header("WARC-Block-Digest")
        assert record.rec_headers.get_header("WARC-Payload-Digest")
        assert record.http_headers.get_header("Set-Cookie") is None
        assert record.raw_stream.read() == compressed_body
        assert next(records, None) is None


def test_warc_capture_accepts_nonstandard_status_codes(tmp_path: Path) -> None:
    path = tmp_path / "capture.warc.gz"
    spider = TypeMoonSpider()
    middleware = WarcCaptureMiddleware(path)
    middleware.spider_opened(spider)

    request = Request(
        "https://www.typemoon.net/write_free21/62068",
        meta={"redstm_capture": True},
    )
    response = HtmlResponse(request.url, status=522, body=b"origin timeout", request=request)
    assert middleware.process_response(request, response) is response
    middleware.spider_closed(spider, "finished")

    with path.open("rb") as stream:
        record = next(ArchiveIterator(stream))
        assert record.http_headers.get_statuscode() == "522"


def test_warc_capture_reuses_same_url_and_raw_body(tmp_path: Path) -> None:
    path = tmp_path / "capture.warc.gz"
    spider = TypeMoonSpider()
    middleware = WarcCaptureMiddleware(path)
    middleware.spider_opened(spider)

    first = Request("https://www.typemoon.net/write_free21/62068", meta={"redstm_capture": True})
    second = Request(first.url, meta={"redstm_capture": True})
    middleware.process_response(first, HtmlResponse(first.url, request=first, body=b"same"))
    middleware.process_response(second, HtmlResponse(second.url, request=second, body=b"same"))
    middleware.spider_closed(spider, "finished")

    assert second.meta["warc_reused"] is True
    assert second.meta["warc_record_id"] == first.meta["warc_record_id"]
    with path.open("rb") as stream:
        assert sum(1 for _ in ArchiveIterator(stream)) == 1


def test_warc_capture_reuses_prior_ledger_record_only_while_file_exists(tmp_path: Path) -> None:
    url = "https://www.typemoon.net/write_free21/62068"
    body = b"same"
    existing = tmp_path / "existing.warc.gz"
    spider = TypeMoonSpider()
    first = Request(url, meta={"redstm_capture": True})
    writer = WarcCaptureMiddleware(existing)
    writer.spider_opened(spider)
    writer.process_response(first, HtmlResponse(url, request=first, body=body))
    writer.spider_closed(spider, "finished")

    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    store = ArchiveStore(archive)
    run_id = store.start_run("sync")
    store.record_outcome(
        run_id,
        url=url,
        outcome="restricted",
        fetched_at=datetime.now(UTC),
        raw_sha256=first.meta["raw_sha256"],
        warc_file=str(existing),
        warc_record_id=first.meta["warc_record_id"],
    )

    reused_path = tmp_path / "reused.warc.gz"
    reused_request = Request(url, meta={"redstm_capture": True})
    reused = WarcCaptureMiddleware(reused_path, archive_path=archive)
    reused.spider_opened(spider)
    reused.process_response(reused_request, HtmlResponse(url, request=reused_request, body=body))
    reused.spider_closed(spider, "finished")
    assert reused_request.meta["warc_reused"] is True
    assert not reused_path.exists()

    existing.unlink()
    replacement_request = Request(url, meta={"redstm_capture": True})
    replacement = WarcCaptureMiddleware(reused_path, archive_path=archive)
    replacement.spider_opened(spider)
    replacement.process_response(
        replacement_request, HtmlResponse(url, request=replacement_request, body=body)
    )
    replacement.spider_closed(spider, "finished")
    assert replacement_request.meta["warc_reused"] is False
    assert reused_path.exists()


def test_warc_middleware_runs_before_http_decompression() -> None:
    assert settings.DOWNLOADER_MIDDLEWARES["crawler.middlewares.WarcCaptureMiddleware"] == 595


def test_warc_rotates_and_only_publishes_closed_files(tmp_path: Path) -> None:
    path = tmp_path / "capture.warc.gz"
    spider = TypeMoonSpider()
    middleware = WarcCaptureMiddleware(path, max_bytes=1)
    middleware.spider_opened(spider)

    for post_id in (1, 2):
        request = Request(
            f"https://www.typemoon.net/write_free21/{post_id}",
            meta={"redstm_capture": True},
        )
        middleware.process_response(request, HtmlResponse(request.url, body=b"ok"))

    middleware.spider_closed(spider, "finished")

    assert path.exists()
    assert (tmp_path / "capture-0002.warc.gz").exists()
    assert not list(tmp_path.glob("*.partial"))
