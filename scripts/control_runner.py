from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
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


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
            report = self._execute_action(action, command_id, run_id)
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
        self._event(run_id, 1, action, state, finish_payload["counters"])
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
        return {"ok": state == "succeeded", "status": terminal["state"], "command_id": command_id}

    def _execute_action(self, action: str, command_id: str, run_id: str) -> dict[str, Any]:
        command_reports = self.profile.report_dir / "commands"
        command_reports.mkdir(parents=True, exist_ok=True)
        report_path = command_reports / f"{command_id}.json"
        if action == "sync-now":
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
            return self._execute_report(command, report_path, run_id, "crawling")
        if action == "retry-batch":
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
                "100",
                "--output",
                str(report_path),
            ]
            return self._execute_report(command, report_path, run_id, "recovery")
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
        if self._wait(export, run_id, "exporting", stdout=export_report) != 0:
            return {"ok": False, "status": "failed", "safe_code": "export_failed"}
        publish = [
            sys.executable,
            "-m",
            "scripts.publish_static",
            str(self.profile.static_root),
            "--remote",
            self.profile.remote,
        ]
        if self._wait(publish, run_id, "publishing", stdout=report_path) != 0:
            return {"ok": False, "status": "failed", "safe_code": "publish_failed"}
        report = self._read_report(report_path)
        if report.get("ok") is True:
            marker.unlink(missing_ok=True)
        return report

    def _execute_report(
        self, command: list[str], report_path: Path, run_id: str, step: str
    ) -> dict[str, Any]:
        return_code = self._wait(command, run_id, step)
        report = self._read_report(report_path)
        if return_code not in (0, 2) and report.get("ok") is not True:
            return {"ok": False, "status": "failed", "safe_code": "runner_failed"}
        return report

    def _wait(
        self, command: list[str], run_id: str, step: str, *, stdout: Path | None = None
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
                    return process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    self._heartbeat("running", run_id=run_id, step=step)
        finally:
            if output_handle is not None:
                output_handle.close()

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
        default_code = (
            _SUCCESS_CODES[action]
            if state == "succeeded"
            else _STATUS_CODES.get(raw_status, "run_failed")
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
    ) -> None:
        payload = {
            "events": [
                {
                    "sequence": sequence,
                    "step": step,
                    "state": state,
                    "recorded_at": _timestamp(),
                    "counters": counters or {},
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
                        "retry": queue.get("retry", 0),
                        "dead": queue.get("dead", 0),
                    },
                    "warning_code": warning,
                }
                self._send(
                    "board_status",
                    "/api/v1/runner/boards/status",
                    payload,
                    f"board-{uuid4().hex}",
                )

    def _heartbeat(self, state: str, *, run_id: str | None = None, step: str | None = None) -> None:
        payload: dict[str, Any] = {
            "runner_version": self.profile.runner_version,
            "state": state,
            "disk_free_bytes": shutil.disk_usage(self.profile.state_dir).free,
        }
        if run_id is not None:
            payload.update(
                {
                    "runner_id": self.profile.runner_id,
                    "active_command_id": run_id.removeprefix("command-"),
                    "active_run_id": run_id,
                    "active_step": step,
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
        profile, ControlClient.from_environment(), ControlStore(profile.state_db)
    )
    report = runner.run_once()
    print(json.dumps(report, sort_keys=True))
    return 0 if report.get("ok") is not False else 2


if __name__ == "__main__":
    raise SystemExit(main())
