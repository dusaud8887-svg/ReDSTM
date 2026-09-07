from __future__ import annotations

import os
import socket
from urllib.parse import urlsplit
from urllib.request import ProxyHandler

TYPEMOON_ORIGIN_HOSTS = frozenset({"typemoon.net", "www.typemoon.net"})


def configured_origin_proxy() -> str | None:
    raw = os.environ.get("REDSTM_ORIGIN_PROXY", "").strip()
    return raw or None


def _proxy_listening(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        with socket.create_connection((parsed.hostname, port), timeout=0.5):
            return True
    except OSError, ValueError:
        return False


def active_origin_proxy() -> str | None:
    url = configured_origin_proxy()
    return url if url and _proxy_listening(url) else None


def requests_proxies() -> dict[str, str] | None:
    url = active_origin_proxy()
    return None if url is None else {"http": url, "https": url}


def urllib_proxy_handler() -> ProxyHandler | None:
    url = active_origin_proxy()
    return None if url is None else ProxyHandler({"http": url, "https": url})
