from __future__ import annotations

from pathlib import Path

import pytest
from scrapy import Request, Spider
from scrapy.http import HtmlResponse

from crawler.middlewares import OriginProxyMiddleware
from crawler.origin_proxy import (
    active_origin_proxy,
    configured_origin_proxy,
    requests_proxies,
    reset_origin_proxy_state,
)
from crawler.spiders.typemoon import TypeMoonSpider

_DETAIL = Path(__file__).parent / "fixtures" / "typemoon" / "detail.html"


def test_origin_proxy_stays_off_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("REDSTM_ORIGIN_PROXY", raising=False)
    reset_origin_proxy_state()
    assert configured_origin_proxy() is None
    assert active_origin_proxy() is None
    assert requests_proxies() is None


def test_origin_proxy_falls_back_when_listener_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDSTM_ORIGIN_PROXY", "http://127.0.0.1:1")
    reset_origin_proxy_state()
    assert active_origin_proxy() is None
    assert requests_proxies() is None


def test_origin_proxy_middleware_sets_typemoon_meta(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDSTM_ORIGIN_PROXY", "http://127.0.0.1:18080")
    reset_origin_proxy_state()
    monkeypatch.setattr("crawler.origin_proxy._proxy_listening", lambda _url: True)
    request = Request("https://www.typemoon.net/aa_a01/1")
    OriginProxyMiddleware().process_request(request, Spider("test"))
    assert request.meta["proxy"] == "http://127.0.0.1:18080"


def test_origin_proxy_middleware_ignores_other_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDSTM_ORIGIN_PROXY", "http://127.0.0.1:18080")
    reset_origin_proxy_state()
    monkeypatch.setattr("crawler.origin_proxy._proxy_listening", lambda _url: True)
    request = Request("https://example.com/")
    OriginProxyMiddleware().process_request(request, Spider("test"))
    assert "proxy" not in request.meta


def test_truncated_detail_with_article_is_stored() -> None:
    request = Request(
        "https://www.typemoon.net/write_free21/62068",
        meta={"redstm_truncated": True},
    )
    response = HtmlResponse(
        url=request.url,
        request=request,
        body=_DETAIL.read_bytes(),
        encoding="utf-8",
    )
    item = list(TypeMoonSpider().parse_detail(response))[0]
    assert item["outcome"] == "stored"
    assert item["title"] == "대표 상세 게시물"


def test_truncated_detail_without_article_is_network_error() -> None:
    request = Request(
        "https://www.typemoon.net/write_free21/62068",
        meta={"redstm_truncated": True},
    )
    response = HtmlResponse(
        url=request.url,
        request=request,
        body=b"<html><body>partial</body></html>",
        encoding="utf-8",
    )
    item = list(TypeMoonSpider().parse_detail(response))[0]
    assert item["outcome"] == "fetch_failed"
    assert item["error_code"] == "network_error"
