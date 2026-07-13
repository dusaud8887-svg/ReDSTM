from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from scripts.control_store import ControlStore, OutboxFullError

_NOW = datetime(2026, 7, 12, tzinfo=UTC)


def test_store_closes_every_sqlite_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression: the runner is a long-lived poller; leaked connections exhausted the
    # process file-descriptor limit after ~3 hours and killed a manual full-catalog run.
    connections: list[sqlite3.Connection] = []
    original_connect = sqlite3.connect

    def tracking_connect(*args: object, **kwargs: object) -> sqlite3.Connection:
        connection = original_connect(*args, **kwargs)  # type: ignore[arg-type]
        connections.append(connection)
        return connection

    monkeypatch.setattr("scripts.control_store.sqlite3.connect", tracking_connect)
    store = ControlStore(tmp_path / "control.sqlite")
    command_id = str(uuid4())
    store.record_claim(command_id, "sync-now", now=_NOW)
    store.begin_command(command_id, run_id="run-1", now=_NOW)
    store.finish_command(command_id, "succeeded", "cycle_succeeded", now=_NOW)
    store.pending_commands()
    store.enqueue(
        "heartbeat", "/api/v1/runner/heartbeat", {"state": "idle"}, "heartbeat-close-1"
    )
    store.pending()
    store.stats()
    store.rejection()

    assert connections
    for connection in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


def test_command_ledger_blocks_replay_after_execution_starts(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    command_id = str(uuid4())

    claimed = store.record_claim(command_id, "sync-now", now=_NOW)
    assert claimed["state"] == "claimed"
    assert store.begin_command(command_id, run_id="run-1", now=_NOW) is True
    assert store.begin_command(command_id, run_id="run-2", now=_NOW) is False

    payload = {"state": "succeeded", "counters": {"changed_posts": 2}}
    terminal = store.finish_command(
        command_id,
        "succeeded",
        "cycle_succeeded",
        result_payload=payload,
        now=_NOW,
    )
    assert terminal["state"] == "succeeded"
    assert terminal["report_state"] == "pending"
    assert json.loads(terminal["result_json"]) == {
        "code": "cycle_succeeded",
        "payload": payload,
    }
    assert store.record_claim(command_id, "sync-now")["state"] == "succeeded"
    assert store.begin_command(command_id) is False
    assert [row["command_id"] for row in store.pending_commands()] == [command_id]
    store.mark_reported(command_id, now=_NOW)
    store.mark_reported(command_id, now=_NOW)
    assert store.pending_commands() == []
    reported = store.command(command_id)
    assert reported is not None and reported["report_state"] == "delivered"


def test_permanently_rejected_terminal_report_keeps_result_and_leaves_pending_queue(
    tmp_path: Path,
) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    command_id = str(uuid4())
    store.record_claim(command_id, "sync-now", now=_NOW)
    terminal = store.finish_command(
        command_id,
        "succeeded",
        "cycle_succeeded",
        result_payload={"state": "succeeded", "counters": {"changed_posts": 1}},
        now=_NOW,
    )

    store.mark_report_rejected(command_id, now=_NOW)
    store.mark_report_rejected(command_id, now=_NOW)

    row = store.command(command_id)
    assert row is not None
    assert row["report_state"] == "permanently_rejected"
    assert row["reported_at"] == "2026-07-12T00:00:00.000Z"
    assert row["result_json"] == terminal["result_json"]
    assert store.pending_commands() == []


def test_existing_delivered_ledger_migrates_to_explicit_report_state(tmp_path: Path) -> None:
    path = tmp_path / "control.sqlite"
    command_id = str(uuid4())
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE command_ledger (
                command_id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                state TEXT NOT NULL,
                claimed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_id TEXT,
                result_json TEXT NOT NULL DEFAULT '{}',
                reported_at TEXT
            )
            """
        )
        connection.execute(
            """
            INSERT INTO command_ledger (
                command_id, action, state, claimed_at, updated_at, reported_at
            ) VALUES (?, 'sync-now', 'succeeded', ?, ?, ?)
            """,
            (command_id, *(["2026-07-12T00:00:00.000Z"] * 3)),
        )

    store = ControlStore(path)

    row = store.command(command_id)
    assert row is not None and row["report_state"] == "delivered"
    assert store.pending_commands() == []


def test_command_ledger_rejects_action_mismatch_and_terminal_change(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    command_id = str(uuid4())
    store.record_claim(command_id, "pause-after-current", now=_NOW)

    with pytest.raises(ValueError, match="action mismatch"):
        store.record_claim(command_id, "resume-schedule", now=_NOW)
    store.finish_command(command_id, "succeeded", "schedule_paused", now=_NOW)
    with pytest.raises(ValueError, match="terminal state"):
        store.finish_command(command_id, "failed", "schedule_failed", now=_NOW)


def test_command_ledger_rejects_unsafe_replay_payload(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    command_id = str(uuid4())
    store.record_claim(command_id, "sync-now", now=_NOW)
    with pytest.raises(ValueError, match="forbidden"):
        store.finish_command(
            command_id,
            "failed",
            "cycle_failed",
            result_payload={"path": "/srv/redstm/private"},
        )
    with pytest.raises(ValueError, match="terminal"):
        store.mark_reported(command_id)


def test_outbox_coalesces_status_and_preserves_causal_order(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    store.enqueue(
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-old", "state": "idle"},
        "heartbeat-old",
        now=_NOW,
    )
    store.enqueue(
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-new", "state": "running"},
        "heartbeat-new",
        now=_NOW + timedelta(seconds=30),
    )
    store.enqueue(
        "run_finish",
        "/api/v1/runner/runs/run-1/finish",
        {"state": "succeeded", "counters": {}},
        "run-finish-0001",
        now=_NOW,
    )

    assert store.stats()["rows"] == 2
    pending = store.pending(now=_NOW + timedelta(minutes=1))
    assert [item["kind"] for item in pending] == ["heartbeat", "run_finish"]
    assert json.loads(pending[0]["payload_json"])["runner_version"] == "git-new"


def test_outbox_evicts_detail_before_terminal_and_honours_defer(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite", max_bytes=10_000, max_events=3)
    for sequence in range(3):
        store.enqueue(
            "event_batch",
            "/api/v1/runner/runs/run-1/events:batch",
            {"events": [{"sequence": sequence, "step": "crawl", "state": "running"}]},
            f"event-batch-{sequence:04d}",
            now=_NOW,
        )
    terminal_id = store.enqueue(
        "command_finish",
        f"/api/v1/runner/commands/{uuid4()}/finish",
        {"runner_id": "oracle-primary", "state": "succeeded"},
        "command-finish-0001",
        now=_NOW,
    )
    assert store.stats()["events"] == 3
    assert any(item["id"] == terminal_id for item in store.pending(now=_NOW))

    store.defer(terminal_id, _NOW + timedelta(minutes=1))
    assert all(item["id"] != terminal_id for item in store.pending(now=_NOW))
    assert any(item["id"] == terminal_id for item in store.pending(now=_NOW + timedelta(minutes=2)))
    store.acknowledge(terminal_id)
    assert all(item["id"] != terminal_id for item in store.pending(now=_NOW + timedelta(minutes=2)))


def test_outbox_does_not_replay_past_a_deferred_predecessor(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    start_id = store.enqueue(
        "run_start",
        "/api/v1/runner/runs",
        {"run_id": "run-1", "kind": "scheduled"},
        "run-start-0001",
        now=_NOW,
    )
    store.enqueue(
        "run_finish",
        "/api/v1/runner/runs/run-1/finish",
        {"state": "succeeded", "counters": {}},
        "run-finish-0001",
        now=_NOW,
    )
    store.defer(start_id, _NOW + timedelta(minutes=1))

    assert store.pending(now=_NOW) == []
    assert [item["kind"] for item in store.pending(now=_NOW + timedelta(minutes=2))] == [
        "run_start",
        "run_finish",
    ]


def test_rejected_outbox_item_keeps_only_bounded_safe_evidence(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    item_id = store.enqueue(
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-1", "state": "idle"},
        "heartbeat-rejected",
        now=_NOW,
    )

    store.reject(item_id, "invalid_heartbeat", now=_NOW)

    assert store.stats()["rows"] == 0
    assert store.rejection() == {
        "id": 1,
        "rejected_count": 1,
        "last_code": "invalid_heartbeat",
        "last_rejected_at": "2026-07-12T00:00:00.000Z",
    }
    store.record_rejection("invalid_board_status", now=_NOW + timedelta(seconds=1))
    assert store.rejection() == {
        "id": 1,
        "rejected_count": 2,
        "last_code": "invalid_board_status",
        "last_rejected_at": "2026-07-12T00:00:01.000Z",
    }


def test_outbox_rejects_unsafe_or_unbounded_payloads(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite", max_bytes=100, max_events=2)
    with pytest.raises(ValueError, match="forbidden"):
        store.enqueue(
            "heartbeat",
            "/api/v1/runner/heartbeat",
            {"token": "secret"},
            "unsafe-payload-1",
        )
    with pytest.raises(ValueError, match="forbidden"):
        store.enqueue(
            "heartbeat",
            "/api/v1/runner/heartbeat",
            {"safe_message": "/srv/redstm/private"},
            "unsafe-payload-2",
        )
    with pytest.raises(OutboxFullError):
        store.enqueue(
            "run_finish",
            "/api/v1/runner/runs/run-1/finish",
            {"safe_message": "x" * 200},
            "oversized-safe-1",
        )
