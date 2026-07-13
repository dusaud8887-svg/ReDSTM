from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.cookiejar import Cookie, CookieJar
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import HTTPCookieProcessor, Request, build_opener

from filelock import FileLock, Timeout
from parsel import Selector

from crawler.settings import (
    REDSTM_AUTO_LOGIN_MIN_INTERVAL_SECONDS,
    REDSTM_SESSION_HTML_MAX_BYTES,
    REDSTM_SESSION_LIFETIME_SECONDS,
    REDSTM_SESSION_TIMEOUT_SECONDS,
)

if TYPE_CHECKING:
    from scrapy.http.request import VerboseCookie

_COOKIE_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_TYPEMOON_DOMAINS = {"typemoon.net", "www.typemoon.net"}
# The TypeMoon theme gates 19+ boards behind an `adult_view` cookie in addition to
# login; without it authenticated detail requests return the restricted interstitial and
# the post stays outline-only. Both legacy crawlers force this cookie on every session, so
# we inject it at load time to unlock adult-board bodies for the logged-in member.
_ADULT_COOKIE_NAME = "adult_view"
_ADULT_COOKIE_VALUE = "1"
_ADULT_COOKIE_DOMAIN = ".typemoon.net"
_BASE_URL = "https://www.typemoon.net/"
_LOGIN_PAGE_URL = f"{_BASE_URL}bbs/login.php"
_LOGIN_CHECK_URL = f"{_BASE_URL}bbs/login_check.php"
_SESSION_LIFETIME = timedelta(seconds=REDSTM_SESSION_LIFETIME_SECONDS)
_AUTO_LOGIN_MIN_INTERVAL = timedelta(seconds=REDSTM_AUTO_LOGIN_MIN_INTERVAL_SECONDS)


class SessionRefreshError(RuntimeError):
    pass


class SessionNetworkError(SessionRefreshError):
    pass


class AutomaticLoginThrottleError(SessionRefreshError):
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


def load_session_export(
    path: str | Path, *, now: datetime | None = None, allow_expired: bool = False
) -> SessionExport:
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
    if current >= expires_at and not allow_expired:
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

    return SessionExport(_with_adult_permission(cookies), created_at, expires_at, user_agent)


def _with_adult_permission(cookies: tuple[SessionCookie, ...]) -> tuple[SessionCookie, ...]:
    if any(cookie.name == _ADULT_COOKIE_NAME for cookie in cookies):
        return cookies
    return (
        *cookies,
        SessionCookie(
            _ADULT_COOKIE_NAME,
            _ADULT_COOKIE_VALUE,
            _ADULT_COOKIE_DOMAIN,
            "/",
            secure=False,
            http_only=False,
        ),
    )


def ensure_session_export(
    path: str | Path,
    *,
    user_id: str,
    password: str,
    user_agent: str,
    now: datetime | None = None,
    timeout: float = REDSTM_SESSION_TIMEOUT_SECONDS,
) -> SessionExport:
    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        raise SessionRefreshError("current time must include a timezone")
    try:
        return validate_session_export(path, now=current, timeout=timeout)
    except SessionNetworkError:
        raise
    except OSError, SessionRefreshError, ValueError:
        pass
    _reserve_automatic_login(Path(path), current)
    return refresh_session_export(
        path,
        user_id=user_id,
        password=password,
        user_agent=user_agent,
        now=current,
        timeout=timeout,
    )


def validate_session_export(
    path: str | Path,
    *,
    now: datetime | None = None,
    timeout: float = REDSTM_SESSION_TIMEOUT_SECONDS,
) -> SessionExport:
    """Validate an existing export without ever attempting a form login."""
    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        raise SessionRefreshError("current time must include a timezone")
    session = load_session_export(path, now=current, allow_expired=True)
    if not _session_is_authenticated(session, timeout=timeout):
        raise SessionRefreshError("TypeMoon session is no longer authenticated")
    return session


def _reserve_automatic_login(path: Path, now: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    marker = path.with_name(f".{path.name}.login-attempt")
    lock = FileLock(f"{marker}.lock", timeout=0)
    try:
        with lock:
            try:
                previous = datetime.fromisoformat(marker.read_text(encoding="utf-8").strip())
            except FileNotFoundError:
                previous = None
            except ValueError as error:
                raise AutomaticLoginThrottleError(
                    "automatic login throttle marker is invalid"
                ) from error
            if previous is not None:
                if previous.tzinfo is None:
                    raise AutomaticLoginThrottleError("automatic login throttle marker is invalid")
                if now < previous or now - previous < _AUTO_LOGIN_MIN_INTERVAL:
                    raise AutomaticLoginThrottleError(
                        "automatic login is limited by the configured retry interval"
                    )
            temporary: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w", encoding="utf-8", dir=path.parent, prefix=f".{marker.name}.", delete=False
                ) as stream:
                    stream.write(now.astimezone(UTC).isoformat() + "\n")
                    temporary = Path(stream.name)
                os.chmod(temporary, 0o600)
                os.replace(temporary, marker)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
    except Timeout as error:
        raise AutomaticLoginThrottleError("automatic login is already in progress") from error


def _session_is_authenticated(session: SessionExport, *, timeout: float) -> bool:
    cookie_jar = CookieJar()
    for cookie in session.cookies:
        cookie_jar.set_cookie(
            Cookie(
                version=0,
                name=cookie.name,
                value=cookie.value,
                port=None,
                port_specified=False,
                domain=cookie.domain,
                domain_specified=True,
                domain_initial_dot=cookie.domain.startswith("."),
                path=cookie.path,
                path_specified=True,
                secure=cookie.secure,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={"HttpOnly": ""} if cookie.http_only else {},
                rfc2109=False,
            )
        )
    opener = build_opener(HTTPCookieProcessor(cookie_jar))
    try:
        home_html = _read_html(
            opener.open(
                Request(
                    _BASE_URL,
                    headers={"User-Agent": session.user_agent, "Connection": "close"},
                ),
                timeout=timeout,
            ),
            complete=_has_auth_marker,
        )
    except (HTTPError, URLError, OSError) as error:
        raise SessionNetworkError("TypeMoon session validation request failed") from error
    return _has_logout_link(home_html)


def refresh_session_export(
    path: str | Path,
    *,
    user_id: str,
    password: str,
    user_agent: str,
    now: datetime | None = None,
    timeout: float = REDSTM_SESSION_TIMEOUT_SECONDS,
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
                Request(
                    _LOGIN_PAGE_URL,
                    headers={"User-Agent": user_agent, "Connection": "close"},
                ),
                timeout=timeout,
            ),
            complete=_has_login_form,
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
                "Connection": "close",
            },
        )
        opener.open(request, timeout=timeout).close()
        home_html = _read_html(
            opener.open(
                Request(
                    _BASE_URL,
                    headers={"User-Agent": user_agent, "Connection": "close"},
                ),
                timeout=timeout,
            ),
            complete=_has_auth_marker,
        )
    except SessionRefreshError:
        raise
    except (HTTPError, URLError, OSError) as error:
        raise SessionNetworkError("TypeMoon session refresh request failed") from error

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
    # The adult_view cookie is a synthetic runtime permission, not a real login artifact, so
    # it is injected for use but never written to disk (keeping the persisted export the exact
    # set of server-issued cookies). load_session_export re-injects it on every read.
    _write_session_export(Path(path), session)
    return SessionExport(
        _with_adult_permission(session.cookies),
        session.created_at,
        session.expires_at,
        session.user_agent,
    )


def _read_html(response: object, *, complete: Callable[[str], bool]) -> str:
    charset = response.headers.get_content_charset() or "utf-8"  # type: ignore[attr-defined]
    body = bytearray()
    while len(body) < REDSTM_SESSION_HTML_MAX_BYTES:
        chunk = response.read(  # type: ignore[attr-defined]
            min(16 * 1024, REDSTM_SESSION_HTML_MAX_BYTES - len(body))
        )
        if not chunk:
            break
        body.extend(chunk)
        html = body.decode(charset, "replace")
        if complete(html):
            return html
    if len(body) == REDSTM_SESSION_HTML_MAX_BYTES:
        raise SessionRefreshError("TypeMoon session response exceeded the configured safety limit")
    return body.decode(charset, "replace")


def _login_form(html: str) -> Selector:
    selector = Selector(text=html)
    for form in selector.css("form"):
        names = set(form.css("input[name]::attr(name)").getall())
        if {"mb_id", "mb_password"} <= names:
            return form
    raise SessionRefreshError("TypeMoon login form was not found")


def _has_login_form(html: str) -> bool:
    try:
        _login_form(html)
    except SessionRefreshError:
        return False
    return True


def _has_logout_link(html: str) -> bool:
    return any(
        "logout" in href.lower() for href in Selector(text=html).css("a::attr(href)").getall()
    )


def _has_auth_marker(html: str) -> bool:
    return _has_logout_link(html) or any(
        "login" in href.lower() for href in Selector(text=html).css("a::attr(href)").getall()
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
