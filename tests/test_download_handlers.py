from __future__ import annotations

import gzip
import socket
import threading
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
from crawler.settings import (
    REDSTM_DETAIL_CONNECT_TIMEOUT_SECONDS,
    REDSTM_DETAIL_FIRST_BYTE_TIMEOUT_SECONDS,
    REDSTM_DETAIL_READ_TIMEOUT_SECONDS,
)


class _RawHeaders:
    def __init__(self, values: dict[str, list[str]]) -> None:
        self.values = values

    def __iter__(self) -> Iterator[str]:
        return iter(self.values)

    def getlist(self, name: str) -> list[str]:
        return self.values[name]


class _Sock:
    def __init__(self) -> None:
        self.timeouts: list[object] = []

    def settimeout(self, value: object) -> None:
        self.timeouts.append(value)


class _Connection:
    def __init__(self) -> None:
        self.sock: _Sock | None = _Sock()
        self.timeout: object = None


class _Raw:
    def __init__(self, chunks: list[bytes], *, read_timeout: bool = False) -> None:
        self.chunks = chunks
        self.read_timeout = read_timeout
        self.connection = _Connection()
        self.headers = _RawHeaders(
            {
                "Content-Type": ["text/html; charset=utf-8"],
                "Content-Encoding": ["gzip"],
            }
        )

    def read(self, amt: int, decode_content: bool = False) -> bytes:
        assert decode_content is False
        assert amt in {1, 64 << 10}
        if amt == 1 and self.connection.sock is not None:
            assert self.connection.sock.timeouts == []
        while self.chunks and not self.chunks[0]:
            del self.chunks[0]
        if amt != 1 and self.chunks and self.connection.sock is not None:
            assert self.connection.timeout == REDSTM_DETAIL_READ_TIMEOUT_SECONDS
            assert self.connection.sock.timeouts == [REDSTM_DETAIL_READ_TIMEOUT_SECONDS]
        if not self.chunks:
            if self.read_timeout and amt != 1:
                raise ReadTimeoutError(
                    cast(Any, None), "https://www.typemoon.net/aa_a01/1", "timed out"
                )
            return b""
        take = self.chunks[0][:amt]
        self.chunks[0] = self.chunks[0][len(take) :]
        if not self.chunks[0]:
            del self.chunks[0]
        return take


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
    assert handler._session.kwargs["timeout"] == (  # type: ignore[attr-defined]
        REDSTM_DETAIL_CONNECT_TIMEOUT_SECONDS,
        REDSTM_DETAIL_FIRST_BYTE_TIMEOUT_SECONDS,
    )
    assert REDSTM_DETAIL_FIRST_BYTE_TIMEOUT_SECONDS == 240
    assert REDSTM_DETAIL_READ_TIMEOUT_SECONDS == 30
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


def test_detail_refuses_to_stream_when_the_body_socket_is_missing() -> None:
    source = _Source([b"<html>ok</html>"])
    source.raw.connection.sock = None
    handler = _handler(source)
    middleware = RetryMiddleware(Settings())
    with pytest.raises(requests.exceptions.ConnectionError) as caught:
        handler._download_detail(Request("https://www.typemoon.net/aa_a01/1"))
    assert isinstance(caught.value, middleware.exceptions_to_retry)


@pytest.mark.parametrize("framing", ["content-length", "chunked"])
def test_detail_header_budget_then_idle_timeout_on_a_real_socket(
    monkeypatch: pytest.MonkeyPatch,
    framing: str,
) -> None:
    monkeypatch.setattr("crawler.download_handlers.requests_proxies", lambda: None)
    monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
    recorded: list[tuple[tuple[str, int] | None, object]] = []
    original = socket.socket.settimeout

    def record(self: socket.socket, value: float | None) -> None:
        try:
            peer = self.getpeername()
        except OSError:
            peer = None
        recorded.append((peer, value))
        original(self, value)

    monkeypatch.setattr(socket.socket, "settimeout", record)
    ready = threading.Event()
    port: dict[str, int] = {}

    def serve() -> None:
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(5)
        port["n"] = listener.getsockname()[1]
        ready.set()
        try:
            conn, _ = listener.accept()
        except TimeoutError:
            listener.close()
            return
        try:
            conn.settimeout(5)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            body = b"<html>ok</html>"
            if framing == "content-length":
                payload = (
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
                    + str(len(body)).encode()
                    + b"\r\nConnection: close\r\n\r\n"
                    + body
                )
            else:
                # Two chunks, so a second chunk parser starts mid-body.
                first, second = body[:1], body[1:]
                payload = (
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                    b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    + f"{len(first):x}\r\n".encode()
                    + first
                    + b"\r\n"
                    + f"{len(second):x}\r\n".encode()
                    + second
                    + b"\r\n0\r\n\r\n"
                )
            conn.sendall(payload)
        finally:
            conn.close()
            listener.close()

    thread = threading.Thread(target=serve)
    thread.start()
    assert ready.wait(5)
    handler = object.__new__(SequentialDetailDownloadHandler)
    handler._session = requests.Session()
    handler._session.trust_env = False
    handler._maxsize = 1024
    handler._warnsize = 512
    try:
        response = handler._download_detail(Request(f"http://127.0.0.1:{port['n']}/aa_write/1"))
    finally:
        handler._session.close()
        thread.join(5)
    assert response.body == b"<html>ok</html>"
    assert response.request is not None
    assert "redstm_truncated" not in response.request.meta
    client = [value for peer, value in recorded if peer is not None and peer[1] == port["n"]]
    numeric = [float(value) for value in client if isinstance(value, int | float)]
    assert float(REDSTM_DETAIL_FIRST_BYTE_TIMEOUT_SECONDS) in numeric
    assert client[-1] == REDSTM_DETAIL_READ_TIMEOUT_SECONDS
