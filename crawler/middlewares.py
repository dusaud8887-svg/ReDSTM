from __future__ import annotations

import hashlib
import re
from http import HTTPStatus
from io import BytesIO
from pathlib import Path
from typing import BinaryIO, Self
from urllib.parse import parse_qs, urlsplit

from scrapy import Spider, signals
from scrapy.crawler import Crawler
from scrapy.exceptions import NotConfigured
from scrapy.http import Request, Response
from warcio.statusandheaders import StatusAndHeaders  # type: ignore[import-untyped]
from warcio.warcwriter import WARCWriter  # type: ignore[import-untyped]

from crawler.origin_proxy import TYPEMOON_ORIGIN_HOSTS, active_origin_proxy
from crawler.settings import REDSTM_WARC_MAX_BYTES
from crawler.store import ArchiveStore

_CAPTURE_PATH = re.compile(r"^/[a-z0-9_]+(?:/[0-9]+)?$")
_TYPEMOON_HOSTS = set(TYPEMOON_ORIGIN_HOSTS)
_OMITTED_RESPONSE_HEADERS = {b"content-length", b"set-cookie", b"set-cookie2", b"transfer-encoding"}


def _is_allowed_capture(request: Request) -> bool:
    if request.method != "GET" or request.meta.get("redstm_capture") is not True:
        return False

    parsed = urlsplit(request.url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _TYPEMOON_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not _CAPTURE_PATH.fullmatch(parsed.path)
    ):
        return False

    if not parsed.query:
        return True
    query = parse_qs(parsed.query)
    page = query.get("page")
    return (
        parsed.path.count("/") == 1
        and set(query) == {"page"}
        and page is not None
        and len(page) == 1
        and page[0].isdigit()
    )


def _response_headers(response: Response) -> list[tuple[str, str]]:
    headers: list[tuple[str, str]] = []
    for name, values in response.headers.items():
        if name.lower() in _OMITTED_RESPONSE_HEADERS:
            continue
        decoded_name = name.decode("latin-1")
        headers.extend((decoded_name, value.decode("latin-1")) for value in values)
    headers.append(("Content-Length", str(len(response.body))))
    return headers


class OriginProxyMiddleware:
    def process_request(self, request: Request, spider: Spider) -> None:
        del spider
        proxy = active_origin_proxy()
        if proxy is None:
            return
        host = urlsplit(request.url).hostname
        if host not in TYPEMOON_ORIGIN_HOSTS:
            return
        request.meta.setdefault("proxy", proxy)


class WarcCaptureMiddleware:
    def __init__(
        self,
        path: Path,
        max_bytes: int = REDSTM_WARC_MAX_BYTES,
        archive_path: Path | None = None,
    ) -> None:
        if max_bytes < 1:
            raise ValueError("WARC max_bytes must be positive")
        if not (path.name.endswith(".warc") or path.name.endswith(".warc.gz")):
            raise ValueError("WARC path must end with .warc or .warc.gz")
        self.path = path
        self.max_bytes = max_bytes
        self.archive_path = archive_path
        self._part = 0
        self._final_path: Path | None = None
        self._partial_path: Path | None = None
        self._stream: BinaryIO | None = None
        self._writer: WARCWriter | None = None
        self._seen: dict[tuple[str, str], tuple[str, str]] = {}

    @classmethod
    def from_crawler(cls, crawler: Crawler) -> Self:
        configured_path = crawler.settings.get("REDSTM_WARC_PATH")
        if not isinstance(configured_path, str) or not configured_path:
            raise NotConfigured("REDSTM_WARC_PATH is not configured")
        configured_archive = crawler.settings.get("REDSTM_ARCHIVE_PATH")
        archive_path = (
            Path(configured_archive)
            if isinstance(configured_archive, str) and configured_archive
            else None
        )
        middleware = cls(
            Path(configured_path), crawler.settings.getint("REDSTM_WARC_MAX_BYTES"), archive_path
        )
        crawler.signals.connect(middleware.spider_opened, signal=signals.spider_opened)
        crawler.signals.connect(middleware.spider_closed, signal=signals.spider_closed)
        return middleware

    def spider_opened(self, spider: Spider) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def spider_closed(self, spider: Spider, reason: str) -> None:
        self._close_part()

    def _open_part(self) -> None:
        self._part += 1
        suffix = "" if self._part == 1 else f"-{self._part:04d}"
        if self.path.name.endswith(".warc.gz"):
            stem = self.path.name.removesuffix(".warc.gz")
            self._final_path = self.path.with_name(f"{stem}{suffix}.warc.gz")
        else:
            stem = self.path.name.removesuffix(".warc")
            self._final_path = self.path.with_name(f"{stem}{suffix}.warc")
        if self._final_path.exists():
            raise FileExistsError(f"refusing to overwrite WARC: {self._final_path}")
        self._partial_path = self._final_path.with_name(f"{self._final_path.name}.partial")
        self._stream = self._partial_path.open("xb")
        self._writer = WARCWriter(self._stream, gzip=self._final_path.suffix == ".gz")

    def _close_part(self) -> None:
        if self._stream is None or self._partial_path is None or self._final_path is None:
            return
        self._stream.close()
        if self._partial_path.stat().st_size:
            self._partial_path.replace(self._final_path)
        else:
            self._partial_path.unlink()
        self._stream = None
        self._writer = None
        self._partial_path = None
        self._final_path = None

    def process_response(self, request: Request, response: Response) -> Response:
        if not _is_allowed_capture(request):
            return response
        raw_sha256 = hashlib.sha256(response.body).hexdigest()
        request.meta["raw_sha256"] = raw_sha256
        reference = self._seen.get((request.url, raw_sha256))
        if reference is None and self.archive_path is not None and self.archive_path.is_file():
            reference = ArchiveStore(self.archive_path).find_warc_capture(raw_sha256, request.url)
            if reference is not None and not Path(reference[0]).is_file():
                reference = None
        if reference is not None:
            request.meta["warc_file"], request.meta["warc_record_id"] = reference
            request.meta["warc_reused"] = True
            return response
        if self._writer is None:
            self._open_part()
        assert self._stream is not None
        assert self._final_path is not None
        assert self._writer is not None

        try:
            phrase = HTTPStatus(response.status).phrase
        except ValueError:
            phrase = ""
        status = f"{response.status} {phrase}".strip()
        http_headers = StatusAndHeaders(status, _response_headers(response), protocol="HTTP/1.1")
        record = self._writer.create_warc_record(
            request.url,
            "response",
            payload=BytesIO(response.body),
            http_headers=http_headers,
        )
        self._writer.write_record(record)
        request.meta["warc_record_id"] = record.rec_headers.get_header("WARC-Record-ID")
        request.meta["warc_file"] = str(self._final_path.resolve())
        request.meta["warc_reused"] = False
        self._seen[(request.url, raw_sha256)] = (
            request.meta["warc_file"],
            request.meta["warc_record_id"],
        )
        if self._stream.tell() >= self.max_bytes:
            self._close_part()
        return response
