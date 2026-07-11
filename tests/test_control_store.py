from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from scripts.control_store import ControlStore, OutboxFullError

_NOW = datetime(2026, 7, 12, tzinfo=UTC)


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
    assert json.loads(terminal["result_json"]) == {
        "code": "cycle_succeeded",
        "payload": payload,
    }
    assert store.record_claim(command_id, "sync-now")["state"] == "succeeded"
    assert store.begin_command(command_id) is False


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


def test_outbox_coalesces_status_and_orders_protected_events(tmp_path: Path) -> None:
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
    assert [item["kind"] for item in pending] == ["run_finish", "heartbeat"]
    assert json.loads(pending[1]["payload_json"])["runner_version"] == "git-new"


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
