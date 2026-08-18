from __future__ import annotations

import argparse
import configparser
import hashlib
import itertools
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from filelock import FileLock, Timeout

from crawler.archive import archive_transaction
from crawler.settings import (
    REDSTM_EXPORT_MAX_CHANGED_POSTS,
    REDSTM_EXPORT_WORKERS,
    REDSTM_FULL_CATALOG_OUTAGE_BACKOFF_SECONDS,
    REDSTM_FULL_CATALOG_STUCK_CYCLES,
    REDSTM_FULL_CONTENT_MAX_POSTS,
    REDSTM_RECOVERY_MAX_POSTS,
    REDSTM_RECOVERY_TIME_BUDGET_SECONDS,
)
from scripts.control_client import (
    ControlClient,
    ControlProtocolError,
    ControlUnavailableError,
    DeliveryResult,
)
from scripts.control_store import ControlStore, OutboxFullError

_RUN_KINDS = {
    "sync-now": "manual-sync",
    "full-catalog": "manual-sync",
    "full-content": "retry",
    "fill-missing-content": "retry",
    "retry-batch": "retry",
    "publish-if-changed": "publish",
}
_MARKER_CODES = {
    "pause-after-current": "schedule_paused",
    "resume-schedule": "schedule_resumed",
}
_STATUS_CODES = {
    "succeeded": "run_succeeded",
    "partial": "run_partial",
    "site_unreachable": "site_unreachable",
    "rate_limited": "rate_limited",
    "auth_failed": "auth_failed",
    "runner_failed": "runner_failed",
    "failed": "run_failed",
}
_SUCCESS_CODES = {
    "sync-now": "cycle_succeeded",
    "full-catalog": "full_catalog_succeeded",
    "full-content": "full_content_succeeded",
    "fill-missing-content": "missing_content_succeeded",
    "inventory": "inventory_succeeded",
    "bootstrap-recovery": "bootstrap_recovery_succeeded",
    "retry-batch": "recovery_succeeded",
    "publish-if-changed": "publish_succeeded",
}
_WARNING_CODES = {
    "auth_required": "auth_failed",
    "listing_parse_failed": "parse_drift",
    "parse_drift": "parse_drift",
    "rate_limited": "rate_limited",
    "listing_fetch_failed": "site_unreachable",
    "network_error": "site_unreachable",
}
_DAILY_INTERVAL_SECONDS = 24 * 60 * 60
_WEEKLY_INTERVAL_SECONDS = 7 * _DAILY_INTERVAL_SECONDS
_SNAPSHOT_TIME_BUDGET_SECONDS = 30
_LIVE_SNAPSHOT_INTERVAL_SECONDS = 5 * 60
_DEFAULT_DISK_LOW_BYTES = 40 * 1024**3
_DEFAULT_DISK_STOP_BYTES = 20 * 1024**3
_DEFAULT_CONTROL_REJECTION_WARNING_SECONDS = _DAILY_INTERVAL_SECONDS
_DEFAULT_TOKEN_EXPIRING_SECONDS = _DAILY_INTERVAL_SECONDS
_DEFAULT_PUBLISH_STALE_SECONDS = _DAILY_INTERVAL_SECONDS
_SCHEDULE_TIMER_PATH = Path("/etc/systemd/system/redstm-schedule.timer")
_CALENDAR_PATTERN = re.compile(
    r"\*-\*-\* (?P<hours>(?:[01][0-9]|2[0-3])(?:,(?:[01][0-9]|2[0-3]))*)"
    r":(?P<minute>[0-5][0-9]):(?P<second>[0-5][0-9]) UTC"
)
_INVENTORY_STARTED = "inventory.started"
_INVENTORY_COMPLETED = "inventory.completed"
_LIVE_INVENTORY = "inventory.live"
_FULL_CONTENT_STARTED = "full-content.started"
_CURRENT_RUN_PAUSED = "current-run.paused"
# The legacy import is the baseline catalog. Source boards added after that snapshot are
# registered explicitly once a baseline-only board proves this is a TypeMoon archive.
_SOURCE_BOARD_ADDITIONS = (("write_drawing", "창작그림", "creation", "write_nirvana"),)
# Mid-run progress events use a disjoint sequence range so they never collide with the
# fixed start(0)/terminal(1)/final-snapshot(2) sequences of a run.
_PROGRESS_EVENT_SEQUENCE_BASE = 1000


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _is_archive_locked(error: BaseException) -> bool:
    # journal_mode=DELETE means any long reader/writer (orphaned crawl child, backup,
    # export) surfaces here as OperationalError("database is locked") after the busy
    # timeout; the distinct safe code separates it from real runner defects on /ops.
    return isinstance(error, sqlite3.OperationalError) and "lock" in str(error).casefold()


def _normalized_timestamp(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _frontier_error_code(value: object) -> str:
    code = str(value or "unknown_error")
    return code if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", code) else "legacy_error"


def _next_scheduled_at(on_calendar: str, now: datetime | None = None) -> str | None:
    # ponytail: this deliberately accepts one fixed UTC-slot calendar. If the unit grows
    # ranges or multiple calendars, read NextElapseUSecRealtime through systemd D-Bus instead.
    match = _CALENDAR_PATTERN.fullmatch(on_calendar)
    if match is None:
        return None
    current = (now or datetime.now(UTC)).astimezone(UTC)
    anchor = current.replace(hour=0, minute=0, second=0, microsecond=0)
    hours = sorted({int(hour) for hour in match.group("hours").split(",")})
    for day in (0, 1):
        for hour in hours:
            candidate = anchor + timedelta(
                days=day,
                hours=hour,
                minutes=int(match.group("minute")),
                seconds=int(match.group("second")),
            )
            if candidate > current:
                return candidate.isoformat(timespec="seconds").replace("+00:00", "Z")
    return None


def _installed_next_scheduled_at(timer_path: Path, now: datetime | None = None) -> str | None:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        with timer_path.open(encoding="utf-8") as source:
            parser.read_file(source)
        on_calendar = parser["Timer"]["OnCalendar"]
    except OSError, KeyError, configparser.Error:
        return None
    return _next_scheduled_at(on_calendar, now)


def _optional_positive_int(value: object, *, name: str, maximum: int) -> int | None:
    """Parse optional positive command args; omit when absent, reject bad shapes."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"command {name} must be a positive integer")
    if value < 1 or value > maximum:
        raise ValueError(f"command {name} is out of range")
    return value


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _collection_counters(report: dict[str, Any]) -> dict[str, int]:
    raw_outcomes = report.get("outcomes")
    outcomes: dict[str, Any] = raw_outcomes if isinstance(raw_outcomes, dict) else {}
    return {
        "changed_posts": _integer(report.get("changed_posts", outcomes.get("stored", 0))),
        "failed_posts": _integer(
            report.get(
                "failed_posts",
                _integer(outcomes.get("parse_failed")) + _integer(outcomes.get("fetch_failed")),
            )
        ),
        "boards_ok": _integer(report.get("boards_ok")),
        "boards_failed": _integer(report.get("boards_failed")),
    }


def _sum_collection_counters(
    counters: dict[str, int], offset: dict[str, int] | None
) -> dict[str, int]:
    if offset is None:
        return counters
    return {name: counters[name] + offset[name] for name in counters}


def _saved_progress(record: dict[str, Any]) -> dict[str, int] | None:
    try:
        progress = json.loads(record["result_json"]).get("progress")
    except AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError:
        return None
    if not isinstance(progress, dict):
        return None
    counters = _collection_counters(progress)
    return counters if set(progress) == set(counters) else None


def _nonnegative_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def _aware_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an ISO timestamp") from error
    if parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("must include a timezone")
    return parsed.astimezone(UTC)


@dataclass(frozen=True)
class RunnerProfile:
    state_db: Path
    state_dir: Path
    archive: Path
    session: Path
    warc_dir: Path
    report_dir: Path
    static_root: Path
    remote: str
    runner_id: str
    runner_version: str
    disk_low_bytes: int = _DEFAULT_DISK_LOW_BYTES
    disk_stop_bytes: int = _DEFAULT_DISK_STOP_BYTES
    control_rejection_warning_seconds: int = _DEFAULT_CONTROL_REJECTION_WARNING_SECONDS
    token_expires_at: datetime | None = None
    token_expiring_seconds: int = _DEFAULT_TOKEN_EXPIRING_SECONDS
    publish_stale_seconds: int = _DEFAULT_PUBLISH_STALE_SECONDS


class ControlRunner:
    def __init__(self, profile: RunnerProfile, client: ControlClient, store: ControlStore) -> None:
        if (
            min(
                profile.disk_low_bytes,
                profile.disk_stop_bytes,
                profile.control_rejection_warning_seconds,
                profile.token_expiring_seconds,
                profile.publish_stale_seconds,
            )
            < 0
        ):
            raise ValueError("warning thresholds cannot be negative")
        if (
            profile.disk_low_bytes
            and profile.disk_stop_bytes
            and profile.disk_stop_bytes >= profile.disk_low_bytes
        ):
            raise ValueError("disk stop threshold must be lower than the warning threshold")
        if profile.token_expires_at is not None and profile.token_expires_at.utcoffset() is None:
            raise ValueError("token expiry must include a timezone")
        self.profile = profile
        self.client = client
        self.store = store
        self._progress_sequences: dict[str, itertools.count[int]] = {}
        self.profile.state_dir.mkdir(parents=True, exist_ok=True)
        self.profile.report_dir.mkdir(parents=True, exist_ok=True)
        live_inventory = self._marker_payload(self.profile.state_dir / _LIVE_INVENTORY)
        self._live_inventory = (
            (str(live_inventory["run_id"]), str(live_inventory["board_id"]))
            if live_inventory is not None
            and isinstance(live_inventory.get("run_id"), str)
            and isinstance(live_inventory.get("board_id"), str)
            else None
        )

    def _disk_stop_reached(self) -> bool:
        return bool(
            self.profile.disk_stop_bytes
            and shutil.disk_usage(self.profile.state_dir).free < self.profile.disk_stop_bytes
        )

    def run_once(self) -> dict[str, Any]:
        lock = FileLock(self.profile.state_dir / "control.lock", timeout=0)
        try:
            with lock:
                return self._run_locked()
        except Timeout:
            if (self.profile.state_dir / "maintenance").is_file():
                self._heartbeat("degraded", step="maintenance", warning_code="maintenance")
                return {"ok": True, "status": "maintenance"}
            return {"ok": True, "status": "busy"}

    def run_scheduled(self) -> dict[str, Any]:
        lock = FileLock(self.profile.state_dir / "control.lock", timeout=0)
        try:
            with lock:
                return self._run_scheduled_locked()
        except Timeout:
            if (self.profile.state_dir / "maintenance").is_file():
                self._heartbeat("degraded", step="maintenance", warning_code="maintenance")
                return {"ok": True, "status": "maintenance"}
            return {"ok": True, "status": "busy"}

    def _run_scheduled_locked(self) -> dict[str, Any]:
        (self.profile.state_dir / "maintenance").unlink(missing_ok=True)
        self._reconcile_source_boards()
        if (self.profile.state_dir / "schedule.paused").exists():
            self._heartbeat("paused")
            return {"ok": True, "status": "paused"}
        self._claim_marker()
        if (self.profile.state_dir / "schedule.paused").exists():
            self._heartbeat("paused")
            return {"ok": True, "status": "paused"}
        run_id = f"scheduled-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:8]}"
        started_at = _timestamp()
        self._send(
            "run_start",
            "/api/v1/runner/runs",
            {
                "run_id": run_id,
                "kind": "scheduled",
                "source": "systemd",
                "requested_at": started_at,
                "started_at": started_at,
            },
            f"start-{run_id}",
        )
        self._event(run_id, 0, "scheduled", "running")
        state = "succeeded"
        counters = {"changed_posts": 0, "failed_posts": 0, "boards_ok": 0, "boards_failed": 0}
        release_id: str | None = None
        crawl_status = "failed"
        paused = False
        intentional_pause = False
        terminal_safe_code: str | None = None
        sequence = 1
        for action in ("sync-now", "retry-batch", "publish-if-changed"):
            self._claim_marker()
            if (self.profile.state_dir / "schedule.paused").exists():
                paused = True
                if state == "succeeded":
                    state = "partial"
                    intentional_pause = True
                break
            if action in {"inventory", "bootstrap-recovery", "retry-batch"} and crawl_status in {
                "failed",
                "runner_failed",
                "site_unreachable",
                "rate_limited",
                "auth_failed",
            }:
                self._event(run_id, sequence, action, "skipped")
                sequence += 1
                continue
            try:
                report = self._execute_action(
                    action,
                    run_id,
                    run_id,
                    max_seconds=(
                        REDSTM_RECOVERY_TIME_BUDGET_SECONDS if action == "retry-batch" else None
                    ),
                )
                action_state, safe_code, payload = self._result(action, report)
            except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
                # sqlite3.Error covers a canonical archive held by another process
                # (orphaned crawl child, backup/export); crashing here would leave the
                # run unreported instead of closing it as a runner failure.
                report = {}
                action_state = "failed"
                safe_code = "archive_locked" if _is_archive_locked(error) else "runner_failed"
                self._write_command_diagnostics(run_id, action, error)
                payload = self._finish_payload("failed", safe_code)
            if action == "sync-now":
                crawl_status = str(report.get("status", "failed"))
            if report.get("stop_reason") == "schedule_paused":
                intentional_pause = True
            if action in {"sync-now", "inventory"}:
                self._board_summaries(report)
            if (
                action in {"sync-now", "inventory", "bootstrap-recovery", "retry-batch"}
                and payload["counters"]["changed_posts"]
            ):
                self._write_publish_marker()
            counters["changed_posts"] += payload["counters"]["changed_posts"]
            counters["failed_posts"] += payload["counters"]["failed_posts"]
            if action == "sync-now":
                counters["boards_ok"] = payload["counters"]["boards_ok"]
                counters["boards_failed"] = payload["counters"]["boards_failed"]
            release_id = payload.get("release_id") or release_id
            if action_state == "failed" or state == "failed":
                state = "failed"
            elif action_state == "partial":
                state = "partial"
            if action_state in {"partial", "failed"} and terminal_safe_code is None:
                terminal_safe_code = safe_code
            self._event(
                run_id,
                sequence,
                action,
                action_state,
                payload["counters"],
                safe_message=safe_code,
            )
            sequence += 1
        self._archive_snapshot_event(run_id, sequence)
        finish_code = (
            "schedule_paused" if intentional_pause else terminal_safe_code or f"scheduled_{state}"
        )
        finish = self._finish_payload(state, finish_code, counters, release_id)
        self._send(
            "run_finish",
            f"/api/v1/runner/runs/{run_id}/finish",
            finish,
            f"finish-{run_id}",
        )
        self._heartbeat("idle")
        return {
            "ok": state == "succeeded" or (paused and intentional_pause),
            "status": state,
            "run_id": run_id,
        }

    def _run_locked(self) -> dict[str, Any]:
        (self.profile.state_dir / "maintenance").unlink(missing_ok=True)
        self._reconcile_source_boards()
        try:
            self.client.flush(self.store)
        except ControlProtocolError, OSError, ValueError, sqlite3.Error:
            pass
        pending = self.store.pending_commands(limit=1)
        if pending:
            return self._resume(pending[0])
        try:
            command = self.client.claim(self.profile.runner_id, f"claim-{uuid4().hex}")
        except ControlProtocolError, ControlUnavailableError:
            return {"ok": True, "status": "control_unavailable"}
        if command is None:
            self._heartbeat("idle")
            return {"ok": True, "status": "idle"}
        record = self.store.record_claim(
            command["command_id"], command["action"], args=command.get("args", {})
        )
        return self._resume(record)

    def _reconcile_source_boards(self) -> None:
        # Board registration is idempotent housekeeping; a briefly locked archive must
        # not crash the poll (which would also skip the heartbeat for this tick).
        try:
            self._reconcile_source_boards_once()
        except sqlite3.Error:
            return

    def _reconcile_source_boards_once(self) -> None:
        if not self.profile.archive.is_file():
            return
        board_ids = {
            board_id
            for addition in _SOURCE_BOARD_ADDITIONS
            for board_id in (addition[0], addition[3])
        }
        placeholders = ",".join("?" for _ in board_ids)
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            present = {
                str(row[0])
                for row in connection.execute(
                    f"SELECT board_id FROM boards WHERE board_id IN ({placeholders})",
                    tuple(sorted(board_ids)),
                )
            }
        missing = [
            item
            for item in _SOURCE_BOARD_ADDITIONS
            if item[0] not in present and item[3] in present
        ]
        if not missing:
            return
        observed_at = _timestamp()
        with archive_transaction(self.profile.archive) as connection:
            for board_id, name, group_name, _baseline_board_id in missing:
                connection.execute(
                    """
                    INSERT INTO boards (
                        board_id, name, group_name, canonical_url, first_seen_at, last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(board_id) DO NOTHING
                    """,
                    (
                        board_id,
                        name,
                        group_name,
                        f"https://www.typemoon.net/{board_id}",
                        observed_at,
                        observed_at,
                    ),
                )

    def _resume(self, record: dict[str, Any]) -> dict[str, Any]:
        state = str(record["state"])
        if state in {"succeeded", "partial", "failed"}:
            return self._replay_terminal(record)
        if state == "running":
            action = str(record["action"])
            if action in {"fill-missing-content", "retry-batch"}:
                return self._run_process_action(record, action, resuming=True)
            raw_args = record.get("args")
            board_id = raw_args.get("board_id") if isinstance(raw_args, dict) else None
            checkpoint = {
                "full-catalog": self.profile.state_dir / _INVENTORY_STARTED,
                "full-content": (
                    self._full_content_marker(board_id)
                    if board_id is None
                    or (isinstance(board_id, str) and re.fullmatch(r"[a-z0-9_]{1,64}", board_id))
                    else None
                ),
            }.get(action)
            if checkpoint is not None and checkpoint.is_file():
                return self._run_process_action(record, action, resuming=True)
            progress = _saved_progress(record)
            payload = self._finish_payload(
                "failed",
                "runner_interrupted",
                progress,
                counters_reported=progress is not None,
            )
            record = self.store.finish_command(
                record["command_id"],
                "failed",
                "runner_interrupted",
                result_payload=payload,
            )
            return self._replay_terminal(record)
        action = str(record["action"])
        if action in _MARKER_CODES:
            return self._run_marker(record, action)
        if action in _RUN_KINDS:
            return self._run_process_action(record, action)
        raise ValueError("local command action is not allowed")

    def _run_marker(self, record: dict[str, Any], action: str) -> dict[str, Any]:
        command_id = str(record["command_id"])
        if not self.store.begin_command(command_id):
            return self._resume(self.store.command(command_id) or record)
        marker = self.profile.state_dir / "schedule.paused"
        if action == "pause-after-current":
            for target in (marker, self.profile.state_dir / _CURRENT_RUN_PAUSED):
                partial = target.with_suffix(".partial")
                partial.write_text(f"paused_at={_timestamp()}\n", encoding="utf-8")
                os.replace(partial, target)
        else:
            marker.unlink(missing_ok=True)
            (self.profile.state_dir / _CURRENT_RUN_PAUSED).unlink(missing_ok=True)
        safe_code = _MARKER_CODES[action]
        payload = {
            "runner_id": self.profile.runner_id,
            "state": "succeeded",
            "safe_summary_code": safe_code,
        }
        terminal = self.store.finish_command(
            command_id, "succeeded", safe_code, result_payload=payload
        )
        delivery = self._send(
            "command_finish",
            f"/api/v1/runner/commands/{command_id}/finish",
            payload,
            f"finish-{command_id}",
        )
        self._finish_command_reporting(command_id, delivery)
        self._heartbeat("paused" if marker.exists() else "idle")
        return {"ok": True, "status": terminal["state"], "command_id": command_id}

    def _run_process_action(
        self, record: dict[str, Any], action: str, *, resuming: bool = False
    ) -> dict[str, Any]:
        command_id = str(record["command_id"])
        run_id = str(record.get("run_id") or f"command-{command_id}")
        progress_offset = _saved_progress(record) if resuming else None
        if not resuming:
            if not self.store.begin_command(command_id, run_id=run_id):
                return self._resume(self.store.command(command_id) or record)
            started_at = _timestamp()
            start_payload = {
                "run_id": run_id,
                "kind": _RUN_KINDS[action],
                "source": "command",
                "command_id": command_id,
                "requested_at": record["claimed_at"],
                "started_at": started_at,
            }
            self._send("run_start", "/api/v1/runner/runs", start_payload, f"start-{command_id}")
            self._event(run_id, 0, action, "running")
        report: dict[str, Any] = {}
        board_id = None
        max_seconds: int | None = None
        max_posts: int | None = None
        try:
            raw_args = record.get("args")
            if not isinstance(raw_args, dict):
                raw_args = json.loads(str(record.get("args_json", "{}")))
            board_id = raw_args.get("board_id")
            if board_id is not None and (
                not isinstance(board_id, str) or re.fullmatch(r"[a-z0-9_]{1,64}", board_id) is None
            ):
                raise ValueError("command board id is invalid")
            max_seconds = _optional_positive_int(
                raw_args.get("max_seconds"), name="max_seconds", maximum=24 * 60 * 60
            )
            max_posts = _optional_positive_int(
                raw_args.get("max_posts"), name="max_posts", maximum=500
            )
            if not resuming:
                (self.profile.state_dir / _CURRENT_RUN_PAUSED).unlink(missing_ok=True)
            report = self._execute_action(
                action,
                command_id,
                run_id,
                command_id=command_id,
                board_id=board_id,
                max_seconds=max_seconds,
                max_posts=max_posts,
                progress_offset=progress_offset,
            )
            command_report_dir = self.profile.report_dir / "commands"
            command_report_dir.mkdir(parents=True, exist_ok=True)
            (command_report_dir / f"{command_id}.json").write_text(
                json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            state, safe_code, finish_payload = self._result(action, report)
            finish_payload["counters"] = _sum_collection_counters(
                finish_payload["counters"], progress_offset
            )
        except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
            state = "failed"
            safe_code = "archive_locked" if _is_archive_locked(error) else "runner_failed"
            self._write_command_diagnostics(command_id, action, error)
            finish_payload = self._finish_payload(state, safe_code, progress_offset)
        terminal = self.store.finish_command(
            command_id,
            state,
            safe_code,
            result_payload=finish_payload,
        )
        publishes_changes = action in {
            "sync-now",
            "full-content",
            "fill-missing-content",
            "retry-batch",
        } or (action == "full-catalog" and finish_payload["counters"]["changed_posts"] > 0)
        if publishes_changes and finish_payload["counters"]["changed_posts"]:
            self._write_publish_marker()
        if action in {"sync-now", "full-catalog"} and report:
            self._board_summaries(report)
        elif (
            action
            in {
                "full-content",
                "fill-missing-content",
                "retry-batch",
            }
            and self.profile.archive.is_file()
        ):
            with archive_transaction(self.profile.archive, read_only=True) as connection:
                if board_id:
                    board_ids = [board_id]
                else:
                    board_ids = [
                        str(row["board_id"])
                        for row in connection.execute(
                            "SELECT board_id FROM boards WHERE is_enabled = 1 ORDER BY board_id"
                        )
                    ]
            self._board_summaries(
                {
                    "boards": [
                        {
                            "board_id": item,
                            "status": str(report.get("status", "failed")),
                            "outcomes": {},
                            "scheduled_posts": 0,
                        }
                        for item in board_ids
                    ]
                },
                last_outcome=(
                    "partial" if report.get("stop_reason") == "schedule_paused" else None
                ),
            )
        self._event(
            run_id,
            1,
            action,
            state,
            finish_payload["counters"],
            safe_message=safe_code,
        )
        if action in {
            "sync-now",
            "full-catalog",
            "full-content",
            "fill-missing-content",
            "retry-batch",
        }:
            self._archive_snapshot_event(run_id, 2)
        delivery = self._send(
            "run_finish",
            f"/api/v1/runner/runs/{run_id}/finish",
            finish_payload,
            f"finish-{command_id}",
        )
        self._finish_command_reporting(command_id, delivery)
        self._heartbeat(
            "paused" if (self.profile.state_dir / "schedule.paused").exists() else "idle"
        )
        return {
            "ok": state == "succeeded" or report.get("stop_reason") == "schedule_paused",
            "status": terminal["state"],
            "command_id": command_id,
        }

    def _execute_action(
        self,
        action: str,
        report_id: str,
        run_id: str,
        *,
        command_id: str | None = None,
        board_id: str | None = None,
        max_seconds: int | None = None,
        max_posts: int | None = None,
        progress_offset: dict[str, int] | None = None,
        reconcile_attempt: int = 0,
        pending_recovery_checked: bool = False,
    ) -> dict[str, Any]:
        crawl_actions = {
            "sync-now",
            "full-catalog",
            "full-content",
            "fill-missing-content",
            "retry-batch",
        }
        if action in crawl_actions and self._disk_stop_reached():
            return {
                "ok": False,
                "status": "failed",
                "safe_code": "disk_low",
                "stop_reason": "disk_low",
            }
        command_reports = self.profile.report_dir / "commands"
        command_reports.mkdir(parents=True, exist_ok=True)
        report_path = command_reports / f"{report_id}.json"
        if action in {"sync-now", "full-catalog"}:
            inventory_started_at = None
            if action == "full-catalog":
                inventory_started_at = self._ensure_inventory_pass_started(board_id)
            command = [
                sys.executable,
                "-m",
                "scripts.crawl_cycle",
                "--archive",
                str(self.profile.archive),
                "--session",
                str(self.profile.session),
                "--warc-dir",
                str(self.profile.warc_dir),
                "--report-dir",
                str(self.profile.report_dir / "cycles"),
                "--output",
                str(report_path),
            ]
            pause_file = self.profile.state_dir / (
                "schedule.paused" if command_id is None else _CURRENT_RUN_PAUSED
            )
            command.extend(
                (
                    "--pause-file",
                    str(pause_file),
                    "--disk-stop-bytes",
                    str(self.profile.disk_stop_bytes),
                )
            )
            if board_id:
                command.extend(("--board", board_id))
            if max_seconds is not None:
                command.extend(("--max-seconds", str(max_seconds)))
            if max_posts is not None:
                command.extend(("--max-posts", str(max_posts)))
            if action == "full-catalog":
                command.extend(
                    (
                        "--inventory",
                        "--inventory-since",
                        str(inventory_started_at),
                        "--listing-only",
                    )
                )
            reports: list[dict[str, Any]] = []
            auth_retried = False
            outage_retries = 0
            stuck_cycles = 0
            previous_signature: tuple[int, int] | None = None
            crawl_step = "full-catalog" if action == "full-catalog" else "crawling"
            while True:
                if reports and self._disk_stop_reached():
                    combined = self._combined_collection_report(reports)
                    combined.update(
                        ok=False,
                        status="partial",
                        safe_code="disk_low",
                        stop_reason="disk_low",
                        inventory_pass_complete=False,
                    )
                    return self._with_inventory_coverage(
                        combined, str(inventory_started_at), board_id
                    )
                report = self._execute_report(
                    command, report_path, run_id, crawl_step, command_id=command_id
                )
                reports.append(report)
                # Multi-day outage auto-continue must not retain every cycle report in memory.
                if len(reports) > 16:
                    reports[:] = [self._combined_collection_report(reports)]
                if report.get("stop_reason") == "schedule_paused":
                    return self._with_inventory_coverage(
                        self._combined_collection_report(reports),
                        str(inventory_started_at),
                        board_id,
                    )
                if action != "full-catalog":
                    return report
                self._board_summaries(report)
                progress = _sum_collection_counters(
                    _collection_counters(self._combined_collection_report(reports)),
                    progress_offset,
                )
                if command_id is not None:
                    self.store.update_progress(command_id, progress)
                self._archive_snapshot_event(run_id, self._next_progress_sequence(run_id), progress)
                if self._inventory_pass_complete(str(inventory_started_at), board_id):
                    self._complete_inventory_pass(str(inventory_started_at), board_id)
                    catalog_report = self._with_inventory_coverage(
                        self._combined_collection_report(reports),
                        str(inventory_started_at),
                        board_id,
                    )
                    catalog_report.update(
                        ok=True,
                        status="succeeded",
                        safe_code="full_catalog_succeeded",
                    )
                    if max_seconds is not None:
                        return catalog_report
                    with archive_transaction(self.profile.archive, read_only=True) as connection:
                        frontier_exists = connection.execute(
                            "SELECT EXISTS (SELECT 1 FROM crawl_frontier WHERE "
                            + ("board_id = ? AND " if board_id else "")
                            + "rowid > 0)",
                            (board_id,) if board_id else (),
                        ).fetchone()[0]
                    if not frontier_exists:
                        return catalog_report
                    content_report = self._execute_action(
                        "fill-missing-content",
                        f"{report_id}-content",
                        run_id,
                        command_id=command_id,
                        board_id=board_id,
                        max_posts=max_posts,
                        progress_offset=progress_offset,
                    )
                    combined = self._with_inventory_coverage(
                        self._combined_collection_report([catalog_report, content_report]),
                        str(inventory_started_at),
                        board_id,
                    )
                    combined["inventory_pass_complete"] = True
                    if (
                        content_report.get("ok") is True
                        and content_report.get("status") == "succeeded"
                    ):
                        combined.update(
                            ok=True,
                            status="succeeded",
                            safe_code="full_catalog_content_succeeded",
                        )
                    return combined
                # Ops-bounded catalog (max_seconds set) is one inventory cycle only. The
                # multi-cycle while-loop is for multi-hour unattended passes; reusing the
                # per-cycle budget as a loop would run for days despite the operator cap.
                if max_seconds is not None:
                    combined = self._combined_collection_report(reports)
                    combined["inventory_pass_complete"] = False
                    return self._with_inventory_coverage(
                        combined, str(inventory_started_at), board_id
                    )
                status = str(report.get("status", "failed"))
                backoff = REDSTM_FULL_CATALOG_OUTAGE_BACKOFF_SECONDS
                if status == "auth_failed" and not auth_retried:
                    # The next cycle's preflight performs a throttled re-login; one free retry
                    # covers routine session expiry during a multi-hour pass.
                    auth_retried = True
                    continue
                # Origin outage / rate limit / residual auth failure: keep the pass marker and
                # durable inventory_next_page cursors; wait and resume indefinitely. Closing the
                # command would force an operator re-click despite recoverable progress.
                if status in {"site_unreachable", "rate_limited", "auth_failed"}:
                    delay = backoff[min(outage_retries, len(backoff) - 1)]
                    outage_retries += 1
                    time.sleep(delay)
                    continue
                if status in {"runner_failed", "failed"}:
                    combined = self._combined_collection_report(reports)
                    combined["inventory_pass_complete"] = False
                    return self._with_inventory_coverage(
                        combined, str(inventory_started_at), board_id
                    )
                signature = self._inventory_progress_signature(board_id)
                if signature is not None and signature == previous_signature:
                    stuck_cycles += 1
                    if stuck_cycles >= REDSTM_FULL_CATALOG_STUCK_CYCLES:
                        combined = self._combined_collection_report(reports)
                        combined.update(
                            ok=False,
                            status="failed",
                            safe_code="full_catalog_no_progress",
                            inventory_pass_complete=False,
                        )
                        return self._with_inventory_coverage(
                            combined, str(inventory_started_at), board_id
                        )
                    delay = backoff[min(stuck_cycles - 1, len(backoff) - 1)]
                    time.sleep(delay)
                    continue
                previous_signature = signature
                stuck_cycles = 0
                # Page progress after an outage resets the outage budget so a later multi-hour
                # dribble still gets the full stepped backoff curve.
                outage_retries = 0
        if action in {"full-content", "fill-missing-content", "retry-batch"}:
            full_content_checkpoint = (
                self._ensure_full_content_pass_started(board_id)
                if action == "full-content"
                else None
            )
            recovery_max_posts = (
                max_posts
                if max_posts is not None
                else (
                    REDSTM_FULL_CONTENT_MAX_POSTS
                    if action == "full-content"
                    else REDSTM_RECOVERY_MAX_POSTS
                )
            )
            command = [
                sys.executable,
                "-m",
                "scripts.recover_queue",
                "--archive",
                str(self.profile.archive),
                "--session",
                str(self.profile.session),
                "--warc-dir",
                str(self.profile.warc_dir),
                "--max-posts",
                str(recovery_max_posts),
                "--output",
                str(report_path),
            ]
            pause_file = self.profile.state_dir / (
                "schedule.paused" if command_id is None else _CURRENT_RUN_PAUSED
            )
            command.extend(("--pause-file", str(pause_file)))
            if max_seconds is not None:
                command.extend(("--max-seconds", str(max_seconds)))
            if board_id:
                command.extend(("--board", board_id))
            if action == "full-content":
                assert full_content_checkpoint is not None
                command.extend(
                    (
                        "--full-content-before",
                        full_content_checkpoint[0],
                        "--full-content-max-rowid",
                        str(full_content_checkpoint[1]),
                    )
                )
            elif action == "fill-missing-content":
                command.append("--missing-only")
            reports = []
            auth_retried = False
            outage_retries = 0
            previous_remaining: int | None = None
            recovery_step = (
                "full-content"
                if action == "full-content"
                else "fill-missing-content"
                if action == "fill-missing-content"
                else "recovery"
            )
            while True:
                if reports and self._disk_stop_reached():
                    combined = self._combined_collection_report(reports)
                    combined.update(
                        ok=False,
                        status="partial",
                        safe_code="disk_low",
                        stop_reason="disk_low",
                    )
                    return combined
                cycle_command = command
                if outage_retries:
                    cycle_command = command.copy()
                    cycle_command[cycle_command.index("--max-posts") + 1] = "1"
                report = self._execute_report(
                    cycle_command, report_path, run_id, recovery_step, command_id=command_id
                )
                reports.append(report)
                if len(reports) > 16:
                    reports[:] = [self._combined_collection_report(reports)]
                if report.get("stop_reason") == "schedule_paused":
                    return self._combined_collection_report(reports)
                progress = _sum_collection_counters(
                    _collection_counters(self._combined_collection_report(reports)),
                    progress_offset,
                )
                if command_id is not None:
                    self.store.update_progress(command_id, progress)
                self._archive_snapshot_event(run_id, self._next_progress_sequence(run_id), progress)
                status = str(report.get("status", "failed"))
                if status == "auth_failed" and not auth_retried:
                    if max_seconds is not None:
                        return self._combined_collection_report(reports)
                    auth_retried = True
                    continue
                if status in {"site_unreachable", "rate_limited", "auth_failed"}:
                    if max_seconds is not None:
                        return self._combined_collection_report(reports)
                    backoff = REDSTM_FULL_CATALOG_OUTAGE_BACKOFF_SECONDS
                    delay = backoff[min(outage_retries, len(backoff) - 1)]
                    outage_retries += 1
                    time.sleep(delay)
                    continue
                if status in {"runner_failed", "failed"}:
                    return self._combined_collection_report(reports)
                failure_codes = report.get("failures")
                network_outage = (
                    isinstance(failure_codes, list) and "network_error" in failure_codes
                )
                if (
                    network_outage
                    and max_seconds is None
                    and not (action == "full-content" and report.get("full_content_remaining") == 0)
                ):
                    backoff = REDSTM_FULL_CATALOG_OUTAGE_BACKOFF_SECONDS
                    delay = backoff[min(outage_retries, len(backoff) - 1)]
                    outage_retries += 1
                    time.sleep(delay)
                else:
                    outage_retries = 0
                if action in {"fill-missing-content", "retry-batch"}:
                    if _integer(report.get("selected_posts")) == 0:
                        combined = self._combined_collection_report(reports)
                        if _collection_counters(combined)["failed_posts"]:
                            combined.update(
                                ok=False,
                                status="partial",
                                safe_code="content_retry_deferred",
                            )
                            return combined
                        combined.update(
                            ok=True,
                            status="succeeded",
                            safe_code=(
                                "missing_content_succeeded"
                                if action == "fill-missing-content"
                                else "recovery_succeeded"
                            ),
                        )
                        return combined
                    if max_seconds is not None:
                        return self._combined_collection_report(reports)
                    continue
                remaining = report.get("full_content_remaining")
                if remaining == 0:
                    self._full_content_marker(board_id).unlink(missing_ok=True)
                    combined = self._combined_collection_report(reports)
                    has_item_failures = False
                    for item in reports:
                        raw_outcomes = item.get("outcomes")
                        outcomes = raw_outcomes if isinstance(raw_outcomes, dict) else {}
                        if (
                            _integer(item.get("failed_posts"))
                            or _integer(outcomes.get("parse_failed"))
                            or _integer(outcomes.get("fetch_failed"))
                            or bool(item.get("failures"))
                        ):
                            has_item_failures = True
                            break
                    if not has_item_failures:
                        combined.update(
                            ok=True,
                            status="succeeded",
                            safe_code="full_content_succeeded",
                        )
                    else:
                        combined.update(ok=False, status="partial")
                    combined["full_content_complete"] = not has_item_failures
                    combined["full_content_remaining"] = 0
                    return combined
                if (
                    type(remaining) is not int
                    or remaining < 1
                    or (previous_remaining is not None and remaining >= previous_remaining)
                ):
                    raise RuntimeError("full-content checkpoint made no progress")
                previous_remaining = remaining
        marker = self.profile.state_dir / "publish.pending"
        recovery_only = (
            not pending_recovery_checked
            and (self.profile.static_root / ".publish-smoke.pending.json").is_file()
        )
        if recovery_only:
            publish = [
                sys.executable,
                "-m",
                "scripts.publish_static",
                str(self.profile.static_root),
                "--remote",
                self.profile.remote,
                "--reconcile-smoke",
            ]
        else:
            export_report = report_path.with_suffix(".export.json")
            export = [
                sys.executable,
                "-m",
                "scripts.export_static",
                "export",
                str(self.profile.archive),
                "--output",
                str(self.profile.static_root),
                "--workers",
                str(REDSTM_EXPORT_WORKERS),
                "--max-changed-posts",
                str(REDSTM_EXPORT_MAX_CHANGED_POSTS),
                "--incremental-only",
            ]
            export_return_code = self._wait(
                export, run_id, "exporting", stdout=export_report, command_id=command_id
            )
            if export_return_code != 0:
                try:
                    export_failure = self._read_report(export_report)
                except OSError, ValueError, json.JSONDecodeError:
                    export_failure = {}
                if (
                    export_return_code == 2
                    and export_failure.get("status") == "partial"
                    and str(export_failure.get("safe_code", "")).startswith("incremental_")
                ):
                    return export_failure
                return {"ok": False, "status": "failed", "safe_code": "export_failed"}
            publish = [
                sys.executable,
                "-m",
                "scripts.publish_static",
                str(self.profile.static_root),
                "--remote",
                self.profile.remote,
                "--verified-incremental",
            ]
        publish_return_code = self._wait(
            publish, run_id, "publishing", stdout=report_path, command_id=command_id
        )
        if publish_return_code != 0:
            try:
                publish_failure = self._read_report(report_path)
            except OSError, ValueError, json.JSONDecodeError:
                publish_failure = {}
            if (
                publish_return_code == 2
                and publish_failure.get("status") == "partial"
                and str(publish_failure.get("safe_code", "")).startswith("incremental_")
            ):
                return publish_failure
            return {"ok": False, "status": "failed", "safe_code": "publish_failed"}
        report = self._read_report(report_path)
        if report.get("ok") is not True:
            return report
        if recovery_only and report.get("pending_smoke") is False:
            return self._execute_action(
                action,
                report_id,
                run_id,
                command_id=command_id,
                reconcile_attempt=reconcile_attempt,
                pending_recovery_checked=True,
            )
        release_key = report.get("release_key")
        release_match = (
            re.fullmatch(r"releases/([0-9a-f]{64})\.json", release_key)
            if isinstance(release_key, str)
            else None
        )
        deferred_release_key = report.get("deferred_release_key")
        deferred_match = (
            re.fullmatch(r"releases/([0-9a-f]{64})\.json", deferred_release_key)
            if isinstance(deferred_release_key, str)
            else None
        )
        smoke_marker_release_key = report.get("smoke_marker_release_key", release_key)
        smoke_marker_match = (
            re.fullmatch(r"releases/([0-9a-f]{64})\.json", smoke_marker_release_key)
            if isinstance(smoke_marker_release_key, str)
            else None
        )
        rollback_already_active = report.get("rollback_already_active") is True
        if (
            release_match is None
            or (
                deferred_release_key is not None
                and (
                    deferred_match is None
                    or deferred_release_key == release_key
                    or report.get("activation_pending_smoke") is not True
                )
            )
            or smoke_marker_match is None
            or (
                rollback_already_active
                and (
                    not recovery_only
                    or smoke_marker_release_key == release_key
                    or report.get("activation_pending_smoke") is not True
                )
            )
        ):
            result: dict[str, Any] = {
                "ok": False,
                "status": "failed",
                "safe_code": "publish_report_invalid",
            }
        else:
            release_sha256 = release_match.group(1)
            smoke = [
                sys.executable,
                "-m",
                "scripts.release_smoke",
                "--expected-release-sha256",
                release_sha256,
            ]
            if (
                self._wait(
                    smoke,
                    run_id,
                    "smoking",
                    stdout=report_path,
                    command_id=command_id,
                )
                == 0
            ):
                if report.get("activation_pending_smoke") is True:
                    try:
                        self._confirm_publish_smoke(str(smoke_marker_release_key))
                    except OSError, ValueError, json.JSONDecodeError:
                        result = {
                            "ok": False,
                            "status": "failed",
                            "safe_code": "publish_smoke_confirmation_failed",
                            "attempted_release_key": smoke_marker_release_key,
                            "release_smoke_verified": True,
                        }
                    else:
                        result = {
                            **report,
                            "status": "succeeded",
                            "release_smoke_verified": True,
                            "activation_pending_smoke": False,
                            "activation_smoke_confirmed": True,
                        }
                else:
                    result = {**report, "status": "succeeded", "release_smoke_verified": True}
                if result.get("ok") is True and rollback_already_active:
                    result = {
                        "ok": False,
                        "status": "failed",
                        "safe_code": "publish_smoke_failed_rolled_back",
                        "attempted_release_key": smoke_marker_release_key,
                        "previous_release_key": release_key,
                        "rollback_pointer_verified": True,
                        "rollback_smoke_verified": True,
                    }
                elif result.get("ok") is True and recovery_only:
                    reconciled = self._execute_action(
                        action,
                        report_id,
                        run_id,
                        command_id=command_id,
                        reconcile_attempt=reconcile_attempt,
                        pending_recovery_checked=True,
                    )
                    reconciled["preexisting_activation_reconciled"] = True
                    report_path.write_text(
                        json.dumps(reconciled, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    return reconciled
                elif result.get("ok") is True and deferred_match is not None:
                    if reconcile_attempt >= 1:
                        self._write_publish_marker()
                        result = {
                            "ok": False,
                            "status": "failed",
                            "safe_code": "publish_reconciliation_limit",
                            "release_smoke_verified": True,
                            "reconciled_release_key": release_key,
                            "deferred_release_key": deferred_release_key,
                        }
                    else:
                        reconciled = self._execute_action(
                            action,
                            report_id,
                            run_id,
                            command_id=command_id,
                            reconcile_attempt=reconcile_attempt + 1,
                            pending_recovery_checked=True,
                        )
                        reconciled["preexisting_activation_reconciled"] = True
                        report_path.write_text(
                            json.dumps(reconciled, sort_keys=True) + "\n",
                            encoding="utf-8",
                        )
                        return reconciled
            else:
                pointer_changed = report.get("mode") in {"delta", "publish"} or (
                    report.get("mode") == "noop"
                    and (
                        report.get("activation_pending_smoke") is True
                        or report.get("ledger_recovered") is True
                    )
                )
                previous_release_key = report.get("previous_release_key")
                previous_match = (
                    re.fullmatch(r"releases/([0-9a-f]{64})\.json", previous_release_key)
                    if pointer_changed
                    and report.get("previous_release_verified") is True
                    and isinstance(previous_release_key, str)
                    else None
                )
                result = {
                    "ok": False,
                    "status": "failed",
                    "safe_code": (
                        "publish_rollback_unavailable"
                        if pointer_changed
                        else "publish_smoke_failed"
                    ),
                    "attempted_release_key": release_key,
                    "previous_release_key": previous_release_key if previous_match else None,
                    "rollback_pointer_verified": False,
                    "rollback_smoke_verified": False,
                }
                if rollback_already_active:
                    result.update(
                        {
                            "safe_code": "publish_rollback_smoke_failed",
                            "attempted_release_key": smoke_marker_release_key,
                            "previous_release_key": release_key,
                            "rollback_pointer_verified": True,
                        }
                    )
                if previous_match is not None:
                    rollback = [
                        sys.executable,
                        "-m",
                        "scripts.publish_static",
                        str(self.profile.static_root),
                        "--remote",
                        self.profile.remote,
                        "--activate",
                        str(previous_release_key),
                        "--expected-current",
                        str(release_key),
                    ]
                    if (
                        self._wait(
                            rollback,
                            run_id,
                            "rolling_back",
                            stdout=report_path,
                            command_id=command_id,
                        )
                        != 0
                    ):
                        result["safe_code"] = "publish_rollback_failed"
                    else:
                        result["rollback_pointer_verified"] = True
                        rollback_smoke = [
                            sys.executable,
                            "-m",
                            "scripts.release_smoke",
                            "--expected-release-sha256",
                            previous_match.group(1),
                        ]
                        if (
                            self._wait(
                                rollback_smoke,
                                run_id,
                                "rollback_smoking",
                                stdout=report_path,
                                command_id=command_id,
                            )
                            == 0
                        ):
                            result["rollback_smoke_verified"] = True
                            if report.get("activation_pending_smoke") is True:
                                try:
                                    self._confirm_publish_smoke(str(smoke_marker_release_key))
                                except OSError, ValueError, json.JSONDecodeError:
                                    result["safe_code"] = "publish_rollback_confirmation_failed"
                                else:
                                    result["safe_code"] = "publish_smoke_failed_rolled_back"
                            else:
                                result["safe_code"] = "publish_smoke_failed_rolled_back"
                        else:
                            result["safe_code"] = "publish_rollback_smoke_failed"
        report_path.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
        if result.get("ok") is True:
            marker.unlink(missing_ok=True)
        return result

    def _inventory_due(self) -> bool:
        started = self.profile.state_dir / _INVENTORY_STARTED
        if started.exists():
            return True
        completed_at = self._inventory_marker_time(
            self.profile.state_dir / _INVENTORY_COMPLETED,
            "completed_at",
        )
        return completed_at is None or datetime.now(UTC) - completed_at >= timedelta(
            seconds=_WEEKLY_INTERVAL_SECONDS
        )

    def _next_progress_sequence(self, run_id: str) -> int:
        counter = self._progress_sequences.setdefault(
            run_id,
            itertools.count(max(_PROGRESS_EVENT_SEQUENCE_BASE, time.time_ns() // 1_000)),
        )
        return next(counter)

    def _inventory_progress_signature(self, board_id: str | None) -> tuple[int, int] | None:
        if not self.profile.archive.is_file():
            return None
        board_filter = " AND board_id = ?" if board_id is not None else ""
        parameters: tuple[object, ...] = (board_id,) if board_id is not None else ()
        try:
            with archive_transaction(self.profile.archive, read_only=True) as connection:
                row = connection.execute(
                    f"""
                    SELECT COALESCE(SUM(inventory_next_page), 0) AS pages,
                           COALESCE(SUM(inventory_next_page = 1
                                        AND last_inventory_at IS NOT NULL), 0) AS completed
                    FROM boards WHERE is_enabled = 1{board_filter}
                    """,
                    parameters,
                ).fetchone()
        except sqlite3.Error:
            return None
        if row is None:
            return None
        return (int(row["pages"]), int(row["completed"]))

    def _inventory_pass_complete(self, started_at: str, board_id: str | None = None) -> bool:
        if not self.profile.archive.is_file():
            return False
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            board_filter = " AND board_id = ?" if board_id is not None else ""
            parameters: tuple[object, ...] = (started_at,)
            if board_id is not None:
                parameters += (board_id,)
            row = connection.execute(
                f"""
                SELECT COUNT(*) AS total,
                    SUM(
                        last_inventory_at IS NULL
                        OR julianday(last_inventory_at) IS NULL
                        OR julianday(last_inventory_at) < julianday(?)
                        OR inventory_next_page <> 1
                    ) AS incomplete
                FROM boards WHERE is_enabled = 1{board_filter}
                """,
                parameters,
            ).fetchone()
        return bool(row and int(row["total"]) > 0 and int(row["incomplete"] or 0) == 0)

    def _inventory_coverage_snapshot(
        self, started_at: str, board_id: str | None = None
    ) -> dict[str, int]:
        if not self.profile.archive.is_file():
            return {
                "inventory_total_boards": 0,
                "inventory_completed_boards": 0,
                "inventory_in_progress_boards": 0,
                "inventory_pending_boards": 0,
            }
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            board_filter = " AND board_id = ?" if board_id is not None else ""
            parameters: tuple[object, ...] = (started_at,)
            if board_id is not None:
                parameters += (board_id,)
            row = connection.execute(
                f"""
                SELECT COUNT(*) AS total,
                    COALESCE(SUM(
                        last_inventory_at IS NOT NULL
                        AND julianday(last_inventory_at) IS NOT NULL
                        AND julianday(last_inventory_at) >= julianday(?)
                        AND inventory_next_page = 1
                    ), 0) AS completed,
                    COALESCE(SUM(inventory_next_page > 1), 0) AS in_progress
                FROM boards WHERE is_enabled = 1{board_filter}
                """,
                parameters,
            ).fetchone()
        total = int(row["total"] or 0) if row is not None else 0
        completed = int(row["completed"] or 0) if row is not None else 0
        in_progress = int(row["in_progress"] or 0) if row is not None else 0
        return {
            "inventory_total_boards": total,
            "inventory_completed_boards": completed,
            "inventory_in_progress_boards": in_progress,
            "inventory_pending_boards": max(total - completed - in_progress, 0),
        }

    def _with_inventory_coverage(
        self,
        report: dict[str, Any],
        started_at: str,
        board_id: str | None = None,
    ) -> dict[str, Any]:
        report = dict(report)
        report.update(self._inventory_coverage_snapshot(started_at, board_id))
        if "inventory_pass_complete" not in report:
            report["inventory_pass_complete"] = self._inventory_pass_complete(started_at, board_id)
        return report

    def _ensure_inventory_pass_started(self, board_id: str | None = None) -> str:
        marker = self.profile.state_dir / _INVENTORY_STARTED
        payload = self._marker_payload(marker)
        existing = self._inventory_marker_time(marker, "started_at")
        if payload is not None and existing is not None and payload.get("board_id") == board_id:
            return existing.isoformat(timespec="seconds").replace("+00:00", "Z")
        # A checkpoint with another scope belongs to an earlier interrupted command whose
        # own record is already closed; the freshly requested scope supersedes it. Commands
        # are serialized behind control.lock, so this never clobbers an active pass.
        started_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        with archive_transaction(self.profile.archive) as connection:
            where = "board_id = ? AND is_enabled = 1" if board_id else "is_enabled = 1"
            parameters = (board_id,) if board_id else ()
            cursor = connection.execute(
                f"UPDATE boards SET inventory_next_page = 1 WHERE {where}", parameters
            )
            if board_id is not None and cursor.rowcount != 1:
                raise ValueError("board is missing or disabled")
        self._write_inventory_marker(marker, {"started_at": started_at, "board_id": board_id})
        return started_at

    def _complete_inventory_pass(self, started_at: str, board_id: str | None = None) -> None:
        with archive_transaction(self.profile.archive) as connection:
            board_filter = " AND board_id = ?" if board_id is not None else ""
            parameters: tuple[object, ...] = (board_id,) if board_id is not None else ()
            connection.execute(
                f"""
                UPDATE boards
                SET incremental_anchor_post_id = COALESCE(
                        (SELECT MAX(frontier.external_post_id)
                         FROM crawl_frontier AS frontier
                         WHERE frontier.board_id = boards.board_id),
                        incremental_anchor_post_id
                    ),
                    last_incremental_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE is_enabled = 1{board_filter}
                """,
                parameters,
            )
        self._write_inventory_marker(
            self.profile.state_dir / _INVENTORY_COMPLETED,
            {
                "started_at": started_at,
                "completed_at": _timestamp(),
                "board_id": board_id,
            },
        )
        (self.profile.state_dir / _INVENTORY_STARTED).unlink(missing_ok=True)

    def _ensure_full_content_pass_started(self, board_id: str | None) -> tuple[str, int]:
        marker = self._full_content_marker(board_id)
        payload = self._marker_payload(marker)
        if payload is not None:
            started_at = payload.get("started_at")
            max_rowid = payload.get("max_rowid")
            if (
                payload.get("board_id") == board_id
                and isinstance(started_at, str)
                and type(max_rowid) is int
                and max_rowid >= 0
            ):
                return started_at, max_rowid
            # An invalid or differently scoped checkpoint belongs to an earlier
            # interrupted command whose record is already closed; the freshly requested
            # scope starts its own pass instead of wedging every future full-content
            # command behind the stale marker.
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            board_filter = " WHERE board_id = ?" if board_id is not None else ""
            parameters = (board_id,) if board_id is not None else ()
            max_rowid = int(
                connection.execute(
                    f"SELECT COALESCE(MAX(rowid), 0) FROM crawl_frontier{board_filter}",
                    parameters,
                ).fetchone()[0]
            )
        started_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        self._write_inventory_marker(
            marker,
            {"started_at": started_at, "max_rowid": max_rowid, "board_id": board_id},
        )
        return started_at, max_rowid

    def _full_content_marker(self, board_id: str | None) -> Path:
        return self.profile.state_dir / (
            _FULL_CONTENT_STARTED if board_id is None else f"full-content.{board_id}.started"
        )

    def _latest_inventory_pass_started_at(self) -> str | None:
        for name in (_INVENTORY_STARTED, _INVENTORY_COMPLETED):
            value = self._inventory_marker_time(self.profile.state_dir / name, "started_at")
            if value is not None:
                return value.isoformat(timespec="seconds").replace("+00:00", "Z")
        return None

    @staticmethod
    def _inventory_marker_time(path: Path, field: str) -> datetime | None:
        try:
            if not path.is_file() or path.stat().st_size > 1024:
                return None
            payload = json.loads(path.read_text(encoding="utf-8"))
            if payload.get("schema_version") != 1 or not isinstance(payload.get(field), str):
                return None
            value = datetime.fromisoformat(payload[field].replace("Z", "+00:00"))
        except OSError, ValueError:
            return None
        return value.astimezone(UTC) if value.tzinfo is not None else None

    @staticmethod
    def _marker_payload(path: Path) -> dict[str, object] | None:
        try:
            if not path.is_file() or path.stat().st_size > 1024:
                return None
            payload = json.loads(path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            return None
        return payload if isinstance(payload, dict) and payload.get("schema_version") == 1 else None

    @staticmethod
    def _write_inventory_marker(path: Path, fields: dict[str, object]) -> None:
        partial = path.with_name(f"{path.name}.partial")
        try:
            partial.write_text(
                json.dumps({"schema_version": 1, **fields}, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.replace(partial, path)
        finally:
            partial.unlink(missing_ok=True)

    def _bootstrap_pending(self) -> bool:
        if not self.profile.archive.is_file():
            return False
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            row = connection.execute(
                """
                SELECT EXISTS (
                    SELECT 1 FROM crawl_frontier AS frontier
                    LEFT JOIN posts AS post
                      ON post.board_id = frontier.board_id
                     AND post.external_post_id = frontier.external_post_id
                    WHERE frontier.state IN ('pending', 'running', 'retry')
                      AND post.latest_version_id IS NULL
                    LIMIT 1
                )
                """
            ).fetchone()
        return bool(row and int(row[0]))

    def _execute_report(
        self,
        command: list[str],
        report_path: Path,
        run_id: str,
        step: str,
        *,
        command_id: str | None = None,
    ) -> dict[str, Any]:
        try:
            report_path.unlink(missing_ok=True)
        except OSError:
            return {"ok": False, "status": "failed", "safe_code": "runner_failed"}
        return_code = self._wait(command, run_id, step, command_id=command_id)
        try:
            report = self._read_report(report_path)
        except OSError, ValueError:
            return {"ok": False, "status": "failed", "safe_code": "runner_failed"}
        if return_code not in (0, 2) and report.get("ok") is not True:
            return {"ok": False, "status": "failed", "safe_code": "runner_failed"}
        return report

    def _wait(
        self,
        command: list[str],
        run_id: str,
        step: str,
        *,
        stdout: Path | None = None,
        command_id: str | None = None,
    ) -> int:
        output_handle: BinaryIO | None = stdout.open("wb") if stdout is not None else None
        output: BinaryIO | int = output_handle or subprocess.DEVNULL
        next_snapshot_at = time.monotonic()
        try:
            process = subprocess.Popen(
                command,
                cwd=Path(__file__).resolve().parents[1],
                stdin=subprocess.DEVNULL,
                stdout=output,
            )
            while True:
                try:
                    return_code = process.wait(timeout=30)
                    self._claim_marker()
                    return return_code
                except subprocess.TimeoutExpired:
                    self._claim_marker()
                    if command_id is not None:
                        self.store.touch_command(command_id)
                    self._heartbeat("running", run_id=run_id, step=step, command_id=command_id)
                    now = time.monotonic()
                    if (
                        command_id is not None
                        and step
                        in {
                            "crawling",
                            "full-catalog",
                            "recovery",
                            "full-content",
                            "fill-missing-content",
                        }
                        and now >= next_snapshot_at
                    ):
                        self._archive_snapshot_event(run_id, self._next_progress_sequence(run_id))
                        next_snapshot_at = now + _LIVE_SNAPSHOT_INTERVAL_SECONDS
        finally:
            if output_handle is not None:
                output_handle.close()

    def _claim_marker(self) -> None:
        try:
            self.client.flush(self.store)
            if self.store.stats()["rows"]:
                return
            command = self.client.claim_marker(
                self.profile.runner_id, f"claim-marker-{uuid4().hex}"
            )
            if command is None:
                return
            record = self.store.record_claim(command["command_id"], command["action"])
            self._run_marker(record, str(command["action"]))
        except (
            ControlProtocolError,
            ControlUnavailableError,
            OSError,
            RuntimeError,
            ValueError,
            sqlite3.Error,
        ):
            return

    def _write_command_diagnostics(
        self, command_id: str, action: str, error: BaseException
    ) -> None:
        # Local triage only, never uploaded: /ops carries safe codes exclusively, which
        # left runner_failed commands undiagnosable without journald access. The trace
        # contains paths and exception text, not page bodies, cookies, or credentials.
        try:
            directory = self.profile.report_dir / "commands"
            directory.mkdir(parents=True, exist_ok=True)
            trace = "".join(traceback.format_exception(error))
            (directory / f"{command_id}.error.txt").write_text(
                f"{_timestamp()} {action}\n{trace[-8192:]}",
                encoding="utf-8",
            )
        except OSError:
            return

    @staticmethod
    def _read_report(path: Path) -> dict[str, Any]:
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError("command report is missing or too large")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("command report must be an object")
        return value

    def _confirm_publish_smoke(self, release_key: str) -> None:
        lock = FileLock(str(self.profile.static_root / ".publish.lock"), timeout=0)
        try:
            with lock:
                self._confirm_publish_smoke_locked(release_key)
        except Timeout as error:
            raise ValueError("static publisher is active during smoke confirmation") from error

    def _confirm_publish_smoke_locked(self, release_key: str) -> None:
        marker = self.profile.static_root / ".publish-smoke.pending.json"
        if not marker.is_file() or marker.stat().st_size > 1024 * 1024:
            raise ValueError("publish smoke marker is missing or too large")
        raw = marker.read_bytes()
        value = json.loads(raw)
        release_match = re.fullmatch(r"releases/([0-9a-f]{64})\.json", release_key)
        if (
            not isinstance(value, dict)
            or value.get("schema_version") != 1
            or value.get("remote") != self.profile.remote.rstrip("/")
            or value.get("release_key") != release_key
            or release_match is None
            or type(value.get("remote_bytes")) is not int
            or type(value.get("remote_objects")) is not int
            or value["remote_bytes"] < 0
            or value["remote_objects"] < 0
        ):
            raise ValueError("publish smoke marker is invalid")
        release_path = self.profile.static_root / release_key
        release_body = release_path.read_bytes()
        if hashlib.sha256(release_body).hexdigest() != release_match.group(1):
            raise ValueError("publish smoke release is invalid")
        if marker.read_bytes() != raw:
            raise ValueError("publish smoke marker changed during confirmation")
        marker.unlink()
        if os.name != "nt":
            directory = os.open(marker.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    @staticmethod
    def _combined_collection_report(
        reports: list[dict[str, Any]], *, safe_code: str | None = None
    ) -> dict[str, Any]:
        if not reports:
            raise ValueError("collection reports are required")
        outcomes: dict[str, int] = {}
        boards: dict[str, dict[str, Any]] = {}
        failures: set[str] = set()
        for report in reports:
            raw_outcomes = report.get("outcomes")
            if isinstance(raw_outcomes, dict):
                for name, value in raw_outcomes.items():
                    outcomes[str(name)] = outcomes.get(str(name), 0) + _integer(value)
            raw_boards = report.get("boards")
            if isinstance(raw_boards, list):
                for board in raw_boards:
                    if isinstance(board, dict) and isinstance(board.get("board_id"), str):
                        boards[str(board["board_id"])] = board
            raw_failures = report.get("failures")
            if isinstance(raw_failures, list):
                failures.update(str(code) for code in raw_failures if isinstance(code, str))
        result = dict(reports[-1])
        result.update(
            outcomes=outcomes,
            failures=sorted(failures),
            boards=list(boards.values()),
            selected_posts=sum(_integer(report.get("selected_posts")) for report in reports),
            scheduled_posts=sum(_integer(report.get("scheduled_posts")) for report in reports),
            changed_posts=sum(_collection_counters(report)["changed_posts"] for report in reports),
            failed_posts=sum(_collection_counters(report)["failed_posts"] for report in reports),
        )
        if boards:
            boards_ok = sum(
                1 for board in boards.values() if str(board.get("status")) == "succeeded"
            )
            result.update(boards_ok=boards_ok, boards_failed=len(boards) - boards_ok)
        if safe_code is not None:
            result.update(ok=True, status="succeeded", safe_code=safe_code)
        return result

    def _result(self, action: str, report: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
        raw_status = str(report.get("status", "failed"))
        if report.get("ok") is True:
            state = "succeeded"
        elif raw_status in {"partial", "site_unreachable", "rate_limited", "auth_failed"}:
            state = "partial"
        else:
            state = "failed"
        failure_codes: list[str] = []
        raw_failures = report.get("failures")
        if isinstance(raw_failures, list):
            failure_codes.extend(code for code in raw_failures if isinstance(code, str))
        raw_boards = report.get("boards")
        if isinstance(raw_boards, list):
            for board in raw_boards:
                board_failures = board.get("failures") if isinstance(board, dict) else None
                if isinstance(board_failures, list):
                    failure_codes.extend(code for code in board_failures if isinstance(code, str))
        warning_code = next(
            (_WARNING_CODES[code] for code in failure_codes if code in _WARNING_CODES),
            None,
        )
        if report.get("stop_reason") == "schedule_paused":
            default_code = "schedule_paused"
        elif state == "succeeded":
            default_code = _SUCCESS_CODES[action]
        else:
            default_code = warning_code or _STATUS_CODES.get(raw_status, "run_failed")
        safe_code = str(report.get("safe_code") or default_code)
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", safe_code) is None:
            safe_code = "run_failed"
        counters = _collection_counters(report)
        release_id = None
        release_key = report.get("release_key")
        if isinstance(release_key, str):
            match = re.fullmatch(r"releases/([0-9a-f]{64})\.json", release_key)
            if match:
                release_id = match.group(1)
        return state, safe_code, self._finish_payload(state, safe_code, counters, release_id)

    @staticmethod
    def _finish_payload(
        state: str,
        safe_code: str,
        counters: dict[str, int] | None = None,
        release_id: str | None = None,
        *,
        counters_reported: bool | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "state": state,
            "counters": counters
            or {"changed_posts": 0, "failed_posts": 0, "boards_ok": 0, "boards_failed": 0},
            "safe_summary_code": safe_code,
        }
        if release_id is not None:
            payload["release_id"] = release_id
        if counters_reported is not None:
            payload["counters_reported"] = counters_reported
        return payload

    def _replay_terminal(self, record: dict[str, Any]) -> dict[str, Any]:
        result = json.loads(record["result_json"])
        payload = result.get("payload") if isinstance(result, dict) else None
        if not isinstance(payload, dict):
            payload = self._finish_payload(str(record["state"]), "result_replayed")
        command_id = str(record["command_id"])
        run_id = record.get("run_id")
        if isinstance(run_id, str):
            kind = "run_finish"
            path = f"/api/v1/runner/runs/{run_id}/finish"
        else:
            kind = "command_finish"
            path = f"/api/v1/runner/commands/{command_id}/finish"
        delivery = self._send(kind, path, payload, f"finish-{command_id}")
        self._finish_command_reporting(command_id, delivery)
        return {
            "ok": record["state"] == "succeeded",
            "status": "replayed",
            "command_id": command_id,
        }

    def _event(
        self,
        run_id: str,
        sequence: int,
        step: str,
        state: str,
        counters: dict[str, int] | None = None,
        *,
        safe_message: str | None = None,
    ) -> None:
        payload = {
            "events": [
                {
                    "sequence": sequence,
                    "step": step,
                    "state": state,
                    "recorded_at": _timestamp(),
                    "counters": counters or {},
                    "safe_message": safe_message,
                }
            ]
        }
        self._send(
            "event_batch",
            f"/api/v1/runner/runs/{run_id}/events:batch",
            payload,
            f"event-{run_id}-{sequence}",
        )

    def _board_summaries(
        self,
        report: dict[str, Any],
        *,
        last_outcome: str | None = None,
        include_failures: bool = True,
    ) -> None:
        boards = report.get("boards")
        if not isinstance(boards, list) or not self.profile.archive.is_file():
            return
        inventory_pass_started_at = self._latest_inventory_pass_started_at()
        with archive_transaction(self.profile.archive, read_only=True) as connection:
            for item in boards:
                if not isinstance(item, dict) or not isinstance(item.get("board_id"), str):
                    continue
                item_data: dict[str, Any] = item
                board_id = item_data["board_id"]
                queue = {
                    str(row["state"]): int(row["count"])
                    for row in connection.execute(
                        "SELECT state, COUNT(*) AS count FROM crawl_frontier "
                        "WHERE board_id = ? GROUP BY state",
                        (board_id,),
                    )
                }
                board = connection.execute(
                    """
                    SELECT name, group_name, is_enabled, inventory_next_page,
                           last_inventory_at, incremental_anchor_post_id,
                           last_incremental_at,
                           (SELECT COUNT(*) FROM posts
                            WHERE posts.board_id = boards.board_id
                              AND latest_version_id IS NULL
                              AND availability <> 'missing') AS outline_only
                    FROM boards WHERE board_id = ?
                    """,
                    (board_id,),
                ).fetchone()
                if board is None:
                    continue
                raw_failures = item_data.get("failures")
                failures: list[Any] = raw_failures if isinstance(raw_failures, list) else []
                warning = next(
                    (
                        _WARNING_CODES[code]
                        for code in failures
                        if isinstance(code, str) and code in _WARNING_CODES
                    ),
                    None,
                )
                raw_outcomes = item_data.get("outcomes")
                outcomes: dict[str, Any] = raw_outcomes if isinstance(raw_outcomes, dict) else {}
                status = str(item_data.get("status"))
                payload = {
                    "board_id": board_id,
                    "board_name": str(board["name"]),
                    "group_name": board["group_name"],
                    "last_scanned_at": _timestamp(),
                    "last_outcome": last_outcome
                    or (
                        "succeeded"
                        if status == "succeeded"
                        else "partial"
                        if outcomes
                        else "failed"
                    ),
                    "counters": {
                        "discovered": _integer(item_data.get("scheduled_posts")),
                        "changed": _integer(outcomes.get("stored")),
                        "pending": queue.get("pending", 0),
                        "running": queue.get("running", 0),
                        "retry": queue.get("retry", 0),
                        "done": queue.get("done", 0),
                        "dead": queue.get("dead", 0),
                    },
                    "inventory_next_page": int(board["inventory_next_page"]),
                    "last_inventory_at": _normalized_timestamp(board["last_inventory_at"]),
                    "inventory_pass_started_at": inventory_pass_started_at,
                    "warning_code": warning,
                    "collection_enabled": bool(board["is_enabled"]),
                    "outline_only": int(board["outline_only"]),
                    "incremental_anchor_post_id": board["incremental_anchor_post_id"],
                    "last_incremental_at": _normalized_timestamp(board["last_incremental_at"]),
                }
                self._send(
                    "board_status",
                    "/api/v1/runner/boards/status",
                    payload,
                    f"board-{uuid4().hex}",
                )
                if include_failures:
                    self._frontier_failures(connection, board_id)

    def _frontier_failures(self, connection: sqlite3.Connection, board_id: str) -> None:
        rows = connection.execute(
            """
            SELECT external_post_id, attempts, last_error_code, last_attempt_at
            FROM crawl_frontier
            WHERE board_id = ? AND state = 'dead'
            ORDER BY external_post_id
            """,
            (board_id,),
        ).fetchall()
        generation = f"g-{uuid4().hex}"
        batches = [rows[index : index + 100] for index in range(0, len(rows), 100)] or [[]]
        for index, batch in enumerate(batches):
            self._send(
                "frontier_failures",
                "/api/v1/runner/frontier-failures",
                {
                    "board_id": board_id,
                    "generation": generation,
                    "complete": index == len(batches) - 1,
                    "items": [
                        {
                            "external_post_id": int(row["external_post_id"]),
                            "attempts": int(row["attempts"]),
                            "error_code": _frontier_error_code(row["last_error_code"]),
                            "last_attempt_at": _normalized_timestamp(row["last_attempt_at"]),
                        }
                        for row in batch
                    ],
                },
                f"failures-{generation}-{index}",
            )

    def _archive_snapshot_event(
        self, run_id: str, sequence: int, run_counters: dict[str, int] | None = None
    ) -> None:
        if not self.profile.archive.is_file():
            return
        inventory_started_at = self._latest_inventory_pass_started_at()
        active_inventory: tuple[str, str] | None = None
        finished_inventory: tuple[str, dict[str, Any]] | None = None
        live_run_counters: dict[str, int] | None = None
        try:
            with archive_transaction(self.profile.archive, read_only=True) as connection:
                deadline = time.monotonic() + _SNAPSHOT_TIME_BUDGET_SECONDS
                connection.set_progress_handler(
                    lambda: int(time.monotonic() >= deadline),
                    10_000,
                )
                frontier = {
                    str(row["state"]): int(row["count"])
                    for row in connection.execute(
                        "SELECT state, COUNT(*) AS count FROM crawl_frontier GROUP BY state"
                    )
                }
                outline_only = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) FROM crawl_frontier AS frontier
                        LEFT JOIN posts AS post
                          ON post.board_id = frontier.board_id
                         AND post.external_post_id = frontier.external_post_id
                        WHERE post.latest_version_id IS NULL
                          AND (post.availability IS NULL OR post.availability <> 'missing')
                        """
                    ).fetchone()[0]
                )
                inventory = connection.execute(
                    """
                    SELECT COUNT(*) AS total,
                        SUM(
                            ? IS NOT NULL
                            AND last_inventory_at IS NOT NULL
                            AND julianday(last_inventory_at) >= julianday(?)
                        ) AS completed,
                        SUM(inventory_next_page > 1) AS in_progress
                    FROM boards WHERE is_enabled = 1
                    """,
                    (inventory_started_at, inventory_started_at),
                ).fetchone()
                if run_counters is None:
                    live_run = connection.execute(
                        "SELECT run_id FROM crawl_runs WHERE status = 'running' "
                        "ORDER BY started_at DESC LIMIT 1"
                    ).fetchone()
                    if live_run is not None:
                        outcomes = connection.execute(
                            """
                            SELECT
                                COALESCE(SUM(entity_type = 'post' AND outcome = 'stored'), 0)
                                    AS changed_posts,
                                COALESCE(SUM(outcome IN ('parse_failed', 'fetch_failed')), 0)
                                    AS failed_posts
                            FROM captures WHERE run_id = ?
                            """,
                            (live_run["run_id"],),
                        ).fetchone()
                        live_run_counters = {
                            "changed_posts": int(outcomes["changed_posts"]),
                            "failed_posts": int(outcomes["failed_posts"]),
                            "boards_ok": 0,
                            "boards_failed": 0,
                        }
                active_run = connection.execute(
                    "SELECT run_id FROM crawl_runs "
                    "WHERE kind = 'inventory' AND status = 'running' "
                    "ORDER BY started_at DESC LIMIT 1"
                ).fetchone()
                if active_run is not None:
                    capture = connection.execute(
                        "SELECT url FROM captures WHERE run_id = ? AND entity_type = 'listing' "
                        "ORDER BY id DESC LIMIT 1",
                        (active_run["run_id"],),
                    ).fetchone()
                    if capture is not None:
                        match = re.fullmatch(
                            r"https://www\.typemoon\.net/([a-z0-9_]+)(?:\?.*)?",
                            str(capture["url"]),
                        )
                        if match is not None:
                            active_inventory = (str(active_run["run_id"]), match.group(1))
                if self._live_inventory is not None and self._live_inventory != active_inventory:
                    previous_run_id, previous_board_id = self._live_inventory
                    previous = connection.execute(
                        "SELECT status, discovered, summary_json FROM crawl_runs WHERE run_id = ?",
                        (previous_run_id,),
                    ).fetchone()
                    if previous is not None and str(previous["status"]) != "running":
                        try:
                            summary = json.loads(str(previous["summary_json"]))
                        except ValueError:
                            summary = {}
                        if not isinstance(summary, dict):
                            summary = {}
                        finished_inventory = (
                            previous_board_id,
                            {
                                "status": str(previous["status"]),
                                "scheduled_posts": int(previous["discovered"]),
                                "outcomes": summary.get("outcomes", {}),
                                "failures": summary.get("failures", []),
                            },
                        )
        except sqlite3.Error:
            return
        if finished_inventory is not None:
            board_id, item = finished_inventory
            outcome = str(item["status"])
            self._board_summaries(
                {"boards": [{"board_id": board_id, **item}]},
                last_outcome=outcome if outcome in {"succeeded", "partial", "failed"} else "failed",
            )
        if active_inventory is not None:
            self._board_summaries(
                {
                    "boards": [
                        {
                            "board_id": active_inventory[1],
                            "status": "running",
                            "scheduled_posts": 0,
                            "outcomes": {},
                            "failures": [],
                        }
                    ]
                },
                last_outcome="running",
                include_failures=False,
            )
        self._live_inventory = active_inventory
        live_marker = self.profile.state_dir / _LIVE_INVENTORY
        try:
            if active_inventory is None:
                live_marker.unlink(missing_ok=True)
            else:
                self._write_inventory_marker(
                    live_marker,
                    {"run_id": active_inventory[0], "board_id": active_inventory[1]},
                )
        except OSError:
            pass
        counters = {
            "outline_only": outline_only,
            "frontier_pending": frontier.get("pending", 0),
            "frontier_running": frontier.get("running", 0),
            "frontier_retry": frontier.get("retry", 0),
            "frontier_done": frontier.get("done", 0),
            "frontier_dead": frontier.get("dead", 0),
            "inventory_total_boards": int(inventory["total"]),
            "inventory_completed_boards": int(inventory["completed"] or 0),
            "inventory_in_progress_boards": int(inventory["in_progress"] or 0),
        }
        counters.update(run_counters or live_run_counters or {})
        self._event(run_id, sequence, "archive_snapshot", "succeeded", counters)

    @staticmethod
    def _schedule_timer_active() -> bool:
        try:
            enabled = subprocess.run(
                ["systemctl", "is-enabled", "--quiet", "redstm-schedule.timer"],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            active = subprocess.run(
                ["systemctl", "is-active", "--quiet", "redstm-schedule.timer"],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        except OSError, subprocess.SubprocessError:
            return False
        return enabled.returncode == 0 and active.returncode == 0

    @staticmethod
    def _next_scheduled_at() -> str | None:
        return _installed_next_scheduled_at(_SCHEDULE_TIMER_PATH)

    def _safe_warning(self, disk_free_bytes: int, now: datetime) -> str | None:
        if self.profile.disk_low_bytes and disk_free_bytes < self.profile.disk_low_bytes:
            return "disk_low"
        rejection = self.store.rejection()
        rejected_at = _normalized_timestamp(
            rejection.get("last_rejected_at") if rejection is not None else None
        )
        if self.profile.control_rejection_warning_seconds and rejected_at is not None:
            parsed_rejected_at = datetime.fromisoformat(rejected_at.replace("Z", "+00:00"))
            rejection_age = now.astimezone(UTC) - parsed_rejected_at
            if (
                timedelta(0)
                <= rejection_age
                <= timedelta(seconds=self.profile.control_rejection_warning_seconds)
            ):
                return "control_rejected"
        if (
            self.profile.token_expires_at is not None
            and self.profile.token_expiring_seconds
            and self.profile.token_expires_at.astimezone(UTC) - now
            <= timedelta(seconds=self.profile.token_expiring_seconds)
        ):
            return "token_expiring"
        if self.profile.publish_stale_seconds:
            changed_at: list[datetime] = []
            for marker in (
                self.profile.state_dir / "publish.pending",
                self.profile.static_root / ".publish-smoke.pending.json",
            ):
                try:
                    changed_at.append(datetime.fromtimestamp(marker.stat().st_mtime, UTC))
                except FileNotFoundError:
                    continue
                except OSError:
                    return "publish_stale"
            if changed_at and now - min(changed_at) >= timedelta(
                seconds=self.profile.publish_stale_seconds
            ):
                return "publish_stale"
        return None

    def _heartbeat(
        self,
        state: str,
        *,
        run_id: str | None = None,
        step: str | None = None,
        command_id: str | None = None,
        warning_code: str | None = None,
    ) -> None:
        # Heartbeats are best-effort telemetry; a local failure (disk probe, state DB,
        # timer inspection) must never abort the command or run being reported on.
        try:
            self._heartbeat_once(
                state,
                run_id=run_id,
                step=step,
                command_id=command_id,
                warning_code=warning_code,
            )
        except OSError, RuntimeError, ValueError, sqlite3.Error:
            return

    def _heartbeat_once(
        self,
        state: str,
        *,
        run_id: str | None = None,
        step: str | None = None,
        command_id: str | None = None,
        warning_code: str | None = None,
    ) -> None:
        if state == "idle" and (self.profile.state_dir / "schedule.paused").exists():
            state = "paused"
        disk_free_bytes = shutil.disk_usage(self.profile.state_dir).free
        timer_active = self._schedule_timer_active()
        next_scheduled_at = self._next_scheduled_at() if timer_active else None
        if state == "idle" and timer_active and next_scheduled_at is None:
            state = "degraded"
        payload: dict[str, Any] = {
            "runner_version": self.profile.runner_version,
            "state": state,
            "disk_free_bytes": disk_free_bytes,
            "next_scheduled_at": next_scheduled_at,
            "safe_warning_code": warning_code
            or self._safe_warning(disk_free_bytes, datetime.now(UTC)),
        }
        if state == "running" and self.profile.archive.is_file():
            try:
                with archive_transaction(self.profile.archive, read_only=True) as connection:
                    active = connection.execute(
                        """
                        SELECT board_id, external_post_id FROM crawl_frontier
                        WHERE state = 'running' AND julianday(lease_expires_at) > julianday(?)
                        ORDER BY last_attempt_at DESC LIMIT 1
                        """,
                        (_timestamp(),),
                    ).fetchone()
                    if active is not None:
                        payload["active_board_id"] = str(active["board_id"])
                        payload["active_post_id"] = int(active["external_post_id"])
                    else:
                        # full-catalog --listing-only never claims frontier detail leases, so
                        # the only live board signal is the inventory run's latest listing URL.
                        inventory = connection.execute(
                            """
                            SELECT run_id FROM crawl_runs
                            WHERE kind = 'inventory' AND status = 'running'
                            ORDER BY started_at DESC LIMIT 1
                            """
                        ).fetchone()
                        if inventory is not None:
                            capture = connection.execute(
                                """
                                SELECT url FROM captures
                                WHERE run_id = ? AND entity_type = 'listing'
                                ORDER BY id DESC LIMIT 1
                                """,
                                (inventory["run_id"],),
                            ).fetchone()
                            if capture is not None:
                                match = re.fullmatch(
                                    r"https://www\.typemoon\.net/([a-z0-9_]+)(?:\?.*)?",
                                    str(capture["url"]),
                                )
                                if match is not None:
                                    payload["active_board_id"] = match.group(1)
            except sqlite3.Error:
                pass
        if run_id is not None:
            payload["active_run_id"] = run_id
        if step is not None or run_id is not None:
            payload["active_step"] = step
        if command_id is not None:
            payload.update(
                {
                    "runner_id": self.profile.runner_id,
                    "active_command_id": command_id,
                }
            )
        self._send(
            "heartbeat",
            "/api/v1/runner/heartbeat",
            payload,
            f"heartbeat-{uuid4().hex}",
        )

    def _send(
        self,
        kind: str,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str,
    ) -> DeliveryResult | None:
        try:
            return self.client.send_or_enqueue(self.store, kind, path, payload, idempotency_key)
        except ControlProtocolError, OutboxFullError, OSError, ValueError, sqlite3.Error:
            return None

    def _finish_command_reporting(self, command_id: str, delivery: DeliveryResult | None) -> None:
        if delivery is DeliveryResult.DELIVERED:
            self.store.mark_reported(command_id)
        elif delivery is DeliveryResult.PERMANENTLY_REJECTED:
            self.store.mark_report_rejected(command_id)

    def _write_publish_marker(self) -> None:
        marker = self.profile.state_dir / "publish.pending"
        if marker.exists():
            return
        partial = marker.with_suffix(".partial")
        partial.write_text(f"changed_at={_timestamp()}\n", encoding="utf-8")
        os.replace(partial, marker)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Poll and execute one fixed ReDSTM command.")
    parser.add_argument("--scheduled", action="store_true")
    parser.add_argument("--state-db", type=Path, default=Path("/srv/redstm/state/control.sqlite"))
    parser.add_argument("--state-dir", type=Path, default=Path("/srv/redstm/state"))
    parser.add_argument(
        "--archive", type=Path, default=Path("/srv/redstm/canonical/archive.sqlite")
    )
    parser.add_argument("--session", type=Path, default=Path("/srv/redstm/private/session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path("/srv/redstm/warc"))
    parser.add_argument("--report-dir", type=Path, default=Path("/srv/redstm/reports"))
    parser.add_argument("--static-root", type=Path, default=Path("/srv/redstm/static"))
    parser.add_argument("--remote", default="r2:redstm-archive")
    parser.add_argument("--runner-id", default="oracle-primary")
    parser.add_argument("--runner-version", default=os.environ.get("REDSTM_RUNNER_VERSION", "dev"))
    parser.add_argument(
        "--disk-low-bytes",
        type=_nonnegative_integer,
        default=os.environ.get("REDSTM_DISK_LOW_BYTES", str(_DEFAULT_DISK_LOW_BYTES)),
    )
    parser.add_argument(
        "--disk-stop-bytes",
        type=_nonnegative_integer,
        default=os.environ.get("REDSTM_DISK_STOP_BYTES", str(_DEFAULT_DISK_STOP_BYTES)),
    )
    parser.add_argument(
        "--control-rejection-warning-seconds",
        type=_nonnegative_integer,
        default=os.environ.get(
            "REDSTM_CONTROL_REJECTION_WARNING_SECONDS",
            str(_DEFAULT_CONTROL_REJECTION_WARNING_SECONDS),
        ),
    )
    parser.add_argument(
        "--token-expires-at",
        type=_aware_datetime,
        default=os.environ.get("REDSTM_ACCESS_TOKEN_EXPIRES_AT"),
    )
    parser.add_argument(
        "--token-expiring-seconds",
        type=_nonnegative_integer,
        default=os.environ.get(
            "REDSTM_TOKEN_EXPIRING_SECONDS", str(_DEFAULT_TOKEN_EXPIRING_SECONDS)
        ),
    )
    parser.add_argument(
        "--publish-stale-seconds",
        type=_nonnegative_integer,
        default=os.environ.get("REDSTM_PUBLISH_STALE_SECONDS", str(_DEFAULT_PUBLISH_STALE_SECONDS)),
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    profile = RunnerProfile(
        state_db=args.state_db.expanduser().resolve(),
        state_dir=args.state_dir.expanduser().resolve(),
        archive=args.archive.expanduser().resolve(),
        session=args.session.expanduser().resolve(),
        warc_dir=args.warc_dir.expanduser().resolve(),
        report_dir=args.report_dir.expanduser().resolve(),
        static_root=args.static_root.expanduser().resolve(),
        remote=args.remote,
        runner_id=args.runner_id,
        runner_version=args.runner_version,
        disk_low_bytes=args.disk_low_bytes,
        disk_stop_bytes=args.disk_stop_bytes,
        control_rejection_warning_seconds=args.control_rejection_warning_seconds,
        token_expires_at=args.token_expires_at,
        token_expiring_seconds=args.token_expiring_seconds,
        publish_stale_seconds=args.publish_stale_seconds,
    )
    runner = ControlRunner(
        profile,
        ControlClient.from_environment(allow_offline=args.scheduled),
        ControlStore(profile.state_db),
    )
    report = runner.run_scheduled() if args.scheduled else runner.run_once()
    print(json.dumps(report, sort_keys=True))
    return 0 if report.get("ok") is not False else 2


if __name__ == "__main__":
    raise SystemExit(main())
