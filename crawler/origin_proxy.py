from __future__ import annotations

import os
import socket
from urllib.parse import urlsplit
from urllib.request import ProxyHandler

TYPEMOON_ORIGIN_HOSTS = frozenset({"typemoon.net", "www.typemoon.net"})
_mode = "unset"


def configured_origin_proxy() -> str | None:
    raw = os.environ.get("REDSTM_ORIGIN_PROXY", "").strip()
    return raw or None


def reset_origin_proxy_state() -> None:
    global _mode
    _mode = "unset"


def _proxy_listening(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((parsed.hostname, port), timeout=0.5):
            return True
    except OSError:
        return False


def active_origin_proxy() -> str | None:
    global _mode
    url = configured_origin_proxy()
    if not url:
        return None
    if _mode == "direct":
        return None
    if _mode == "proxy":
        return url
    if _proxy_listening(url):
        _mode = "proxy"
        return url
    _mode = "direct"
    return None


def requests_proxies() -> dict[str, str] | None:
    url = active_origin_proxy()
    return None if url is None else {"http": url, "https": url}


def urllib_proxy_handler() -> ProxyHandler | None:
    url = active_origin_proxy()
    return None if url is None else ProxyHandler({"http": url, "https": url})
