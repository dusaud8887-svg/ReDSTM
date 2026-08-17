from __future__ import annotations

import logging
import time
from importlib import import_module
from typing import Any, cast

import requests
from requests.adapters import HTTPAdapter
from scrapy import Request
from scrapy.core.downloader.handlers.http11 import HTTP11DownloadHandler
from scrapy.crawler import Crawler
from scrapy.exceptions import DownloadCancelledError
from scrapy.http import Headers, Response
from scrapy.responsetypes import responsetypes
from scrapy.utils.defer import maybe_deferred_to_future
from twisted.internet.threads import deferToThread
from urllib3.exceptions import ProtocolError, ReadTimeoutError, SSLError

from crawler.settings import (
    REDSTM_DETAIL_CONNECT_TIMEOUT_SECONDS,
    REDSTM_DETAIL_READ_TIMEOUT_SECONDS,
)

logger = logging.getLogger(__name__)


class SequentialDetailDownloadHandler:
    """Use Requests' per-read timeout for details and Scrapy's handler for everything else."""

    lazy = True

    def __init__(self, crawler: Crawler) -> None:
        if crawler.settings.get("REDSTM_IMPERSONATE_BROWSER"):
            handler_type = import_module("scrapy_impersonate").ImpersonateDownloadHandler
            self._delegate: Any = handler_type.from_crawler(crawler)
        else:
            self._delegate = HTTP11DownloadHandler.from_crawler(crawler)
        self._maxsize = crawler.settings.getint("DOWNLOAD_MAXSIZE")
        self._warnsize = crawler.settings.getint("DOWNLOAD_WARNSIZE")
        self._session = requests.Session()
        self._session.trust_env = False
        adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=0)
        self._session.mount("http://", adapter)
        self._session.mount("https://", adapter)

    @classmethod
    def from_crawler(cls, crawler: Crawler) -> SequentialDetailDownloadHandler:
        return cls(crawler)

    async def download_request(self, request: Request) -> Response:
        if request.meta.get("redstm_sequential_detail") is not True:
            return await self._delegate.download_request(request)
        return await maybe_deferred_to_future(deferToThread(self._download_detail, request))

    def _download_detail(self, request: Request) -> Response:
        if request.method != "GET":
            raise ValueError("sequential detail handler only supports GET")
        headers: dict[str, str] = dict(cast(Any, request.headers.to_unicode_dict()))
        # Preserve compressed wire bytes for WARC; Scrapy decompresses after capture.
        headers["Accept-Encoding"] = "gzip, deflate"
        started_at = time.monotonic()
        with self._session.get(
            request.url,
            headers=headers,
            allow_redirects=False,
            stream=True,
            timeout=(
                REDSTM_DETAIL_CONNECT_TIMEOUT_SECONDS,
                REDSTM_DETAIL_READ_TIMEOUT_SECONDS,
            ),
        ) as source:
            request.meta["download_latency"] = time.monotonic() - started_at
            raw_length = source.headers.get("Content-Length")
            if raw_length and self._maxsize and int(raw_length) > self._maxsize:
                raise DownloadCancelledError(
                    f"expected response size {raw_length} exceeds {self._maxsize} bytes"
                )
            body = bytearray()
            warned = False
            try:
                for chunk in source.raw.stream(amt=64 << 10, decode_content=False):
                    if not chunk:
                        continue
                    body.extend(chunk)
                    if self._maxsize and len(body) > self._maxsize:
                        raise DownloadCancelledError(
                            f"received response size exceeds {self._maxsize} bytes"
                        )
                    if self._warnsize and len(body) > self._warnsize and not warned:
                        logger.warning(
                            "Received more than %s bytes from %s",
                            self._warnsize,
                            request.url,
                        )
                        warned = True
            except ReadTimeoutError as error:
                raise requests.exceptions.ConnectionError(error) from error
            except ProtocolError as error:
                raise requests.exceptions.ChunkedEncodingError(error) from error
            except SSLError as error:
                raise requests.exceptions.SSLError(error) from error
            body_bytes = bytes(body)
            response_headers = self._response_headers(source, len(body_bytes))
            response_type = responsetypes.from_args(
                headers=response_headers,
                url=source.url,
                body=body_bytes,
            )
            return response_type(
                url=source.url,
                status=source.status_code,
                headers=response_headers,
                body=body_bytes,
                request=request,
                protocol="HTTP/1.1",
            )

    @staticmethod
    def _response_headers(source: requests.Response, body_length: int) -> Headers:
        headers = Headers()
        for name in source.raw.headers:
            for value in source.raw.headers.getlist(name):
                headers.appendlist(name, value)
        for name in ("Content-Length", "Transfer-Encoding"):
            headers.pop(name, None)
        headers["Content-Length"] = str(body_length)
        return headers

    async def close(self) -> None:
        try:
            await self._delegate.close()
        finally:
            self._session.close()
