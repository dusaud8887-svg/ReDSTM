from __future__ import annotations

import gzip
from pathlib import Path

from scrapy.http import HtmlResponse, Request
from warcio.archiveiterator import ArchiveIterator  # type: ignore[import-untyped]

from crawler import settings
from crawler.middlewares import WarcCaptureMiddleware
from crawler.spiders.typemoon import TypeMoonSpider


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
