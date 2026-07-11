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
    SessionRefreshError,
    ensure_session_export,
    load_session_export,
    refresh_session_export,
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
    assert b"Cookie" not in request.headers
    assert request.meta["cookiejar"] == 1
    assert request.meta["redstm_capture"] is True


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

    assert state["post_count"] == 1
    assert session.cookies[0].value == "secret"


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
