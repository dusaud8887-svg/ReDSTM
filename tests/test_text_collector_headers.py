from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
import requests

from scripts.text_archive import collector
from scripts.text_archive.collector import RequestUnit, Source, _api_headers

_SOURCES = (Source("blacktoon", "blacktoon454.com"), Source("marumaru", "marumaru103.com"))

# Minimal shared-state shape for run_one: the collector's classification paths only touch
# text_collector_groups / text_collector_state / text_collector_hosts / the queue.
_EXTRA_SCHEMA = """
CREATE TABLE IF NOT EXISTS text_collector_groups (
  group_id TEXT PRIMARY KEY, last_request_at INTEGER NOT NULL DEFAULT 0,
  last_source TEXT NOT NULL DEFAULT '', cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER, last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS text_collector_state (
  source TEXT PRIMARY KEY, total_count INTEGER NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
"""


def _unit() -> RequestUnit:
    source = Source("marumaru", "marumaru103.com")
    return RequestUnit(source, "work", "7", f"{source.base_url}/api/works/7")


def _seed(db_path: Path) -> None:
    db = collector._connect(db_path)
    try:
        db.executescript(collector._SCHEMA)
        db.executescript(_EXTRA_SCHEMA)
        with db:
            collector._enqueue(db, "marumaru", "work", "7", "3")
            for source in _SOURCES:
                # Park the listing scanners far in the future so the queued work unit wins.
                db.execute(
                    "INSERT INTO text_collector_state(source,next_page,next_check_at,updated_at)"
                    " VALUES(?,1,9999999999,'')",
                    (f"{source.name}:list",),
                )
    finally:
        db.close()


def _group(db_path: Path) -> tuple[int, int, str] | None:
    with sqlite3.connect(db_path) as db:
        return db.execute(
            "SELECT cooldown_until, last_status, last_error FROM text_collector_groups "
            "WHERE group_id='blacktoon-marumaru-novel:marumaru'"
        ).fetchone()


def test_api_headers_are_browser_coherent() -> None:
    headers = _api_headers(_unit())
    assert "Chrome/" in headers["User-Agent"]
    assert headers["Accept"] == "application/json"
    assert headers["Accept-Language"].startswith("ko-KR")
    assert headers["sec-ch-ua-platform"] == '"Windows"'
    assert headers["Sec-Fetch-Site"] == "same-origin"
    assert headers["Sec-Fetch-Dest"] == "empty"
    assert headers["Sec-Fetch-Mode"] == "cors"
    assert headers["Referer"] == "https://marumaru103.com/"


def test_406_is_a_block_signal_with_cooldown_but_not_a_host_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "state.sqlite"
    _seed(db_path)
    monkeypatch.setattr(collector, "_get", lambda *_a, **_k: (406, b"", {}))

    result = collector.run_one(db_path, tmp_path / "out", _SOURCES, session=requests.Session())

    assert result["status"] == "cooldown"
    assert result["http_status"] == 406
    group = _group(db_path)
    assert group is not None and group[2] == "http_406" and group[1] == 406
    with sqlite3.connect(db_path) as db:
        blocked = [row[0] for row in db.execute("SELECT blocked FROM text_collector_hosts")]
        queue = db.execute(
            "SELECT attempts, last_error FROM text_collector_queue WHERE kind='work'"
        ).fetchone()
    assert blocked == [] or all(value == 0 for value in blocked)
    assert queue == (1, "http_406")


def test_html_gate_on_200_holds_instead_of_failing_every_unit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "state.sqlite"
    _seed(db_path)
    monkeypatch.setattr(
        collector,
        "_get",
        lambda *_a, **_k: (
            200,
            b"<!DOCTYPE html><html><body>gate</body></html>",
            {"Content-Type": "text/html; charset=utf-8"},
        ),
    )

    result = collector.run_one(db_path, tmp_path / "out", _SOURCES, session=requests.Session())

    assert result["status"] == "cooldown"
    assert result["http_status"] == 200
    group = _group(db_path)
    assert group is not None and group[2] == "html_gate"
    with sqlite3.connect(db_path) as db:
        queue = db.execute(
            "SELECT attempts, last_error FROM text_collector_queue WHERE kind='work'"
        ).fetchone()
    assert queue == (1, "html_gate")


class _FakeTime:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_rotation_then_406_cools_the_source_and_headers_follow_the_rotated_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two 5xx failures cycle the host suffix (+1); a 406 on the rotated host then holds the
    # source (a UA-based gate), and the request headers stay coherent with the rotated host.
    db_path = tmp_path / "state.sqlite"
    _seed(db_path)
    fake = _FakeTime()
    monkeypatch.setattr(collector, "time", fake)
    requested: list[str] = []
    rotated: list[RequestUnit] = []

    def fake_get(
        session: requests.Session, unit: RequestUnit, path: Path
    ) -> tuple[int, bytes, dict[str, str]]:
        requested.append(unit.source.host)
        if unit.source.host == "marumaru103.com":
            return 502, b"", {}
        rotated.append(unit)
        return 406, b"", {}

    monkeypatch.setattr(collector, "_get", fake_get)

    first = collector.run_one(
        db_path, tmp_path / "out", _SOURCES, session=requests.Session(), clock=fake.time
    )
    fake.now += 2_000  # past the 502 group cooldown and the queue retry delay
    second = collector.run_one(
        db_path, tmp_path / "out", _SOURCES, session=requests.Session(), clock=fake.time
    )

    assert first["status"] == "held"
    assert second["status"] == "cooldown"
    assert second["http_status"] == 406
    assert requested == ["marumaru103.com", "marumaru103.com", "marumaru104.com"]
    assert _api_headers(rotated[0])["Referer"] == "https://marumaru104.com/"
    group = _group(db_path)
    assert group is not None and group[1] == 406 and group[2] == "http_406"
    with sqlite3.connect(db_path) as db:
        queue = db.execute(
            "SELECT attempts, last_error FROM text_collector_queue WHERE kind='work'"
        ).fetchone()
    assert queue == (2, "http_406")


def test_collector_ua_override_replaces_user_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import importlib

    monkeypatch.setenv("REDSTM_TEXT_COLLECTOR_UA", "TestAgent/1.0 Custom")
    try:
        module = importlib.reload(collector)
        headers = module._api_headers(_unit())
        assert headers["User-Agent"] == "TestAgent/1.0 Custom"
        # No Chrome version to mirror: the client-hints brand falls back to a fixed major.
        assert 'v="150"' in headers["sec-ch-ua"]
    finally:
        monkeypatch.delenv("REDSTM_TEXT_COLLECTOR_UA", raising=False)
        importlib.reload(collector)
