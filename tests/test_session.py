from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

import pytest

import crawler.session as session_module
from crawler.session import (
    AutomaticLoginThrottleError,
    SessionNetworkError,
    SessionRefreshError,
    ensure_session_export,
    load_session_export,
    refresh_session_export,
    validate_session_export,
)
from crawler.spiders.typemoon import TypeMoonSpider


def _session_file(tmp_path: Path, *, domain: str = ".typemoon.net") -> Path:
    path = tmp_path / "session.json"
    path.write_text(
        json.dumps(
            {
                "cookies": [
                    {
                        "name": "PHPSESSID",
                        "value": "cookie-secret",
                        "domain": domain,
                        "path": "/",
                        "secure": True,
                        "httpOnly": True,
                    }
                ],
                "created_at": "2026-07-11T00:00:00+00:00",
                "expires_at": "2026-07-12T00:00:00+00:00",
                "user_agent": "ReDSTM-test/1.0",
                "metadata": {"session_format_version": 2},
            }
        ),
        encoding="utf-8",
    )
    return path


def test_valid_session_builds_captured_detail_request_without_repr_leak(tmp_path: Path) -> None:
    session = load_session_export(
        _session_file(tmp_path), now=datetime(2026, 7, 11, 12, tzinfo=UTC)
    )
    request = TypeMoonSpider().detail_request("write_free21", 62068, session)

    assert "cookie-secret" not in repr(session)
    assert request.url == "https://www.typemoon.net/write_free21/62068"
    assert isinstance(request.cookies, list)
    assert request.cookies[0]["value"] == "cookie-secret"
    assert request.headers["User-Agent"] == b"ReDSTM-test/1.0"
    assert request.headers["Referer"] == b"https://www.typemoon.net/write_free21"
    assert request.headers["Sec-Fetch-Site"] == b"same-origin"
    assert b"Cookie" not in request.headers
    assert request.meta["cookiejar"] == 1
    assert request.meta["redstm_capture"] is True


def test_handshake_headers_present_a_consistent_browser_footprint() -> None:
    # The login handshake is the first request a WAF sees; it must carry the same UA client
    # hints and fetch-metadata headers as the crawl, with Sec-Fetch-Site mirroring Referer.
    fresh = session_module._handshake_headers("ReDSTM-test/1.0")
    assert fresh["Sec-Fetch-Site"] == "none"
    assert fresh["sec-ch-ua-platform"] == '"Windows"'
    assert fresh["Upgrade-Insecure-Requests"] == "1"
    assert fresh["Sec-Fetch-Mode"] == "navigate"
    assert fresh["Connection"] == "close"

    in_site = session_module._handshake_headers(
        "ReDSTM-test/1.0", Referer="https://www.typemoon.net/bbs/login.php"
    )
    assert in_site["Sec-Fetch-Site"] == "same-origin"


def test_loaded_session_carries_the_adult_permission_cookie(tmp_path: Path) -> None:
    session = load_session_export(
        _session_file(tmp_path), now=datetime(2026, 7, 11, 12, tzinfo=UTC)
    )
    adult = [cookie for cookie in session.cookies if cookie.name == "adult_view"]

    assert len(adult) == 1
    assert adult[0].value == "1"
    assert adult[0].domain == ".typemoon.net"
    scrapy_cookies = {cookie["name"] for cookie in session.as_scrapy_cookies()}
    assert "adult_view" in scrapy_cookies


def test_existing_adult_cookies_are_replaced_with_one_canonical_cookie(tmp_path: Path) -> None:
    path = tmp_path / "session.json"
    path.write_text(
        json.dumps(
            {
                "cookies": [
                    {
                        "name": "PHPSESSID",
                        "value": "cookie-secret",
                        "domain": ".typemoon.net",
                        "path": "/",
                        "secure": True,
                        "httpOnly": True,
                    },
                    {
                        "name": "adult_view",
                        "value": "0",
                        "domain": "www.typemoon.net",
                        "path": "/bbs",
                        "secure": True,
                        "httpOnly": True,
                    },
                    {
                        "name": "adult_view",
                        "value": "stale",
                        "domain": ".typemoon.net",
                        "path": "/old",
                        "secure": False,
                        "httpOnly": False,
                    },
                ],
                "created_at": "2026-07-11T00:00:00+00:00",
                "expires_at": "2026-07-12T00:00:00+00:00",
                "user_agent": "ReDSTM-test/1.0",
                "metadata": {"session_format_version": 2},
            }
        ),
        encoding="utf-8",
    )
    session = load_session_export(path, now=datetime(2026, 7, 11, 12, tzinfo=UTC))

    adult = [cookie for cookie in session.cookies if cookie.name == "adult_view"]
    assert len(adult) == 1
    assert adult[0].value == "1"
    assert adult[0].domain == ".typemoon.net"
    assert adult[0].path == "/"
    assert adult[0].secure is False
    assert adult[0].http_only is False


def test_session_rejects_expiry_and_non_typemoon_cookie_domain(tmp_path: Path) -> None:
    path = _session_file(tmp_path)
    with pytest.raises(ValueError, match="expired"):
        load_session_export(path, now=datetime(2026, 7, 12, tzinfo=UTC))

    path = _session_file(tmp_path, domain="example.com")
    with pytest.raises(ValueError, match="non-TypeMoon domain"):
        load_session_export(path, now=datetime(2026, 7, 11, 12, tzinfo=UTC))


@contextmanager
def _login_server(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[dict[str, int], str]]:
    state = {"post_count": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/bbs/login.php":
                self._html(
                    "<form method='post' action='/bbs/login_check.php'>"
                    "<input type='hidden' name='url' value='/'>"
                    "<input name='mb_id'><input type='password' name='mb_password'>"
                    "</form>"
                )
                return
            if self.path == "/" and "PHPSESSID=secret" in self.headers.get("Cookie", ""):
                self._html("<a href='/bbs/logout.php'>logout</a>")
                return
            self._html("<a href='/bbs/login.php'>login</a>")

        def do_POST(self) -> None:
            state["post_count"] += 1
            length = int(self.headers.get("Content-Length", "0"))
            fields = parse_qs(self.rfile.read(length).decode("utf-8"))
            if fields.get("mb_id") == ["member"] and fields.get("mb_password") == ["correct"]:
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Set-Cookie", "PHPSESSID=secret; Path=/; HttpOnly")
                self.end_headers()
                return
            self._html("<a href='/bbs/login.php'>login</a>")

        def log_message(self, format: str, *args: object) -> None:
            pass

        def _html(self, body: str) -> None:
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/"
    monkeypatch.setattr(session_module, "_BASE_URL", base_url)
    monkeypatch.setattr(session_module, "_LOGIN_PAGE_URL", f"{base_url}bbs/login.php")
    monkeypatch.setattr(session_module, "_LOGIN_CHECK_URL", f"{base_url}bbs/login_check.php")
    monkeypatch.setattr(session_module, "_TYPEMOON_DOMAINS", {"127.0.0.1"})
    try:
        yield state, base_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_refresh_session_submits_once_and_writes_loadable_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "private" / "session.json"
    now = datetime(2026, 7, 11, 12, tzinfo=UTC)

    with _login_server(monkeypatch) as (state, _):
        session = refresh_session_export(
            path,
            user_id="member",
            password="correct",
            user_agent="ReDSTM-test/1.0",
            now=now,
        )

    assert state["post_count"] == 1
    assert session.expires_at == datetime(2026, 7, 11, 16, tzinfo=UTC)
    assert "secret" not in repr(session)
    assert [cookie.name for cookie in session.cookies].count("adult_view") == 1
    persisted_names = {cookie["name"] for cookie in json.loads(path.read_text())["cookies"]}
    assert persisted_names == {"PHPSESSID"}
    assert load_session_export(path, now=now).cookies[0].name == "PHPSESSID"


def test_expired_export_is_validated_before_form_login(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "private" / "session.json"
    now = datetime(2026, 7, 11, 12, tzinfo=UTC)

    with _login_server(monkeypatch) as (state, _):
        refresh_session_export(
            path,
            user_id="member",
            password="correct",
            user_agent="ReDSTM-test/1.0",
            now=now,
        )
        session = ensure_session_export(
            path,
            user_id="member",
            password="correct",
            user_agent="ReDSTM-test/1.0",
            now=datetime(2026, 7, 11, 17, tzinfo=UTC),
        )
        validated = validate_session_export(
            path,
            now=datetime(2026, 7, 11, 17, tzinfo=UTC),
        )

    assert state["post_count"] == 1
    assert session.cookies[0].value == "secret"
    assert validated == session


def test_session_validation_stops_after_logout_marker_before_broken_eof(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Headers:
        def get_content_charset(self) -> str:
            return "utf-8"

    class HangingResponse:
        headers = Headers()
        reads = 0

        def read(self, _size: int) -> bytes:
            self.reads += 1
            if self.reads == 1:
                return b"<a href='/bbs/logout.php'>logout</a>"
            raise TimeoutError("server never closes the response")

    response = HangingResponse()

    class HangingOpener:
        def open(self, request: object, timeout: float) -> HangingResponse:
            assert request.get_header("Connection") == "close"  # type: ignore[attr-defined]
            assert timeout == 30
            return response

    monkeypatch.setattr(session_module, "build_opener", lambda *handlers: HangingOpener())

    session = ensure_session_export(
        _session_file(tmp_path),
        user_id="member",
        password="unused",
        user_agent="ReDSTM-test/1.0",
        now=datetime(2026, 7, 11, 12, tzinfo=UTC),
    )

    assert session.cookies[0].name == "PHPSESSID"
    assert response.reads == 1


def test_session_reader_stops_after_login_marker_before_broken_eof() -> None:
    class Headers:
        def get_content_charset(self) -> str:
            return "utf-8"

    class HangingResponse:
        headers = Headers()
        reads = 0

        def read(self, _size: int) -> bytes:
            self.reads += 1
            if self.reads == 1:
                return b"<a href='/bbs/login.php'>login</a>"
            raise TimeoutError("server never closes the response")

    response = HangingResponse()
    html = session_module._read_html(response, complete=session_module._has_auth_marker)

    assert "login.php" in html
    assert response.reads == 1


def test_automatic_login_is_throttled_for_thirty_minutes_after_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "private" / "session.json"
    first = datetime(2026, 7, 11, 12, tzinfo=UTC)

    with _login_server(monkeypatch) as (state, _):
        with pytest.raises(SessionRefreshError, match="verified"):
            ensure_session_export(
                path,
                user_id="member",
                password="wrong",
                user_agent="ReDSTM-test/1.0",
                now=first,
            )
        with pytest.raises(AutomaticLoginThrottleError, match="configured retry interval"):
            ensure_session_export(
                path,
                user_id="member",
                password="wrong",
                user_agent="ReDSTM-test/1.0",
                now=first.replace(minute=29),
            )
        assert state["post_count"] == 1
        with pytest.raises(SessionRefreshError, match="verified"):
            ensure_session_export(
                path,
                user_id="member",
                password="wrong",
                user_agent="ReDSTM-test/1.0",
                now=first.replace(minute=30),
            )

    assert state["post_count"] == 2


def test_session_network_failure_is_distinct_from_auth_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class OfflineOpener:
        def open(self, request: object, timeout: float) -> object:
            raise OSError("offline")

    monkeypatch.setattr(session_module, "build_opener", lambda *handlers: OfflineOpener())

    with pytest.raises(SessionNetworkError, match="validation request failed"):
        ensure_session_export(
            _session_file(tmp_path),
            user_id="member",
            password="secret",
            user_agent="ReDSTM-test/1.0",
            now=datetime(2026, 7, 11, 12, tzinfo=UTC),
        )


def test_refresh_failure_preserves_existing_export_and_hides_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "session.json"
    path.write_text("existing-session", encoding="utf-8")

    with _login_server(monkeypatch) as (state, _):
        with pytest.raises(SessionRefreshError) as captured:
            refresh_session_export(
                path,
                user_id="member",
                password="wrong-secret",
                user_agent="ReDSTM-test/1.0",
            )

    assert state["post_count"] == 1
    assert "wrong-secret" not in str(captured.value)
    assert path.read_text(encoding="utf-8") == "existing-session"
