from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from crawler.archive import connect_archive, initialize_archive
from crawler.session import SessionNetworkError, SessionRefreshError
from scripts.crawl_cycle import run_cycle


def _args(tmp_path: Path) -> argparse.Namespace:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.executemany(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, 'now', 'now')
            """,
            [(board, board, f"https://www.typemoon.net/{board}") for board in ("b", "a", "c", "d")],
        )
    return argparse.Namespace(
        archive=archive,
        session=tmp_path / "session.json",
        warc_dir=tmp_path / "warc",
        report_dir=tmp_path / "reports",
        max_pages=3,
        max_posts=20,
        lease_seconds=900,
        inventory=False,
    )


def _output_path(command: list[str]) -> Path:
    return Path(command[command.index("--output") + 1])


def test_cycle_runs_enabled_boards_sequentially(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    commands: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        _output_path(command).write_text(
            json.dumps(
                {
                    "ok": True,
                    "status": "succeeded",
                    "scheduled_posts": 2,
                    "outcomes": {"stored": 1, "unchanged": 1},
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "succeeded"
    assert [command[command.index("--board") + 1] for command in commands] == ["a", "b", "c", "d"]
    assert all("--session-prevalidated" in command for command in commands)
    assert report["changed_posts"] == 4
    assert report["failed_posts"] == 0
    assert report["boards_ok"] == 4
    assert report["boards_failed"] == 0


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (SessionNetworkError("offline"), "site_unreachable"),
        (SessionRefreshError("auth"), "auth_failed"),
    ],
)
def test_cycle_preflight_stops_before_boards(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status: str,
) -> None:
    args = _args(tmp_path)
    calls = 0

    def preflight(*args: object, **kwargs: object) -> None:
        nonlocal calls
        calls += 1
        raise error

    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", preflight)
    monkeypatch.setattr("scripts.crawl_cycle.time.sleep", lambda seconds: None)
    monkeypatch.setattr(
        "scripts.crawl_cycle.subprocess.run",
        lambda *args, **kwargs: pytest.fail("worker must not run"),
    )

    report = run_cycle(args)

    assert report["status"] == status
    assert calls == (2 if isinstance(error, SessionNetworkError) else 1)


def test_cycle_breaks_after_three_network_boards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    commands: list[list[str]] = []
    preserved: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def preserve(self: object, run_ids: list[str]) -> int:
        preserved.append(run_ids)
        return 7

    monkeypatch.setattr("scripts.crawl_cycle.FrontierStore.preserve_network_attempts", preserve)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        _output_path(command).write_text(
            json.dumps(
                {
                    "ok": False,
                    "status": "failed",
                    "run_id": f"run-{len(commands)}",
                    "scheduled_posts": 0,
                    "failures": ["listing_fetch_failed"],
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "site_unreachable"
    assert report["preserved_attempts"] == 7
    assert preserved == [["run-1", "run-2", "run-3"]]
    assert len(commands) == 3


def test_cycle_breaks_after_three_rate_limited_boards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    commands: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        _output_path(command).write_text(
            json.dumps(
                {
                    "ok": False,
                    "status": "failed",
                    "scheduled_posts": 1,
                    "failures": ["rate_limited"],
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "rate_limited"
    assert len(commands) == 3


def test_cycle_continues_parse_failure_but_stops_auth(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    commands: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        failure = "listing_parse_failed" if len(commands) == 1 else "auth_required"
        _output_path(command).write_text(
            json.dumps(
                {"ok": False, "status": "failed", "scheduled_posts": 0, "failures": [failure]}
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "auth_failed"
    assert len(commands) == 2
