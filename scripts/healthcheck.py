from __future__ import annotations

from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from crawler.settings import USER_AGENT


def ping_success(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("healthcheck URL must be credential-free HTTPS")
    try:
        urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=15).close()
    except OSError as error:
        raise RuntimeError("healthcheck success ping failed") from error


def notify_dead_man(succeeded: bool, url: str) -> None:
    # The dead-man contract pings only fully successful work so that a streak
    # of partial failures still raises the external alert.
    if url and succeeded:
        ping_success(url)
