from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.cookiejar import CookieJar
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import HTTPCookieProcessor, Request, build_opener

from parsel import Selector

if TYPE_CHECKING:
    from scrapy.http.request import VerboseCookie

_COOKIE_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_TYPEMOON_DOMAINS = {"typemoon.net", "www.typemoon.net"}
_BASE_URL = "https://www.typemoon.net/"
_LOGIN_PAGE_URL = f"{_BASE_URL}bbs/login.php"
_LOGIN_CHECK_URL = f"{_BASE_URL}bbs/login_check.php"
_SESSION_LIFETIME = timedelta(hours=4)


class SessionRefreshError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SessionCookie:
    name: str
    value: str = field(repr=False)
    domain: str
    path: str
    secure: bool
    http_only: bool

    def as_scrapy_cookie(self) -> VerboseCookie:
        return {
            "name": self.name,
            "value": self.value,
            "domain": self.domain,
            "path": self.path,
            "secure": self.secure,
        }


@dataclass(frozen=True, slots=True)
class SessionExport:
    cookies: tuple[SessionCookie, ...]
    created_at: datetime
    expires_at: datetime
    user_agent: str

    def as_scrapy_cookies(self) -> list[VerboseCookie]:
        return [cookie.as_scrapy_cookie() for cookie in self.cookies]


def load_session_export(path: str | Path, *, now: datetime | None = None) -> SessionExport:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("session export must be a JSON object")

    created_at = _timestamp(payload.get("created_at"), "created_at")
    expires_at = _timestamp(payload.get("expires_at"), "expires_at")
    if created_at >= expires_at:
        raise ValueError("session export timestamps are invalid")

    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        raise ValueError("current time must include a timezone")
    if current >= expires_at:
        raise ValueError("session export has expired")

    user_agent = _text(payload.get("user_agent"), "user_agent")
    if "\r" in user_agent or "\n" in user_agent:
        raise ValueError("session user_agent contains control characters")

    raw_cookies = payload.get("cookies")
    if not isinstance(raw_cookies, list) or not raw_cookies:
        raise ValueError("session cookies must be a non-empty list")
    cookies = tuple(_cookie(raw, index) for index, raw in enumerate(raw_cookies))
    identities = {(cookie.name, cookie.domain, cookie.path) for cookie in cookies}
    if len(identities) != len(cookies):
        raise ValueError("session export contains duplicate cookies")

    return SessionExport(cookies, created_at, expires_at, user_agent)


def refresh_session_export(
    path: str | Path,
    *,
    user_id: str,
    password: str,
    user_agent: str,
    now: datetime | None = None,
    timeout: float = 30.0,
) -> SessionExport:
    if not user_id or not password:
        raise SessionRefreshError("TypeMoon credentials are missing")
    if not user_agent.strip() or any(char in user_agent for char in "\r\n"):
        raise SessionRefreshError("user agent is invalid")

    created_at = now or datetime.now(UTC)
    if created_at.tzinfo is None:
        raise SessionRefreshError("current time must include a timezone")

    cookie_jar = CookieJar()
    opener = build_opener(HTTPCookieProcessor(cookie_jar))
    try:
        login_html = _read_html(
            opener.open(
                Request(_LOGIN_PAGE_URL, headers={"User-Agent": user_agent}), timeout=timeout
            )
        )
        form = _login_form(login_html)
        action = urljoin(_LOGIN_PAGE_URL, form.attrib.get("action", ""))
        if action != _LOGIN_CHECK_URL:
            raise SessionRefreshError("TypeMoon login form action is not recognized")

        fields = {
            name: value
            for node in form.css("input[type=hidden][name]")
            if (name := node.attrib.get("name")) and (value := node.attrib.get("value")) is not None
        }
        fields.update({"mb_id": user_id, "mb_password": password, "auto_login": "1"})
        request = Request(
            action,
            data=urlencode(fields).encode("utf-8"),
            headers={
                "User-Agent": user_agent,
                "Referer": _LOGIN_PAGE_URL,
                "Origin": _BASE_URL.rstrip("/"),
            },
        )
        opener.open(request, timeout=timeout).close()
        home_html = _read_html(
            opener.open(Request(_BASE_URL, headers={"User-Agent": user_agent}), timeout=timeout)
        )
    except SessionRefreshError:
        raise
    except (HTTPError, URLError, OSError) as error:
        raise SessionRefreshError("TypeMoon session refresh request failed") from error

    if not _has_logout_link(home_html):
        raise SessionRefreshError("TypeMoon authentication could not be verified")

    cookies = tuple(
        SessionCookie(
            cookie.name,
            cookie.value,
            cookie.domain,
            cookie.path,
            cookie.secure,
            cookie.has_nonstandard_attr("HttpOnly"),
        )
        for cookie in cookie_jar
        if cookie.value is not None and cookie.domain.lstrip(".").lower() in _TYPEMOON_DOMAINS
    )
    if not cookies:
        raise SessionRefreshError("TypeMoon login returned no usable session cookies")

    session = SessionExport(cookies, created_at, created_at + _SESSION_LIFETIME, user_agent.strip())
    _write_session_export(Path(path), session)
    return session


def _read_html(response: object) -> str:
    body = response.read()  # type: ignore[attr-defined]
    charset = response.headers.get_content_charset() or "utf-8"  # type: ignore[attr-defined]
    return body.decode(charset, "replace")


def _login_form(html: str) -> Selector:
    selector = Selector(text=html)
    for form in selector.css("form"):
        names = set(form.css("input[name]::attr(name)").getall())
        if {"mb_id", "mb_password"} <= names:
            return form
    raise SessionRefreshError("TypeMoon login form was not found")


def _has_logout_link(html: str) -> bool:
    return any(
        "logout" in href.lower() for href in Selector(text=html).css("a::attr(href)").getall()
    )


def _write_session_export(path: Path, session: SessionExport) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "cookies": [
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
                "httpOnly": cookie.http_only,
            }
            for cookie in session.cookies
        ],
        "created_at": session.created_at.isoformat(),
        "expires_at": session.expires_at.isoformat(),
        "user_agent": session.user_agent,
        "metadata": {"session_format_version": 2},
    }
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as stream:
            json.dump(payload, stream, ensure_ascii=True, separators=(",", ":"))
            stream.write("\n")
            temporary_path = Path(stream.name)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _cookie(value: object, index: int) -> SessionCookie:
    if not isinstance(value, dict):
        raise ValueError(f"session cookie {index} must be an object")

    name = _text(value.get("name"), f"cookie {index} name")
    if not _COOKIE_NAME.fullmatch(name):
        raise ValueError(f"session cookie {index} has an invalid name")
    cookie_value = value.get("value")
    if not isinstance(cookie_value, str) or any(char in cookie_value for char in "\r\n\0"):
        raise ValueError(f"session cookie {index} has an invalid value")

    domain = _text(value.get("domain"), f"cookie {index} domain").lower()
    if domain.lstrip(".") not in _TYPEMOON_DOMAINS:
        raise ValueError(f"session cookie {index} has a non-TypeMoon domain")
    cookie_path = _text(value.get("path"), f"cookie {index} path")
    if not cookie_path.startswith("/") or any(char in cookie_path for char in "\r\n"):
        raise ValueError(f"session cookie {index} has an invalid path")

    secure = value.get("secure")
    http_only = value.get("httpOnly")
    if not isinstance(secure, bool) or not isinstance(http_only, bool):
        raise ValueError(f"session cookie {index} flags must be booleans")
    return SessionCookie(name, cookie_value, domain, cookie_path, secure, http_only)


def _timestamp(value: object, label: str) -> datetime:
    text = _text(value, label)
    try:
        timestamp = datetime.fromisoformat(text)
    except ValueError as error:
        raise ValueError(f"session {label} must be an ISO timestamp") from error
    if timestamp.tzinfo is None:
        raise ValueError(f"session {label} must include a timezone")
    return timestamp


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"session {label} must be a non-empty string")
    return value.strip()
