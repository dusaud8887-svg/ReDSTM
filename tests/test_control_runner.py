from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO, cast
from uuid import uuid4

import pytest

from crawler.archive import connect_archive, initialize_archive
from crawler.settings import REDSTM_FULL_CONTENT_MAX_POSTS, REDSTM_RECOVERY_MAX_POSTS
from scripts.control_client import ControlClient
from scripts.control_runner import (
    ControlRunner,
    RunnerProfile,
    _installed_next_scheduled_at,
    _next_scheduled_at,
    _parse_args,
)
from scripts.control_store import ControlStore


@pytest.fixture(autouse=True)
def _disable_systemd_timer_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ControlRunner, "_schedule_timer_active", staticmethod(lambda: False))


class Api:
    def __init__(self, commands: list[dict[str, Any] | None]) -> None:
        self.commands = commands
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(
        self, path: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        payload = json.loads(body)
        self.calls.append((path, payload))
        data = (
            {"command": self.commands.pop(0) if self.commands else None}
            if path.endswith("/commands/claim")
            else {"accepted": True}
        )
        response = {
            "api_version": 1,
            "request_id": headers["X-Request-Id"],
            "server_time": "2026-07-12T00:00:00.000Z",
            "data": data,
        }
        return 200, {}, json.dumps(response).encode()


def _profile(tmp_path: Path) -> RunnerProfile:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa', 'AA', 'https://source.invalid/aa', 'now', 'now')
            """
        )
    return RunnerProfile(
        state_db=tmp_path / "state" / "control.sqlite",
        state_dir=tmp_path / "state",
        archive=archive,
        session=tmp_path / "private" / "session.json",
        warc_dir=tmp_path / "warc",
        report_dir=tmp_path / "reports",
        static_root=tmp_path / "static",
        remote="r2:redstm-archive",
        runner_id="oracle-primary",
        runner_version="git-test",
    )


def _runner(tmp_path: Path, api: Api) -> tuple[ControlRunner, ControlStore]:
    profile = _profile(tmp_path)
    store = ControlStore(profile.state_db)
    client = ControlClient(
        "https://archive.example", "client-id", "client-secret", sender=api, sleep=lambda _: None
    )
    return ControlRunner(profile, client, store), store


def _static_release(root: Path, marker: str) -> str:
    body = (json.dumps({"schema_version": 1, "marker": marker}, sort_keys=True) + "\n").encode()
    release_key = f"releases/{hashlib.sha256(body).hexdigest()}.json"
    target = root / release_key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    return release_key


def _write_smoke_marker(
    profile: RunnerProfile,
    release_key: str,
    previous_release_key: str | None,
) -> Path:
    marker = profile.static_root / ".publish-smoke.pending.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": profile.remote,
                "release_key": release_key,
                "previous_release_key": previous_release_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    return marker


def _command(action: str) -> dict[str, Any]:
    return {
        "command_id": str(uuid4()),
        "action": action,
        "state": "claimed",
        "requested_at": "2026-07-12T00:00:00.000Z",
        "expires_at": "2026-07-12T00:15:00.000Z",
    }


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 7, 12, 0, 16, tzinfo=UTC), "2026-07-12T00:17:00Z"),
        (datetime(2026, 7, 12, 0, 17, tzinfo=UTC), "2026-07-12T06:17:00Z"),
        (datetime(2026, 7, 12, 23, 0, tzinfo=UTC), "2026-07-13T00:17:00Z"),
    ],
)
def test_next_schedule_uses_the_systemd_base_slots(now: datetime, expected: str) -> None:
    assert _next_scheduled_at("*-*-* 00,06,12,18:17:00 UTC", now) == expected


def test_installed_schedule_rejects_unsupported_systemd_calendar_syntax(tmp_path: Path) -> None:
    timer = tmp_path / "redstm-schedule.timer"
    timer.write_text(
        "[Timer]\nOnCalendar=*-*-* 00,06,12,18:17:00 UTC\n",
        encoding="utf-8",
    )
    assert (
        _installed_next_scheduled_at(timer, datetime(2026, 7, 12, 0, 17, tzinfo=UTC))
        == "2026-07-12T06:17:00Z"
    )

    timer.write_text("[Timer]\nOnCalendar=*-*-* 00/6:17:00 UTC\n", encoding="utf-8")

    assert _installed_next_scheduled_at(timer) is None


def test_heartbeat_only_reports_a_next_run_for_an_active_timer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([None])
    runner, _store = _runner(tmp_path, api)
    monkeypatch.setattr(runner, "_schedule_timer_active", lambda: True)
    monkeypatch.setattr(runner, "_next_scheduled_at", lambda: "2026-07-12T06:17:00Z")

    assert runner.run_once()["status"] == "idle"

    heartbeat = next(payload for path, payload in api.calls if path.endswith("/heartbeat"))
    assert heartbeat["next_scheduled_at"] is not None


def test_active_timer_with_an_unreadable_calendar_is_degraded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([None])
    runner, _store = _runner(tmp_path, api)
    monkeypatch.setattr(runner, "_schedule_timer_active", lambda: True)
    monkeypatch.setattr(runner, "_next_scheduled_at", lambda: None)

    runner.run_once()

    heartbeat = next(payload for path, payload in api.calls if path.endswith("/heartbeat"))
    assert heartbeat["state"] == "degraded"
    assert heartbeat["next_scheduled_at"] is None


def test_heartbeat_warning_producers_use_configured_thresholds(tmp_path: Path) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    now = datetime(2026, 7, 12, tzinfo=UTC)

    runner.profile = replace(runner.profile, disk_low_bytes=100)
    assert runner._safe_warning(99, now) == "disk_low"

    runner.profile = replace(
        runner.profile,
        disk_low_bytes=0,
        token_expires_at=now + timedelta(hours=1),
        token_expiring_seconds=2 * 60 * 60,
    )
    assert runner._safe_warning(99, now) == "token_expiring"

    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    os.utime(marker, (now.timestamp() - 7200, now.timestamp() - 7200))
    runner.profile = replace(
        runner.profile,
        token_expires_at=None,
        publish_stale_seconds=60 * 60,
    )
    assert runner._safe_warning(99, now) == "publish_stale"

    marker.unlink()
    smoke_marker = runner.profile.static_root / ".publish-smoke.pending.json"
    smoke_marker.parent.mkdir(parents=True, exist_ok=True)
    smoke_marker.touch()
    os.utime(smoke_marker, (now.timestamp() - 7200, now.timestamp() - 7200))
    assert runner._safe_warning(99, now) == "publish_stale"


def test_recent_permanent_control_rejection_becomes_a_generic_warning(tmp_path: Path) -> None:
    runner, store = _runner(tmp_path, Api([]))
    now = datetime(2026, 7, 12, tzinfo=UTC)
    runner.profile = replace(
        runner.profile,
        disk_low_bytes=0,
        control_rejection_warning_seconds=24 * 60 * 60,
        token_expires_at=None,
        publish_stale_seconds=0,
    )
    store.record_rejection("invalid_payload", now=now - timedelta(hours=1))

    assert runner._safe_warning(0, now) == "control_rejected"
    assert runner._safe_warning(0, now + timedelta(hours=25)) is None
    assert runner._safe_warning(0, now - timedelta(hours=2)) is None


def test_warning_thresholds_load_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REDSTM_DISK_LOW_BYTES", "123")
    monkeypatch.setenv("REDSTM_CONTROL_REJECTION_WARNING_SECONDS", "234")
    monkeypatch.setenv("REDSTM_ACCESS_TOKEN_EXPIRES_AT", "2026-07-13T00:00:00Z")
    monkeypatch.setenv("REDSTM_TOKEN_EXPIRING_SECONDS", "456")
    monkeypatch.setenv("REDSTM_PUBLISH_STALE_SECONDS", "789")
    monkeypatch.setattr("sys.argv", ["control-runner"])

    args = _parse_args()

    assert args.disk_low_bytes == 123
    assert args.control_rejection_warning_seconds == 234
    assert args.token_expires_at == datetime(2026, 7, 13, tzinfo=UTC)
    assert args.token_expiring_seconds == 456
    assert args.publish_stale_seconds == 789


def test_new_changes_preserve_the_oldest_pending_publish_age(tmp_path: Path) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.write_text("changed_at=2026-07-11T00:00:00Z\n", encoding="utf-8")
    os.utime(marker, (1_000_000_000, 1_000_000_000))
    before = marker.stat().st_mtime_ns

    runner._write_publish_marker()

    assert marker.read_text(encoding="utf-8") == "changed_at=2026-07-11T00:00:00Z\n"
    assert marker.stat().st_mtime_ns == before


def test_board_status_normalizes_sqlite_inventory_timestamp(tmp_path: Path) -> None:
    api = Api([])
    runner, _store = _runner(tmp_path, api)
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-12 01:02:03' WHERE board_id = 'aa'"
        )

    runner._board_summaries({"boards": [{"board_id": "aa", "status": "succeeded"}]})

    board = next(payload for path, payload in api.calls if path.endswith("/boards/status"))
    assert board["last_inventory_at"] == "2026-07-12T01:02:03Z"


def test_inventory_completion_requires_every_board_after_the_pass_epoch(tmp_path: Path) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    started_at = "2026-07-12T00:00:00Z"
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('second', 'Second', 'https://source.invalid/second', 'now', 'now')
            """
        )
        connection.execute(
            "UPDATE boards SET last_inventory_at = ? WHERE board_id = 'aa'",
            (started_at,),
        )
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-11T00:00:00Z' WHERE board_id = 'second'"
        )

    assert runner._inventory_pass_complete(started_at) is False
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET last_inventory_at = ? WHERE board_id = 'second'",
            (started_at,),
        )
    assert runner._inventory_pass_complete(started_at) is True


def test_legacy_empty_inventory_marker_does_not_suppress_a_new_pass(tmp_path: Path) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-12T00:00:00Z' WHERE board_id = 'aa'"
        )
    (runner.profile.state_dir / "inventory.completed").touch()

    assert runner._inventory_due() is True


def test_pause_marker_is_idempotent_and_reported(tmp_path: Path) -> None:
    command = _command("pause-after-current")
    api = Api([command])
    runner, store = _runner(tmp_path, api)

    report = runner.run_once()

    assert report["status"] == "succeeded"
    assert (runner.profile.state_dir / "schedule.paused").is_file()
    row = store.command(command["command_id"])
    assert row is not None and row["reported_at"] is not None
    finish = next(payload for path, payload in api.calls if path.endswith("/finish"))
    assert finish["safe_summary_code"] == "schedule_paused"


def test_idle_heartbeat_preserves_paused_state(tmp_path: Path) -> None:
    api = Api([None])
    runner, _store = _runner(tmp_path, api)
    (runner.profile.state_dir / "schedule.paused").touch()

    assert runner.run_once()["status"] == "idle"

    heartbeat = next(payload for path, payload in api.calls if path.endswith("/heartbeat"))
    assert heartbeat["state"] == "paused"


def test_scheduled_claims_remote_pause_before_starting_a_run(tmp_path: Path) -> None:
    api = Api([_command("pause-after-current")])
    runner, _store = _runner(tmp_path, api)

    report = runner.run_scheduled()

    assert report["status"] == "paused"
    assert not any(path == "/api/v1/runner/runs" for path, _payload in api.calls)
    assert (runner.profile.state_dir / "schedule.paused").is_file()


def test_sync_command_emits_bounded_run_and_board_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    command = _command("sync-now")
    api = Api([command, None])
    runner, store = _runner(tmp_path, api)
    processes = 0

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            nonlocal processes
            processes += 1
            output = Path(arguments[arguments.index("--output") + 1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "status": "succeeded",
                        "changed_posts": 2,
                        "failed_posts": 0,
                        "boards_ok": 1,
                        "boards_failed": 0,
                        "boards": [
                            {
                                "board_id": "aa",
                                "status": "succeeded",
                                "scheduled_posts": 2,
                                "outcomes": {"stored": 2},
                                "failures": [],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

        def wait(self, timeout: int) -> int:
            assert timeout == 30
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    report = runner.run_once()

    assert report["status"] == "succeeded"
    assert processes == 1
    assert (runner.profile.state_dir / "publish.pending").is_file()
    finish = next(
        payload for path, payload in api.calls if path.endswith("/finish") and "/runs/" in path
    )
    assert finish["counters"] == {
        "changed_posts": 2,
        "failed_posts": 0,
        "boards_ok": 1,
        "boards_failed": 0,
    }
    assert finish["safe_summary_code"] == "cycle_succeeded"
    board = next(payload for path, payload in api.calls if path.endswith("/boards/status"))
    assert board["board_id"] == "aa"
    assert board["board_name"] == "AA"
    assert board["counters"]["running"] == 0
    assert board["counters"]["done"] == 0
    assert board["inventory_next_page"] == 1
    assert "canonical_url" not in board
    snapshot = next(
        payload
        for path, payload in api.calls
        if path.endswith("/events:batch") and payload["events"][0]["step"] == "archive_snapshot"
    )
    assert snapshot["events"][0]["counters"]["inventory_total_boards"] == 1
    row = store.command(command["command_id"])
    assert row is not None and row["reported_at"] is not None

    assert runner.run_once()["status"] == "idle"
    assert processes == 1


def test_interrupted_local_run_replays_failure_without_reexecution(tmp_path: Path) -> None:
    command = _command("sync-now")
    api = Api([])
    runner, store = _runner(tmp_path, api)
    store.record_claim(command["command_id"], command["action"])
    store.begin_command(command["command_id"], run_id=f"command-{command['command_id']}")

    report = runner.run_once()

    assert report["status"] == "replayed"
    finish = next(payload for path, payload in api.calls if path.endswith("/finish"))
    assert finish["state"] == "failed"
    assert finish["safe_summary_code"] == "runner_interrupted"
    row = store.command(command["command_id"])
    assert row is not None and row["reported_at"] is not None


def test_permanent_terminal_rejection_does_not_block_the_next_local_command(
    tmp_path: Path,
) -> None:
    profile = _profile(tmp_path)
    store = ControlStore(profile.state_db)
    first = _command("pause-after-current")
    second = _command("resume-schedule")
    for offset, command in enumerate((first, second)):
        store.record_claim(
            command["command_id"],
            command["action"],
            now=datetime(2026, 7, 12, 0, offset, tzinfo=UTC),
        )
        store.finish_command(
            command["command_id"],
            "succeeded",
            "schedule_paused" if offset == 0 else "schedule_resumed",
        )

    def sender(
        path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        if first["command_id"] in path:
            payload = {
                "api_version": 1,
                "request_id": headers["X-Request-Id"],
                "server_time": "2026-07-12T00:00:00.000Z",
                "error": {"code": "command_not_found", "message": "rejected"},
            }
            return 404, {}, json.dumps(payload).encode()
        payload = {
            "api_version": 1,
            "request_id": headers["X-Request-Id"],
            "server_time": "2026-07-12T00:00:00.000Z",
            "data": {"accepted": True},
        }
        return 200, {}, json.dumps(payload).encode()

    runner = ControlRunner(
        profile,
        ControlClient("https://archive.example", "client-id", "client-secret", sender=sender),
        store,
    )

    assert runner.run_once()["command_id"] == first["command_id"]
    first_row = store.command(first["command_id"])
    assert first_row is not None
    assert first_row["report_state"] == "permanently_rejected"
    assert json.loads(first_row["result_json"])["code"] == "schedule_paused"
    assert runner.run_once()["command_id"] == second["command_id"]
    second_row = store.command(second["command_id"])
    assert second_row is not None and second_row["report_state"] == "delivered"
    assert store.pending_commands() == []
    rejection = store.rejection()
    assert rejection is not None and rejection["last_code"] == "command_not_found"


def test_publish_without_marker_always_reconciles_and_smokes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    command = _command("publish-if-changed")
    api = Api([command])
    runner, store = _runner(tmp_path, api)
    commands: list[list[str]] = []

    def wait(command_line: list[str], *_args: object, **kwargs: object) -> int:
        commands.append(command_line)
        module = command_line[command_line.index("-m") + 1]
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": f"releases/{'a' * 64}.json",
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner.run_once()

    assert report["status"] == "succeeded"
    assert [command_line[command_line.index("-m") + 1] for command_line in commands] == [
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]
    assert "--incremental-only" in commands[0]
    assert "--verified-incremental" in commands[1]
    row = store.command(command["command_id"])
    assert row is not None
    assert json.loads(row["result_json"])["code"] == "publish_succeeded"
    assert not (runner.profile.state_dir / "publish.pending").exists()


def test_publish_smoke_success_closes_the_durable_activation_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    current = _static_release(runner.profile.static_root, "current")
    smoke_marker = _write_smoke_marker(runner.profile, current, None)
    publish_calls = 0

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        nonlocal publish_calls
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static":
            publish_calls += 1
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": current,
                        "activation_pending_smoke": publish_calls == 1,
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report["ok"] is True
    assert report["status"] == "succeeded"
    assert report["release_smoke_verified"] is True
    assert report["preexisting_activation_reconciled"] is True
    assert not smoke_marker.exists()


def test_pending_smoke_is_reconciled_before_a_failing_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    publish_marker = runner.profile.state_dir / "publish.pending"
    publish_marker.touch()
    current = _static_release(runner.profile.static_root, "current")
    smoke_marker = _write_smoke_marker(runner.profile, current, None)
    commands: list[str] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        module = command[command.index("-m") + 1]
        commands.append(module)
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "pending_smoke": True,
                        "mode": "noop",
                        "release_key": current,
                        "smoke_marker_release_key": current,
                        "activation_pending_smoke": True,
                        "rollback_already_active": False,
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 1 if module == "scripts.export_static" else 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report["safe_code"] == "export_failed"
    assert commands == [
        "scripts.publish_static",
        "scripts.release_smoke",
        "scripts.export_static",
    ]
    assert not smoke_marker.exists()
    assert publish_marker.is_file()


def test_publish_reconciles_an_unverified_active_release_before_the_new_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    publish_marker = runner.profile.state_dir / "publish.pending"
    publish_marker.touch()
    active = _static_release(runner.profile.static_root, "active")
    desired = _static_release(runner.profile.static_root, "desired")
    smoke_marker = _write_smoke_marker(runner.profile, active, None)
    commands: list[str] = []
    publish_calls = 0

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        nonlocal publish_calls
        module = command[command.index("-m") + 1]
        commands.append(module)
        if module == "scripts.publish_static":
            publish_calls += 1
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            if publish_calls == 1:
                report = {
                    "ok": True,
                    "mode": "noop",
                    "release_key": active,
                    "activation_pending_smoke": True,
                    "previous_release_key": None,
                    "previous_release_verified": False,
                }
            else:
                _write_smoke_marker(runner.profile, desired, active)
                report = {
                    "ok": True,
                    "mode": "delta",
                    "release_key": desired,
                    "activation_pending_smoke": True,
                    "previous_release_key": active,
                    "previous_release_verified": True,
                }
            output.write_text(json.dumps(report), encoding="utf-8")
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report["ok"] is True
    assert report["release_key"] == desired
    assert report["preexisting_activation_reconciled"] is True
    assert commands == [
        "scripts.publish_static",
        "scripts.release_smoke",
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]
    assert not smoke_marker.exists()
    assert not publish_marker.exists()


def test_publish_smoke_confirmation_failure_is_terminal_and_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    publish_marker = runner.profile.state_dir / "publish.pending"
    publish_marker.touch()
    current = _static_release(runner.profile.static_root, "current")

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": current,
                        "activation_pending_smoke": True,
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report == {
        "ok": False,
        "status": "failed",
        "safe_code": "publish_smoke_confirmation_failed",
        "attempted_release_key": current,
        "release_smoke_verified": True,
    }
    assert publish_marker.is_file()


def test_manual_terminal_replay_without_marker_does_not_hide_a_later_publish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, store = _runner(tmp_path, Api([]))
    command = _command("sync-now")
    store.record_claim(command["command_id"], command["action"])
    store.finish_command(
        command["command_id"],
        "succeeded",
        "cycle_succeeded",
        result_payload=runner._finish_payload(
            "succeeded",
            "cycle_succeeded",
            {"changed_posts": 1, "failed_posts": 0, "boards_ok": 1, "boards_failed": 0},
        ),
    )
    assert runner.run_once()["status"] == "replayed"
    assert not (runner.profile.state_dir / "publish.pending").exists()
    commands: list[str] = []

    def wait(command_line: list[str], *_args: object, **kwargs: object) -> int:
        module = command_line[command_line.index("-m") + 1]
        commands.append(module)
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "delta",
                        "release_key": f"releases/{'a' * 64}.json",
                        "previous_release_key": f"releases/{'b' * 64}.json",
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report["ok"] is True
    assert commands == ["scripts.export_static", "scripts.publish_static", "scripts.release_smoke"]


def test_publish_retries_on_the_next_cycle_even_with_a_legacy_completion_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    (runner.profile.state_dir / "publish.pending").touch()
    (runner.profile.state_dir / "publish.completed").touch()
    commands: list[list[str]] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        commands.append(command)
        output = kwargs.get("stdout")
        if isinstance(output, Path):
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "status": "succeeded",
                        "release_key": f"releases/{'a' * 64}.json",
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report["status"] == "succeeded"
    assert [command[command.index("-m") + 1] for command in commands] == [
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]
    assert "--incremental-only" in commands[0]
    assert "--verified-incremental" in commands[1]
    assert not (runner.profile.state_dir / "publish.pending").exists()


def test_publish_smoke_failure_rolls_back_and_verifies_the_previous_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    current = f"releases/{'a' * 64}.json"
    previous = f"releases/{'b' * 64}.json"
    commands: list[list[str]] = []
    smoke_calls = 0

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        nonlocal smoke_calls
        commands.append(command)
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static" and "--activate" not in command:
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "delta",
                        "release_key": current,
                        "previous_release_key": previous,
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        if module == "scripts.release_smoke":
            smoke_calls += 1
            return 1 if smoke_calls == 1 else 0
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report == {
        "ok": False,
        "status": "failed",
        "safe_code": "publish_smoke_failed_rolled_back",
        "attempted_release_key": current,
        "previous_release_key": previous,
        "rollback_pointer_verified": True,
        "rollback_smoke_verified": True,
    }
    assert marker.is_file()
    assert [command[command.index("-m") + 1] for command in commands] == [
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]
    rollback = commands[3]
    assert rollback[rollback.index("--activate") + 1] == previous
    assert commands[4][-1] == "b" * 64


@pytest.mark.parametrize(
    ("failure", "safe_code", "pointer_verified", "command_count"),
    [
        ("activate", "publish_rollback_failed", False, 4),
        ("smoke", "publish_rollback_smoke_failed", True, 5),
    ],
)
def test_publish_rollback_failure_is_terminal_and_keeps_the_marker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    safe_code: str,
    pointer_verified: bool,
    command_count: int,
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    current = f"releases/{'a' * 64}.json"
    previous = f"releases/{'b' * 64}.json"
    commands: list[list[str]] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        commands.append(command)
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static" and "--activate" not in command:
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "delta",
                        "release_key": current,
                        "previous_release_key": previous,
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        if module == "scripts.release_smoke":
            return 1
        if "--activate" in command:
            return 1 if failure == "activate" else 0
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report["safe_code"] == safe_code
    assert report["rollback_pointer_verified"] is pointer_verified
    assert report["rollback_smoke_verified"] is False
    assert report["ok"] is False
    assert marker.is_file()
    assert len(commands) == command_count


def test_publish_smoke_failure_without_a_previous_release_never_claims_rollback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    current = f"releases/{'a' * 64}.json"
    commands: list[list[str]] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        commands.append(command)
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "delta",
                        "release_key": current,
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 1 if module == "scripts.release_smoke" else 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report["safe_code"] == "publish_rollback_unavailable"
    assert report["previous_release_key"] is None
    assert report["rollback_pointer_verified"] is False
    assert report["rollback_smoke_verified"] is False
    assert marker.is_file()
    assert len(commands) == 3


def test_publish_noop_smoke_failure_never_rolls_back_an_unchanged_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    current = f"releases/{'a' * 64}.json"
    previous = f"releases/{'b' * 64}.json"
    commands: list[list[str]] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        commands.append(command)
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": current,
                        "previous_release_key": previous,
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        return 1 if module == "scripts.release_smoke" else 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report["safe_code"] == "publish_smoke_failed"
    assert report["previous_release_key"] is None
    assert report["rollback_pointer_verified"] is False
    assert marker.is_file()
    assert [command[command.index("-m") + 1] for command in commands] == [
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]


def test_publish_noop_after_interrupted_activation_rolls_back_on_smoke_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    marker = runner.profile.state_dir / "publish.pending"
    marker.touch()
    current = _static_release(runner.profile.static_root, "current")
    previous = _static_release(runner.profile.static_root, "previous")
    smoke_marker = _write_smoke_marker(runner.profile, current, previous)
    commands: list[list[str]] = []
    smoke_calls = 0

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        nonlocal smoke_calls
        commands.append(command)
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static" and "--activate" not in command:
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": current,
                        "activation_pending_smoke": True,
                        "ledger_recovered": False,
                        "previous_release_key": previous,
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        if module == "scripts.release_smoke":
            smoke_calls += 1
            return 1 if smoke_calls == 1 else 0
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action(
        "publish-if-changed", "publish", "publish", command_id="command-publish"
    )

    assert report["safe_code"] == "publish_smoke_failed_rolled_back"
    assert report["rollback_pointer_verified"] is True
    assert report["rollback_smoke_verified"] is True
    assert marker.is_file()
    assert not smoke_marker.exists()
    rollback = commands[2]
    assert rollback[rollback.index("--activate") + 1] == previous


def test_publish_recovery_finishes_an_interrupted_rollback_before_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    publish_marker = runner.profile.state_dir / "publish.pending"
    publish_marker.touch()
    attempted = _static_release(runner.profile.static_root, "attempted")
    previous = _static_release(runner.profile.static_root, "previous")
    smoke_marker = _write_smoke_marker(runner.profile, attempted, previous)
    commands: list[str] = []

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        module = command[command.index("-m") + 1]
        commands.append(module)
        if module == "scripts.publish_static":
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "pending_smoke": True,
                        "mode": "noop",
                        "release_key": previous,
                        "smoke_marker_release_key": attempted,
                        "activation_pending_smoke": True,
                        "rollback_already_active": True,
                        "previous_release_key": None,
                        "previous_release_verified": False,
                    }
                ),
                encoding="utf-8",
            )
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report == {
        "ok": False,
        "status": "failed",
        "safe_code": "publish_smoke_failed_rolled_back",
        "attempted_release_key": attempted,
        "previous_release_key": previous,
        "rollback_pointer_verified": True,
        "rollback_smoke_verified": True,
    }
    assert commands == ["scripts.publish_static", "scripts.release_smoke"]
    assert not smoke_marker.exists()
    assert publish_marker.is_file()


def test_publish_rollback_confirmation_failure_keeps_the_publish_retry_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    publish_marker = runner.profile.state_dir / "publish.pending"
    publish_marker.touch()
    current = _static_release(runner.profile.static_root, "current")
    previous = _static_release(runner.profile.static_root, "previous")
    smoke_marker = _write_smoke_marker(runner.profile, current, previous)
    smoke_calls = 0

    def wait(command: list[str], *_args: object, **kwargs: object) -> int:
        nonlocal smoke_calls
        module = command[command.index("-m") + 1]
        if module == "scripts.publish_static" and "--activate" not in command:
            output = kwargs["stdout"]
            assert isinstance(output, Path)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "mode": "noop",
                        "release_key": current,
                        "activation_pending_smoke": True,
                        "previous_release_key": previous,
                        "previous_release_verified": True,
                    }
                ),
                encoding="utf-8",
            )
        if module == "scripts.release_smoke":
            smoke_calls += 1
            if smoke_calls == 1:
                return 1
            smoke_marker.unlink()
        return 0

    monkeypatch.setattr(runner, "_wait", wait)

    report = runner._execute_action("publish-if-changed", "publish", "publish")

    assert report["safe_code"] == "publish_rollback_confirmation_failed"
    assert report["rollback_pointer_verified"] is True
    assert report["rollback_smoke_verified"] is True
    assert publish_marker.is_file()


def test_retry_batch_runs_each_cycle_even_with_a_legacy_completion_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    (runner.profile.state_dir / "recovery.completed").touch()
    commands: list[list[str]] = []

    def execute(command: list[str], *_args: object, **_kwargs: object) -> dict[str, Any]:
        commands.append(command)
        return {"ok": True, "status": "succeeded"}

    monkeypatch.setattr(runner, "_execute_report", execute)

    report = runner._execute_action("retry-batch", "scheduled", "scheduled")

    assert report["status"] == "succeeded"
    assert commands[0][commands[0].index("--max-posts") + 1] == str(REDSTM_RECOVERY_MAX_POSTS)


def test_full_content_refetches_every_post_for_one_board(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    commands: list[list[str]] = []

    def execute(command: list[str], *_args: object, **_kwargs: object) -> dict[str, Any]:
        commands.append(command)
        return {"ok": True, "status": "succeeded", "full_content_remaining": 0}

    monkeypatch.setattr(runner, "_execute_report", execute)

    report = runner._execute_action(
        "full-content", "full-aa", "full-aa", command_id="manual", board_id="aa"
    )

    assert report["status"] == "succeeded"
    command = commands[0]
    assert "--all" not in command
    assert "--full-content-before" in command
    assert command[command.index("--full-content-max-rowid") + 1] == "0"
    assert command[command.index("--board") + 1] == "aa"
    assert command[command.index("--max-posts") + 1] == str(REDSTM_FULL_CONTENT_MAX_POSTS)
    assert "--pause-file" not in command


def test_full_content_checkpoint_survives_a_partial_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            """
            INSERT INTO crawl_frontier (board_id, external_post_id, url)
            VALUES ('aa', 1, 'https://source.invalid/aa/1')
            """
        )
    commands: list[list[str]] = []
    reports = iter(
        [
            {"ok": True, "status": "succeeded", "full_content_remaining": 1},
            {"ok": True, "status": "succeeded", "full_content_remaining": 0},
        ]
    )

    def execute(command: list[str], *_args: object, **_kwargs: object) -> dict[str, Any]:
        commands.append(command)
        return next(reports)

    monkeypatch.setattr(runner, "_execute_report", execute)

    result = runner._execute_action(
        "full-content", "full-1", "full-1", command_id="manual", board_id="aa"
    )

    assert result["status"] == "succeeded"
    assert result["full_content_complete"] is True
    assert not (runner.profile.state_dir / "full-content.started").exists()
    for argument in ("--full-content-before", "--full-content-max-rowid"):
        assert (
            commands[0][commands[0].index(argument) + 1]
            == commands[1][commands[1].index(argument) + 1]
        )


def test_scheduled_run_requires_explicit_export_bootstrap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([])
    runner, _store = _runner(tmp_path, api)
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-11T00:00:00Z' WHERE board_id = 'aa'"
        )
    runner._complete_inventory_pass("2026-07-11T00:00:00Z")
    commands: list[list[str]] = []

    class Process:
        def __init__(self, arguments: list[str], **kwargs: object) -> None:
            commands.append(arguments)
            module = arguments[arguments.index("-m") + 1]
            self.return_code = 0
            if module in {"scripts.crawl_cycle", "scripts.recover_queue"}:
                output = Path(arguments[arguments.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    json.dumps(
                        {
                            "ok": True,
                            "status": "succeeded",
                            "changed_posts": 1 if module == "scripts.crawl_cycle" else 0,
                            "failed_posts": 0,
                            "boards_ok": 1 if module == "scripts.crawl_cycle" else 0,
                            "boards_failed": 0,
                            "boards": [],
                        }
                    ),
                    encoding="utf-8",
                )
            elif module == "scripts.export_static":
                stream = cast(BinaryIO, kwargs["stdout"])
                stream.write(
                    json.dumps(
                        {
                            "ok": False,
                            "status": "partial",
                            "safe_code": "incremental_bootstrap_required",
                        }
                    ).encode()
                )
                stream.flush()
                self.return_code = 2

        def wait(self, timeout: int) -> int:
            assert timeout == 30
            return self.return_code

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    report = runner.run_scheduled()

    assert report["status"] == "partial"
    assert len(commands) == 2
    start = next(payload for path, payload in api.calls if path == "/api/v1/runner/runs")
    assert start["kind"] == "scheduled" and start["source"] == "systemd"
    assert "command_id" not in start
    finish = next(payload for path, payload in api.calls if path.endswith("/finish"))
    assert "release_id" not in finish
    assert finish["safe_summary_code"] == "incremental_bootstrap_required"
    assert finish["counters"]["changed_posts"] == 1
    assert (runner.profile.state_dir / "publish.pending").is_file()


def test_scheduled_run_preserves_the_first_actionable_failure_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([])
    runner, _store = _runner(tmp_path, api)
    reports = iter(
        [
            {
                "ok": False,
                "status": "partial",
                "boards": [
                    {
                        "board_id": "aa",
                        "status": "partial",
                        "failures": ["listing_parse_failed"],
                    }
                ],
            },
            {"ok": True, "status": "succeeded"},
            {"ok": True, "status": "succeeded", "safe_code": "publish_no_change"},
        ]
    )
    monkeypatch.setattr(runner, "_inventory_due", lambda: False)
    monkeypatch.setattr(runner, "_bootstrap_pending", lambda: False)
    monkeypatch.setattr(runner, "_execute_action", lambda *_args, **_kwargs: next(reports))

    report = runner.run_scheduled()

    assert report["status"] == "partial"
    finish = next(payload for path, payload in api.calls if path.endswith("/finish"))
    assert finish["safe_summary_code"] == "parse_drift"
    sync_event = next(
        payload["events"][0]
        for path, payload in api.calls
        if path.endswith("/events:batch") and payload["events"][0]["step"] == "sync-now"
    )
    assert sync_event["safe_message"] == "parse_drift"


def test_scheduled_run_skips_follow_up_after_runner_failed_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([])
    runner, _store = _runner(tmp_path, api)
    actions: list[str] = []
    monkeypatch.setattr(runner, "_inventory_due", lambda: False)
    monkeypatch.setattr(runner, "_bootstrap_pending", lambda: False)

    def execute(action: str, *_args: object) -> dict[str, Any]:
        actions.append(action)
        if action == "sync-now":
            return {"ok": False, "status": "runner_failed"}
        return {"ok": True, "status": "succeeded", "safe_code": "publish_no_change"}

    monkeypatch.setattr(runner, "_execute_action", execute)

    report = runner.run_scheduled()

    assert report["status"] == "failed"
    assert actions == ["sync-now", "publish-if-changed"]
    assert not any(
        payload["events"][0]["state"] == "skipped"
        for path, payload in api.calls
        if path.endswith("/events:batch")
    )


def test_scheduled_run_only_collects_latest_and_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    commands: list[list[str]] = []

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            commands.append(arguments)
            module = arguments[arguments.index("-m") + 1]
            if module == "scripts.crawl_cycle":
                output = Path(arguments[arguments.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    json.dumps(
                        {
                            "ok": True,
                            "status": "succeeded",
                            "changed_posts": 0,
                            "failed_posts": 0,
                            "boards_ok": 1,
                            "boards_failed": 0,
                            "boards": [{"board_id": "aa", "status": "succeeded"}],
                        }
                    ),
                    encoding="utf-8",
                )
                if "--inventory" in arguments:
                    started_at = arguments[arguments.index("--inventory-since") + 1]
                    with connect_archive(runner.profile.archive) as connection:
                        connection.execute(
                            """
                            UPDATE boards SET inventory_next_page = 1,
                                last_inventory_at = ?
                            WHERE board_id = 'aa'
                            """,
                            (started_at,),
                        )
            elif module == "scripts.publish_static":
                stream = cast(BinaryIO, _kwargs["stdout"])
                stream.write(
                    json.dumps(
                        {
                            "ok": True,
                            "mode": "noop",
                            "release_key": f"releases/{'a' * 64}.json",
                            "previous_release_key": None,
                            "previous_release_verified": False,
                        }
                    ).encode()
                )
                stream.flush()

        def wait(self, timeout: int) -> int:
            assert timeout == 30
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    assert runner.run_scheduled()["status"] == "succeeded"
    assert [command[command.index("-m") + 1] for command in commands] == [
        "scripts.crawl_cycle",
        "scripts.export_static",
        "scripts.publish_static",
        "scripts.release_smoke",
    ]
    assert "--inventory" not in commands[0]
    assert all("scripts.recover_queue" not in command for command in commands)


def test_partial_inventory_keeps_running_until_every_board_cursor_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    report = {
        "ok": False,
        "status": "partial",
        "stop_reason": "time_budget",
        "boards": [{"board_id": "aa"}],
    }
    calls = 0

    def execute(*_args: object, **_kwargs: object) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return report
        started_at = runner._latest_inventory_pass_started_at()
        assert started_at is not None
        with connect_archive(runner.profile.archive) as connection:
            connection.execute(
                "UPDATE boards SET inventory_next_page = 1, last_inventory_at = ?",
                (started_at,),
            )
        return {"ok": True, "status": "succeeded", "boards": []}

    monkeypatch.setattr(runner, "_execute_report", execute)
    with connect_archive(runner.profile.archive) as connection:
        connection.execute("UPDATE boards SET inventory_next_page = 4 WHERE board_id = 'aa'")

    runner._execute_action("full-catalog", "inventory-1", "inventory-1", command_id="manual")

    marker = runner.profile.state_dir / "inventory.completed"
    assert calls == 2
    assert marker.is_file()
    assert not (runner.profile.state_dir / "inventory.started").exists()


def test_full_catalog_refetches_even_after_a_completed_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    started_at = runner._ensure_inventory_pass_started()
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET inventory_next_page = 1, last_inventory_at = ?",
            (started_at,),
        )
    commands: list[list[str]] = []

    def execute(command: list[str], *_args: object, **_kwargs: object) -> dict[str, Any]:
        commands.append(command)
        return {"ok": True, "status": "succeeded", "boards": []}

    monkeypatch.setattr(
        runner,
        "_execute_report",
        execute,
    )

    runner._execute_action(
        "full-catalog", "inventory-resume", "inventory-resume", command_id="manual"
    )

    assert (runner.profile.state_dir / "inventory.completed").is_file()
    assert not (runner.profile.state_dir / "inventory.started").exists()
    assert "--inventory" in commands[0] and "--listing-only" in commands[0]
    assert commands[0][commands[0].index("--inventory-since") + 1] == started_at


def test_scheduled_run_does_not_start_manual_full_content_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))
    with connect_archive(runner.profile.archive) as connection:
        connection.execute(
            "UPDATE boards SET last_inventory_at = '2026-07-12T00:00:00Z' WHERE board_id = 'aa'"
        )
        connection.execute(
            """
            INSERT INTO crawl_frontier (board_id, external_post_id, url)
            VALUES ('aa', 1, 'https://source.invalid/aa/1')
            """
        )
    runner._complete_inventory_pass("2026-07-12T00:00:00Z")
    commands: list[list[str]] = []

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            commands.append(arguments)
            module = arguments[arguments.index("-m") + 1]
            if module in {"scripts.crawl_cycle", "scripts.recover_queue"}:
                output = Path(arguments[arguments.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    json.dumps({"ok": True, "status": "succeeded", "boards": []}),
                    encoding="utf-8",
                )
            elif module == "scripts.publish_static":
                stream = cast(BinaryIO, _kwargs["stdout"])
                stream.write(
                    json.dumps(
                        {
                            "ok": True,
                            "mode": "noop",
                            "release_key": f"releases/{'a' * 64}.json",
                            "previous_release_key": None,
                            "previous_release_verified": False,
                        }
                    ).encode()
                )
                stream.flush()

        def wait(self, timeout: int) -> int:
            assert timeout == 30
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    assert runner.run_scheduled()["status"] == "succeeded"
    assert all("scripts.recover_queue" not in command for command in commands)
    assert not (runner.profile.state_dir / "recovery.completed").exists()


def test_running_process_claims_pause_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process_command = _command("sync-now")
    pause_command = _command("pause-after-current")
    api = Api([process_command, pause_command])
    runner, store = _runner(tmp_path, api)

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            assert "--pause-file" not in arguments
            output = Path(arguments[arguments.index("--output") + 1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "status": "succeeded",
                        "boards": [],
                    }
                ),
                encoding="utf-8",
            )
            self.waits = 0

        def wait(self, timeout: int) -> int:
            self.waits += 1
            if self.waits == 1:
                raise subprocess.TimeoutExpired("crawl", timeout)
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    assert runner.run_once()["status"] == "succeeded"
    assert (runner.profile.state_dir / "schedule.paused").is_file()
    pause = store.command(pause_command["command_id"])
    assert pause is not None and pause["state"] == "succeeded"
    marker_claim = next(
        payload
        for path, payload in api.calls
        if path.endswith("/commands/claim") and payload.get("command_kind") == "marker"
    )
    assert marker_claim["runner_id"] == "oracle-primary"


def test_short_scheduled_action_claims_pause_before_follow_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pause_command = _command("pause-after-current")
    api = Api([None, None, pause_command])
    runner, _store = _runner(tmp_path, api)
    commands: list[list[str]] = []

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            commands.append(arguments)
            output = Path(arguments[arguments.index("--output") + 1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "status": "succeeded",
                        "changed_posts": 0,
                        "failed_posts": 0,
                        "boards": [],
                    }
                ),
                encoding="utf-8",
            )

        def wait(self, timeout: int) -> int:
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    report = runner.run_scheduled()

    assert report["status"] == "partial"
    assert report["ok"] is True
    assert len(commands) == 1
    assert (runner.profile.state_dir / "schedule.paused").is_file()
    finish = next(
        payload for path, payload in api.calls if "/runs/" in path and path.endswith("/finish")
    )
    assert finish["safe_summary_code"] == "schedule_paused"


def test_pause_does_not_mask_an_existing_scheduled_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pause_command = _command("pause-after-current")
    runner, _store = _runner(tmp_path, Api([None, None, pause_command]))
    monkeypatch.setattr(
        runner,
        "_execute_action",
        lambda *_args, **_kwargs: {"ok": False, "status": "failed"},
    )

    report = runner.run_scheduled()

    assert report["status"] == "failed"
    assert report["ok"] is False


def test_paused_recovery_reports_the_cooperative_stop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner, _store = _runner(tmp_path, Api([]))

    class Process:
        def __init__(self, arguments: list[str], **_kwargs: object) -> None:
            output = Path(arguments[arguments.index("--output") + 1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(
                    {
                        "ok": False,
                        "status": "partial",
                        "stop_reason": "schedule_paused",
                    }
                ),
                encoding="utf-8",
            )

        def wait(self, timeout: int) -> int:
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    report = runner._execute_action("retry-batch", "scheduled", "scheduled")

    assert report["stop_reason"] == "schedule_paused"


def test_marker_claim_drains_the_entire_outbox_first(tmp_path: Path) -> None:
    pause_command = _command("pause-after-current")
    api = Api([pause_command])
    runner, store = _runner(tmp_path, api)
    for sequence in range(51):
        store.enqueue(
            "event_batch",
            "/api/v1/runner/runs/scheduled/events:batch",
            {"events": [{"sequence": sequence, "step": "crawl", "state": "running"}]},
            f"event-backlog-{sequence:04d}",
        )

    runner._claim_marker()
    assert not any(path.endswith("/commands/claim") for path, _payload in api.calls)
    assert store.stats()["rows"] == 1
    runner._claim_marker()

    claim_index = next(
        index
        for index, (path, _payload) in enumerate(api.calls)
        if path.endswith("/commands/claim")
    )
    assert claim_index == 51
    assert store.stats()["rows"] == 0
    assert (runner.profile.state_dir / "schedule.paused").is_file()
