from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from crawler.archive import connect_archive, initialize_archive
from scripts.control_client import ControlClient
from scripts.control_runner import ControlRunner, RunnerProfile, _next_scheduled_at
from scripts.control_store import ControlStore


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
            {"command": self.commands.pop(0)}
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
    assert _next_scheduled_at(now) == expected


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
    assert "canonical_url" not in board
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


def test_publish_without_change_is_a_process_free_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    command = _command("publish-if-changed")
    api = Api([command])
    runner, store = _runner(tmp_path, api)
    monkeypatch.setattr(
        "scripts.control_runner.subprocess.Popen",
        lambda *_args, **_kwargs: pytest.fail("publish process must not start"),
    )

    report = runner.run_once()

    assert report["status"] == "succeeded"
    row = store.command(command["command_id"])
    assert row is not None
    assert json.loads(row["result_json"])["code"] == "publish_no_change"


def test_publish_waits_for_daily_window_without_losing_pending_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    command = _command("publish-if-changed")
    api = Api([command])
    runner, store = _runner(tmp_path, api)
    (runner.profile.state_dir / "publish.pending").touch()
    (runner.profile.state_dir / "publish.completed").touch()
    monkeypatch.setattr(
        "scripts.control_runner.subprocess.Popen",
        lambda *_args, **_kwargs: pytest.fail("publish process must not start"),
    )

    assert runner.run_once()["status"] == "succeeded"
    row = store.command(command["command_id"])
    assert row is not None
    assert json.loads(row["result_json"])["code"] == "publish_not_due"
    assert (runner.profile.state_dir / "publish.pending").exists()


def test_scheduled_run_crawls_recovers_and_publishes_without_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = Api([])
    runner, _store = _runner(tmp_path, api)
    commands: list[list[str]] = []

    class Process:
        def __init__(self, arguments: list[str], **kwargs: object) -> None:
            commands.append(arguments)
            module = arguments[arguments.index("-m") + 1]
            if "--output" in arguments:
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
            if module == "scripts.publish_static":
                stdout: Any = kwargs["stdout"]
                assert hasattr(stdout, "write")
                stdout.write(
                    json.dumps(
                        {
                            "ok": True,
                            "status": "succeeded",
                            "release_key": f"releases/{'a' * 64}.json",
                        }
                    ).encode()
                )
                stdout.flush()

        def wait(self, timeout: int) -> int:
            assert timeout == 30
            return 0

    monkeypatch.setattr("scripts.control_runner.subprocess.Popen", Process)

    report = runner.run_scheduled()

    assert report["status"] == "succeeded"
    assert len(commands) == 4
    start = next(payload for path, payload in api.calls if path == "/api/v1/runner/runs")
    assert start["kind"] == "scheduled" and start["source"] == "systemd"
    assert "command_id" not in start
    finish = next(payload for path, payload in api.calls if path.endswith("/finish"))
    assert finish["release_id"] == "a" * 64
    assert finish["counters"]["changed_posts"] == 1
    assert not (runner.profile.state_dir / "publish.pending").exists()
