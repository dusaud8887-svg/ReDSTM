from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from crawler.archive import connect_archive, initialize_archive
from crawler.session import (
    AutomaticLoginThrottleError,
    SessionNetworkError,
    SessionRefreshError,
)
from scripts.crawl_cycle import _boards, run_cycle


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
        max_seconds=14_400,
        lease_seconds=900,
        inventory=False,
    )


def _output_path(command: list[str]) -> Path:
    return Path(command[command.index("--output") + 1])


def test_inventory_prioritizes_in_progress_and_skips_boards_completed_in_this_pass(
    tmp_path: Path,
) -> None:
    args = _args(tmp_path)
    started_at = "2026-07-12T00:00:00Z"
    with connect_archive(args.archive) as connection:
        connection.execute(
            "UPDATE boards SET inventory_next_page = 4, last_inventory_at = ? WHERE board_id = 'a'",
            (started_at,),
        )
        connection.execute("UPDATE boards SET last_inventory_at = NULL WHERE board_id = 'b'")
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-11T00:00:00Z' WHERE board_id = 'c'"
        )
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-12T01:00:00Z' WHERE board_id = 'd'"
        )

    assert _boards(args.archive, inventory=True, inventory_since=started_at) == ["a", "b", "c"]

    with connect_archive(args.archive) as connection:
        connection.execute(
            "UPDATE boards SET inventory_next_page = 1, last_inventory_at = ? WHERE board_id = 'a'",
            (started_at,),
        )
    assert _boards(args.archive, inventory=True, inventory_since=started_at) == ["b", "c"]


def test_inventory_cycle_with_full_coverage_reports_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A resumed full-catalog can find every board already covered since the pass epoch;
    # an empty cycle is completion, not "no enabled boards".
    args = _args(tmp_path)
    args.inventory = True
    args.inventory_since = "2026-07-12T00:00:00Z"
    with connect_archive(args.archive) as connection:
        connection.execute(
            "UPDATE boards SET inventory_next_page = 1, last_inventory_at = '2026-07-13T00:00:00Z'"
        )

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("no worker may run when inventory coverage is complete")

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", refuse)

    report = run_cycle(args)

    assert report["ok"] is True
    assert report["status"] == "succeeded"
    assert report["inventory_coverage_complete"] is True
    assert report["boards"] == []
    assert report["changed_posts"] == 0


def test_cycle_runs_enabled_boards_sequentially(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    commands: list[list[str]] = []
    timeouts: list[int] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        timeout = kwargs["timeout"]
        assert isinstance(timeout, int)
        timeouts.append(timeout)
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
    assert all("--parent-lock-held" in command for command in commands)
    budgets = [int(command[command.index("--max-seconds") + 1]) for command in commands]
    assert all(1 <= budget <= 14_400 for budget in budgets)
    assert budgets == sorted(budgets, reverse=True)
    assert timeouts == [budget + 120 for budget in budgets]
    assert report["changed_posts"] == 4
    assert report["failed_posts"] == 0
    assert report["boards_ok"] == 4
    assert report["boards_failed"] == 0


def test_cycle_stops_at_board_boundary_when_time_budget_expires(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    args.max_seconds = 10
    commands: list[list[str]] = []
    clock = iter((0.0, 0.0, 11.0))
    monkeypatch.setattr("scripts.crawl_cycle.time.monotonic", lambda: next(clock))
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        _output_path(command).write_text(
            json.dumps(
                {
                    "ok": True,
                    "status": "succeeded",
                    "scheduled_posts": 0,
                    "outcomes": {},
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert len(commands) == 1
    assert commands[0][commands[0].index("--max-seconds") + 1] == "10"
    assert report["status"] == "partial"
    assert report["stop_reason"] == "time_budget"


def test_cycle_stops_at_a_board_boundary_when_disk_reaches_the_hard_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    args.disk_stop_bytes = 100
    commands: list[list[str]] = []
    free_bytes = iter((101, 99))
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "scripts.crawl_cycle.shutil.disk_usage",
        lambda _path: SimpleNamespace(free=next(free_bytes)),
    )

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        _output_path(command).write_text(
            json.dumps({"ok": True, "status": "succeeded", "outcomes": {}}),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert len(commands) == 1
    assert report["status"] == "partial"
    assert report["safe_code"] == "disk_low"
    assert report["stop_reason"] == "disk_low"


def test_cycle_honors_pause_before_session_preflight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    args.pause_file = tmp_path / "schedule.paused"
    args.pause_file.touch()
    monkeypatch.setattr(
        "scripts.crawl_cycle.ensure_session_export",
        lambda *args, **kwargs: pytest.fail("paused cycle must not validate a session"),
    )
    monkeypatch.setattr(
        "scripts.crawl_cycle.notify_dead_man",
        lambda *args, **kwargs: pytest.fail("intentional pause must not fail dead-man"),
    )

    report = run_cycle(args)

    assert report["status"] == "partial"
    assert report["stop_reason"] == "schedule_paused"


def test_cycle_revalidates_session_after_thirty_minutes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    initial_logins = 0
    validations = 0
    clock = iter((0.0, 0.0, 1_801.0, 1_802.0, 1_803.0))
    monkeypatch.setattr("scripts.crawl_cycle.time.monotonic", lambda: next(clock))

    def ensure(*args: object, **kwargs: object) -> None:
        nonlocal initial_logins
        initial_logins += 1

    def validate(*args: object, **kwargs: object) -> None:
        nonlocal validations
        validations += 1

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        _output_path(command).write_text(
            json.dumps({"ok": True, "status": "succeeded", "outcomes": {}}),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", ensure)
    monkeypatch.setattr("scripts.crawl_cycle.validate_session_export", validate)
    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    assert run_cycle(args)["status"] == "succeeded"
    assert initial_logins == 1
    assert validations == 1


def test_cycle_bounds_hung_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    args = _args(tmp_path)
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        timeout = kwargs["timeout"]
        assert isinstance(timeout, int | float)
        raise subprocess.TimeoutExpired(command, timeout)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "partial"
    assert report["stop_reason"] == "worker_timeout"
    assert report["boards"][0]["failures"] == ["runner_timeout"]


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
    assert calls == (3 if isinstance(error, SessionNetworkError) else 1)


def test_cycle_preserves_network_classification_when_login_retry_is_throttled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    errors = iter(
        [
            SessionNetworkError("login request offline"),
            AutomaticLoginThrottleError("retry interval"),
        ]
    )
    monkeypatch.setattr(
        "scripts.crawl_cycle.ensure_session_export",
        lambda *args, **kwargs: (_ for _ in ()).throw(next(errors)),
    )
    monkeypatch.setattr("scripts.crawl_cycle.time.sleep", lambda seconds: None)
    monkeypatch.setattr(
        "scripts.crawl_cycle.subprocess.run",
        lambda *args, **kwargs: pytest.fail("worker must not run"),
    )

    report = run_cycle(args)

    assert report["status"] == "site_unreachable"


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


def test_inventory_cycle_does_not_trip_outage_when_boards_advance_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Production full-catalog often crawls tens of pages then times out on a later one.

    That must stay partial so the next boards still run, not site_unreachable after three
    progress-making boards.
    """
    args = _args(tmp_path)
    args.inventory = True
    commands: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)

    def run(command: list[str], **kwargs: object) -> SimpleNamespace:
        commands.append(command)
        index = len(commands)
        _output_path(command).write_text(
            json.dumps(
                {
                    "ok": False,
                    "status": "partial",
                    "run_id": f"run-{index}",
                    "scheduled_posts": 0,
                    "failures": ["listing_fetch_failed", "network_error"],
                    "inventory_start_page": index,
                    "inventory_next_page": index + 5,
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "partial"
    assert len(commands) == 4
    assert report["completed_boards"] == 4


def test_inventory_cycle_still_trips_outage_on_zero_progress_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _args(tmp_path)
    args.inventory = True
    commands: list[list[str]] = []
    monkeypatch.setattr("scripts.crawl_cycle.ensure_session_export", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "scripts.crawl_cycle.FrontierStore.preserve_network_attempts",
        lambda self, run_ids: len(run_ids),
    )

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
                    "inventory_start_page": 4,
                    "inventory_next_page": 4,
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(returncode=2)

    monkeypatch.setattr("scripts.crawl_cycle.subprocess.run", run)

    report = run_cycle(args)

    assert report["status"] == "site_unreachable"
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
