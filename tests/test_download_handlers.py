from __future__ import annotations

import gzip
from collections.abc import Iterator
from typing import Any, cast

import pytest
import requests
from scrapy import Request
from scrapy.downloadermiddlewares.httpcompression import HttpCompressionMiddleware
from scrapy.downloadermiddlewares.retry import RetryMiddleware
from scrapy.exceptions import DownloadCancelledError, ScrapyDeprecationWarning
from scrapy.settings import Settings
from urllib3.exceptions import ReadTimeoutError

from crawler.download_handlers import SequentialDetailDownloadHandler


class _RawHeaders:
    def __init__(self, values: dict[str, list[str]]) -> None:
        self.values = values

    def __iter__(self) -> Iterator[str]:
        return iter(self.values)

    def getlist(self, name: str) -> list[str]:
        return self.values[name]


class _Raw:
    def __init__(self, chunks: list[bytes], *, read_timeout: bool = False) -> None:
        self.chunks = chunks
        self.read_timeout = read_timeout
        self.headers = _RawHeaders(
            {
                "Content-Type": ["text/html; charset=utf-8"],
                "Content-Encoding": ["gzip"],
            }
        )

    def stream(self, *, amt: int, decode_content: bool) -> Iterator[bytes]:
        assert amt == 64 << 10
        assert decode_content is False
        yield from self.chunks
        if self.read_timeout:
            raise ReadTimeoutError(
                cast(Any, None), "https://www.typemoon.net/aa_a01/1", "timed out"
            )


class _Source:
    url = "https://www.typemoon.net/aa_a01/1"
    status_code = 200

    def __init__(
        self,
        chunks: list[bytes],
        *,
        content_length: int | None = None,
        read_timeout: bool = False,
    ) -> None:
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)
        self.raw = _Raw(chunks, read_timeout=read_timeout)

    def __enter__(self) -> _Source:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class _Session:
    def __init__(self, source: _Source) -> None:
        self.source = source
        self.kwargs: dict[str, Any] = {}

    def get(self, url: str, **kwargs: Any) -> _Source:
        self.kwargs = {"url": url, **kwargs}
        return self.source


def _handler(source: _Source, *, maxsize: int = 1024) -> SequentialDetailDownloadHandler:
    handler = object.__new__(SequentialDetailDownloadHandler)
    handler._session = _Session(source)  # type: ignore[assignment]
    handler._maxsize = maxsize
    handler._warnsize = 512
    return handler


def test_sequential_detail_preserves_wire_body_then_scrapy_decodes_it() -> None:
    decoded_body = b"<html>AA</html>"
    encoded_body = gzip.compress(decoded_body)
    handler = _handler(_Source([encoded_body]))
    request = Request(
        "https://www.typemoon.net/aa_a01/1",
        headers={"Cookie": "PHPSESSID=secret", "Accept-Encoding": "br"},
    )

    response = handler._download_detail(request)

    assert response.body == encoded_body
    assert response.headers["Content-Length"] == str(len(encoded_body)).encode()
    assert response.headers["Content-Encoding"] == b"gzip"
    with pytest.warns(ScrapyDeprecationWarning):
        compression = HttpCompressionMiddleware()
    assert compression.process_response(request, response).body == decoded_body
    assert response.request is request
    assert handler._session.kwargs["timeout"] == (6.1, 30)  # type: ignore[attr-defined]
    assert handler._session.kwargs["stream"] is True  # type: ignore[attr-defined]
    assert handler._session.kwargs["allow_redirects"] is False  # type: ignore[attr-defined]
    assert handler._session.kwargs["headers"]["Accept-Encoding"] == "gzip, deflate"  # type: ignore[attr-defined]
    assert handler._session.kwargs["headers"]["Connection"] == "close"  # type: ignore[attr-defined]


def test_sequential_detail_returns_partial_body_after_idle_timeout() -> None:
    encoded_body = gzip.compress(b"<html>partial</html>")
    handler = _handler(_Source([encoded_body], read_timeout=True))
    request = Request("https://www.typemoon.net/aa_a01/1")

    response = handler._download_detail(request)

    assert response.body == encoded_body
    assert request.meta["redstm_truncated"] is True


def test_sequential_detail_rejects_oversized_response_before_reading() -> None:
    handler = _handler(_Source([], content_length=1025))

    with pytest.raises(DownloadCancelledError):
        handler._download_detail(Request("https://www.typemoon.net/aa_a01/1"))


def test_requests_read_timeout_is_a_scrapy_retry_exception() -> None:
    middleware = RetryMiddleware(Settings())
    handler = _handler(_Source([], read_timeout=True))
    with pytest.raises(requests.exceptions.ConnectionError) as caught:
        handler._download_detail(Request("https://www.typemoon.net/aa_a01/1"))
    assert isinstance(caught.value, middleware.exceptions_to_retry)


def test_detail_uses_explicit_ca_bundle_without_environment_proxies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt")
    handler = _handler(_Source([b"<html>ok</html>"]))
    handler._download_detail(Request("https://www.typemoon.net/aa_a01/1"))
    assert handler._session.kwargs["verify"] == "/etc/ssl/certs/ca-certificates.crt"  # type: ignore[attr-defined]
