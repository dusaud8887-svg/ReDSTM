from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from filelock import FileLock, Timeout

from crawler.archive import connect_archive
from scripts.control_client import (
    ControlClient,
    ControlProtocolError,
    ControlUnavailableError,
)
from scripts.control_store import ControlStore, OutboxFullError

_RUN_KINDS = {
    "sync-now": "manual-sync",
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
_SCHEDULE_HOURS = (0, 6, 12, 18, 24)
_INVENTORY_STARTED = "inventory.started"
_INVENTORY_COMPLETED = "inventory.completed"


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


def _next_scheduled_at(now: datetime | None = None) -> str:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    anchor = current.replace(hour=0, minute=17, second=0, microsecond=0)
    return next(
        (anchor + timedelta(hours=hours)).isoformat(timespec="seconds").replace("+00:00", "Z")
        for hours in _SCHEDULE_HOURS
        if anchor + timedelta(hours=hours) > current
    )


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


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


class ControlRunner:
    def __init__(self, profile: RunnerProfile, client: ControlClient, store: ControlStore) -> None:
        self.profile = profile
        self.client = client
        self.store = store
        self.profile.state_dir.mkdir(parents=True, exist_ok=True)
        self.profile.report_dir.mkdir(parents=True, exist_ok=True)

    def run_once(self) -> dict[str, Any]:
        lock = FileLock(self.profile.state_dir / "control.lock", timeout=0)
        try:
            with lock:
                return self._run_locked()
        except Timeout:
            return {"ok": True, "status": "busy"}

    def run_scheduled(self) -> dict[str, Any]:
        lock = FileLock(self.profile.state_dir / "control.lock", timeout=0)
        try:
            with lock:
                return self._run_scheduled_locked()
        except Timeout:
            return {"ok": True, "status": "busy"}

    def _run_scheduled_locked(self) -> dict[str, Any]:
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
        follow_up = (
            "inventory"
            if self._inventory_due()
            else "bootstrap-recovery"
            if self._bootstrap_pending()
            else "retry-batch"
        )
        for action in ("sync-now", follow_up, "publish-if-changed"):
            self._claim_marker()
            if (self.profile.state_dir / "schedule.paused").exists():
                paused = True
                if state == "succeeded":
                    state = "partial"
                    intentional_pause = True
                break
            if action in {"inventory", "bootstrap-recovery", "retry-batch"} and crawl_status in {
                "site_unreachable",
                "rate_limited",
                "auth_failed",
            }:
                self._event(run_id, sequence, action, "skipped")
                sequence += 1
                continue
            try:
                report = self._execute_action(action, run_id, run_id)
                action_state, safe_code, payload = self._result(action, report)
            except OSError, RuntimeError, ValueError:
                report = {}
                action_state = "failed"
                safe_code = "runner_failed"
                payload = self._finish_payload("failed", "runner_failed")
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
        try:
            self.client.flush(self.store)
        except ControlProtocolError, OSError, ValueError:
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
        record = self.store.record_claim(command["command_id"], command["action"])
        return self._resume(record)

    def _resume(self, record: dict[str, Any]) -> dict[str, Any]:
        state = str(record["state"])
        if state in {"succeeded", "partial", "failed"}:
            return self._replay_terminal(record)
        if state == "running":
            payload = self._finish_payload("failed", "runner_interrupted")
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
            partial = marker.with_suffix(".partial")
            partial.write_text(f"paused_at={_timestamp()}\n", encoding="utf-8")
            os.replace(partial, marker)
        else:
            marker.unlink(missing_ok=True)
        safe_code = _MARKER_CODES[action]
        payload = {
            "runner_id": self.profile.runner_id,
            "state": "succeeded",
            "safe_summary_code": safe_code,
        }
        terminal = self.store.finish_command(
            command_id, "succeeded", safe_code, result_payload=payload
        )
        if self._send(
            "command_finish",
            f"/api/v1/runner/commands/{command_id}/finish",
            payload,
            f"finish-{command_id}",
        ):
            self.store.mark_reported(command_id)
        self._heartbeat("paused" if marker.exists() else "idle")
        return {"ok": True, "status": terminal["state"], "command_id": command_id}

    def _run_process_action(self, record: dict[str, Any], action: str) -> dict[str, Any]:
        command_id = str(record["command_id"])
        run_id = str(record.get("run_id") or f"command-{command_id}")
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
        try:
            report = self._execute_action(action, command_id, run_id, command_id=command_id)
            state, safe_code, finish_payload = self._result(action, report)
        except OSError, RuntimeError, ValueError:
            state = "failed"
            safe_code = "runner_failed"
            finish_payload = self._finish_payload(state, safe_code)
        terminal = self.store.finish_command(
            command_id,
            state,
            safe_code,
            result_payload=finish_payload,
        )
        if action in {"sync-now", "retry-batch"} and finish_payload["counters"]["changed_posts"]:
            self._write_publish_marker()
        if action == "sync-now" and report:
            self._board_summaries(report)
        self._event(
            run_id,
            1,
            action,
            state,
            finish_payload["counters"],
            safe_message=safe_code,
        )
        if action in {"sync-now", "retry-batch"}:
            self._archive_snapshot_event(run_id, 2)
        if self._send(
            "run_finish",
            f"/api/v1/runner/runs/{run_id}/finish",
            finish_payload,
            f"finish-{command_id}",
        ):
            self.store.mark_reported(command_id)
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
    ) -> dict[str, Any]:
        command_reports = self.profile.report_dir / "commands"
        command_reports.mkdir(parents=True, exist_ok=True)
        report_path = command_reports / f"{report_id}.json"
        if action in {"sync-now", "inventory"}:
            inventory_started_at = (
                self._ensure_inventory_pass_started() if action == "inventory" else None
            )
            if action == "inventory" and self._inventory_pass_complete(str(inventory_started_at)):
                self._complete_inventory_pass(str(inventory_started_at))
                return {
                    "ok": True,
                    "status": "succeeded",
                    "safe_code": "inventory_already_complete",
                    "boards": [],
                }
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
                "--pause-file",
                str(self.profile.state_dir / "schedule.paused"),
                "--output",
                str(report_path),
            ]
            if action == "inventory":
                command.extend(
                    (
                        "--inventory",
                        "--inventory-since",
                        str(inventory_started_at),
                        "--max-seconds",
                        str(2 * 60 * 60),
                    )
                )
            report = self._execute_report(
                command, report_path, run_id, "crawling", command_id=command_id
            )
            if (
                action == "inventory"
                and report.get("status") in {"succeeded", "partial"}
                and report.get("stop_reason") != "schedule_paused"
                and self._inventory_pass_complete(str(inventory_started_at))
            ):
                self._complete_inventory_pass(str(inventory_started_at))
            return report
        if action in {"bootstrap-recovery", "retry-batch"}:
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
                "600" if action == "bootstrap-recovery" else "100",
                "--pause-file",
                str(self.profile.state_dir / "schedule.paused"),
                "--output",
                str(report_path),
            ]
            report = self._execute_report(
                command, report_path, run_id, "recovery", command_id=command_id
            )
            return report
        marker = self.profile.state_dir / "publish.pending"
        if not marker.exists():
            return {"ok": True, "status": "succeeded", "safe_code": "publish_no_change"}
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
            "1",
        ]
        if (
            self._wait(export, run_id, "exporting", stdout=export_report, command_id=command_id)
            != 0
        ):
            return {"ok": False, "status": "failed", "safe_code": "export_failed"}
        publish = [
            sys.executable,
            "-m",
            "scripts.publish_static",
            str(self.profile.static_root),
            "--remote",
            self.profile.remote,
        ]
        if (
            self._wait(publish, run_id, "publishing", stdout=report_path, command_id=command_id)
            != 0
        ):
            return {"ok": False, "status": "failed", "safe_code": "publish_failed"}
        report = self._read_report(report_path)
        if report.get("ok") is True:
            marker.unlink(missing_ok=True)
        return report

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

    def _inventory_pass_complete(self, started_at: str) -> bool:
        if not self.profile.archive.is_file():
            return False
        with connect_archive(self.profile.archive, read_only=True) as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS total,
                    SUM(
                        last_inventory_at IS NULL
                        OR julianday(last_inventory_at) IS NULL
                        OR julianday(last_inventory_at) < julianday(?)
                        OR inventory_next_page <> 1
                    ) AS incomplete
                FROM boards WHERE is_enabled = 1
                """,
                (started_at,),
            ).fetchone()
        return bool(row and int(row["total"]) > 0 and int(row["incomplete"] or 0) == 0)

    def _ensure_inventory_pass_started(self) -> str:
        marker = self.profile.state_dir / _INVENTORY_STARTED
        existing = self._inventory_marker_time(marker, "started_at")
        if existing is not None:
            return existing.isoformat(timespec="seconds").replace("+00:00", "Z")
        started_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        self._write_inventory_marker(marker, {"started_at": started_at})
        return started_at

    def _complete_inventory_pass(self, started_at: str) -> None:
        self._write_inventory_marker(
            self.profile.state_dir / _INVENTORY_COMPLETED,
            {"started_at": started_at, "completed_at": _timestamp()},
        )
        (self.profile.state_dir / _INVENTORY_STARTED).unlink(missing_ok=True)

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
    def _write_inventory_marker(path: Path, fields: dict[str, str]) -> None:
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
        with connect_archive(self.profile.archive, read_only=True) as connection:
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
        return_code = self._wait(command, run_id, step, command_id=command_id)
        report = self._read_report(report_path)
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
        try:
            process = subprocess.Popen(
                command,
                cwd=Path(__file__).resolve().parents[1],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
            )
            while True:
                try:
                    return_code = process.wait(timeout=30)
                    self._claim_marker()
                    return return_code
                except subprocess.TimeoutExpired:
                    self._claim_marker()
                    self._heartbeat("running", run_id=run_id, step=step, command_id=command_id)
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

    @staticmethod
    def _read_report(path: Path) -> dict[str, Any]:
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError("command report is missing or too large")
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("command report must be an object")
        return value

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
        default_code = (
            _SUCCESS_CODES[action]
            if state == "succeeded"
            else warning_code or _STATUS_CODES.get(raw_status, "run_failed")
        )
        safe_code = str(report.get("safe_code") or default_code)
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", safe_code) is None:
            safe_code = "run_failed"
        raw_outcomes = report.get("outcomes")
        outcomes: dict[str, Any] = raw_outcomes if isinstance(raw_outcomes, dict) else {}
        counters = {
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
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "state": state,
            "counters": counters
            or {"changed_posts": 0, "failed_posts": 0, "boards_ok": 0, "boards_failed": 0},
            "safe_summary_code": safe_code,
        }
        if release_id is not None:
            payload["release_id"] = release_id
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
        if self._send(kind, path, payload, f"finish-{command_id}"):
            self.store.mark_reported(command_id)
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

    def _board_summaries(self, report: dict[str, Any]) -> None:
        boards = report.get("boards")
        if not isinstance(boards, list) or not self.profile.archive.is_file():
            return
        inventory_pass_started_at = self._latest_inventory_pass_started_at()
        with connect_archive(self.profile.archive, read_only=True) as connection:
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
                    SELECT name, group_name, inventory_next_page, last_inventory_at
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
                    "last_outcome": "succeeded"
                    if status == "succeeded"
                    else "partial"
                    if outcomes
                    else "failed",
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
                }
                self._send(
                    "board_status",
                    "/api/v1/runner/boards/status",
                    payload,
                    f"board-{uuid4().hex}",
                )

    def _archive_snapshot_event(self, run_id: str, sequence: int) -> None:
        if not self.profile.archive.is_file():
            return
        inventory_started_at = self._latest_inventory_pass_started_at()
        try:
            with connect_archive(self.profile.archive, read_only=True) as connection:
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
        except sqlite3.Error:
            return
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

    def _heartbeat(
        self,
        state: str,
        *,
        run_id: str | None = None,
        step: str | None = None,
        command_id: str | None = None,
    ) -> None:
        if state == "idle" and (self.profile.state_dir / "schedule.paused").exists():
            state = "paused"
        payload: dict[str, Any] = {
            "runner_version": self.profile.runner_version,
            "state": state,
            "disk_free_bytes": shutil.disk_usage(self.profile.state_dir).free,
            "next_scheduled_at": _next_scheduled_at() if self._schedule_timer_active() else None,
        }
        if run_id is not None:
            payload.update(
                {
                    "active_run_id": run_id,
                    "active_step": step,
                }
            )
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
    ) -> bool:
        try:
            self.client.send_or_enqueue(self.store, kind, path, payload, idempotency_key)
            return True
        except ControlProtocolError, OutboxFullError, OSError, ValueError:
            return False

    def _write_publish_marker(self) -> None:
        marker = self.profile.state_dir / "publish.pending"
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
