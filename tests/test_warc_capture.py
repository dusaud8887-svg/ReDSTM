from __future__ import annotations

import gzip
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from scrapy.http import HtmlResponse, Request
from warcio.archiveiterator import ArchiveIterator  # type: ignore[import-untyped]

from crawler import settings
from crawler.archive import initialize_archive
from crawler.middlewares import WarcCaptureMiddleware
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore


def test_warc_skips_conditional_hits_and_publishes_validators(tmp_path: Path) -> None:
    # A 304 has no representation: nothing is archived, no raw_sha256 is minted. A 200
    # response publishes its validators on the request meta so the capture row can store
    # them for a later If-None-Match/If-Modified-Since probe (docs/31 C5).
    path = tmp_path / "capture.warc.gz"
    spider = TypeMoonSpider()
    middleware = WarcCaptureMiddleware(path)
    middleware.spider_opened(spider)

    not_modified = Request(
        "https://www.typemoon.net/write_free21/62068", meta={"redstm_capture": True}
    )
    response_304 = HtmlResponse(
        not_modified.url, status=304, request=not_modified, encoding="utf-8"
    )
    assert middleware.process_response(not_modified, response_304) is response_304
    assert not_modified.meta.get("raw_sha256") is None

    request = Request("https://www.typemoon.net/write_free21/62068", meta={"redstm_capture": True})
    response = HtmlResponse(
        request.url,
        body=b"<html>body</html>",
        headers={"ETag": '"v1"', "Last-Modified": "Fri, 10 Jul 2026 00:00:00 GMT"},
        request=request,
        encoding="utf-8",
    )
    middleware.process_response(request, response)
    assert request.meta["etag"] == '"v1"'
    assert request.meta["last_modified"] == "Fri, 10 Jul 2026 00:00:00 GMT"

    # A blank validator header is no validator: the pipeline rejects empty text.
    blank = Request("https://www.typemoon.net/write_free21/62069", meta={"redstm_capture": True})
    middleware.process_response(
        blank,
        HtmlResponse(
            blank.url,
            body=b"<html>other</html>",
            headers={"ETag": "", "Last-Modified": " "},
            request=blank,
            encoding="utf-8",
        ),
    )
    assert "etag" not in blank.meta
    assert "last_modified" not in blank.meta
    middleware.spider_closed(spider, "finished")


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


def test_orphan_parts_of_a_killed_worker_get_their_final_names(tmp_path: Path) -> None:
    import os

    from crawler.middlewares import _ORPHAN_PART_SECONDS, _recover_orphan_parts

    now = 1_800_000_000.0
    old = tmp_path / "sync-a.warc.gz.partial"
    old.write_bytes(b"records")
    empty = tmp_path / "sync-b.warc.gz.partial"
    empty.write_bytes(b"")
    fresh = tmp_path / "sync-c.warc.gz.partial"
    fresh.write_bytes(b"open part")
    taken = tmp_path / "sync-d.warc.gz.partial"
    taken.write_bytes(b"duplicate")
    (tmp_path / "sync-d.warc.gz").write_bytes(b"final")
    for path in (old, empty, taken):
        os.utime(path, (now - _ORPHAN_PART_SECONDS - 1, now - _ORPHAN_PART_SECONDS - 1))
    os.utime(fresh, (now, now))

    recovered = _recover_orphan_parts(tmp_path, now=now)

    assert recovered == [tmp_path / "sync-a.warc.gz"]
    assert (tmp_path / "sync-a.warc.gz").read_bytes() == b"records"
    assert not empty.exists()
    assert fresh.exists()
    assert taken.exists() and (tmp_path / "sync-d.warc.gz").read_bytes() == b"final"
