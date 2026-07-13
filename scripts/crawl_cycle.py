from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from crawler.archive import connect_archive
from crawler.frontier import FrontierStore
from crawler.session import (
    AutomaticLoginThrottleError,
    SessionNetworkError,
    SessionRefreshError,
    ensure_session_export,
    validate_session_export,
)
from crawler.settings import (
    REDSTM_CIRCUIT_BREAKER_FAILURES,
    REDSTM_CYCLE_MAX_PAGES,
    REDSTM_CYCLE_MAX_POSTS,
    REDSTM_CYCLE_TIME_BUDGET_SECONDS,
    REDSTM_FRONTIER_LEASE_SECONDS,
    REDSTM_INVENTORY_MAX_PAGES,
    REDSTM_SESSION_PREFLIGHT_ATTEMPTS,
    REDSTM_SESSION_PREFLIGHT_RETRY_DELAY_SECONDS,
    REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS,
    REDSTM_SESSION_REVALIDATE_SECONDS,
    REDSTM_WORKER_GRACE_SECONDS,
    USER_AGENT,
)
from scripts.healthcheck import notify_dead_man
from scripts.sync import _write_report

_NETWORK_FAILURES = {"listing_fetch_failed", "network_error"}
_OUTCOMES = {"stored", "unchanged", "restricted", "missing", "parse_failed", "fetch_failed"}


def _outcome_counts(report: dict[str, Any]) -> dict[str, int]:
    value = report.get("outcomes", {})
    if not isinstance(value, dict):
        return {}
    return {
        key: count
        for key, count in value.items()
        if key in _OUTCOMES
        and isinstance(count, int)
        and not isinstance(count, bool)
        and count >= 0
    }


def _boards(
    archive: Path,
    *,
    board_id: str | None = None,
    inventory: bool = False,
    inventory_since: str | None = None,
) -> list[str]:
    with connect_archive(archive, read_only=True) as connection:
        order = (
            "(inventory_next_page = 1), COALESCE(last_inventory_at, ''), "
            "inventory_next_page, board_id"
            if inventory
            else "board_id"
        )
        board_filter = " AND board_id = ?" if board_id is not None else ""
        coverage = (
            " AND (last_inventory_at IS NULL "
            "OR julianday(last_inventory_at) IS NULL "
            "OR julianday(last_inventory_at) < julianday(?) OR inventory_next_page <> 1)"
            if inventory and inventory_since is not None
            else ""
        )
        parameters: tuple[object, ...] = ()
        if board_id is not None:
            parameters += (board_id,)
        if coverage:
            parameters += (inventory_since,)
        return [
            str(row[0])
            for row in connection.execute(
                f"SELECT board_id FROM boards WHERE is_enabled = 1{board_filter}{coverage} "
                f"ORDER BY {order}",
                parameters,
            )
        ]


def _session_status(validate: Callable[[], object]) -> str | None:
    network_failed = False
    for attempt in range(REDSTM_SESSION_PREFLIGHT_ATTEMPTS):
        try:
            validate()
            return None
        except SessionNetworkError:
            network_failed = True
            if attempt + 1 < REDSTM_SESSION_PREFLIGHT_ATTEMPTS:
                time.sleep(REDSTM_SESSION_PREFLIGHT_RETRY_DELAY_SECONDS)
                continue
            return "site_unreachable"
        except AutomaticLoginThrottleError:
            return "site_unreachable" if network_failed else "auth_failed"
        except OSError, SessionRefreshError, ValueError:
            return "auth_failed"
    raise AssertionError("unreachable")


def _preflight(session: Path) -> str | None:
    return _session_status(
        lambda: ensure_session_export(
            session,
            user_id=os.environ.get("TYPEMOON_ID", ""),
            password=os.environ.get("TYPEMOON_PASSWORD", ""),
            user_agent=USER_AGENT,
            timeout=REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS,
        )
    )


def _revalidate(session: Path) -> str | None:
    return _session_status(
        lambda: validate_session_export(
            session,
            timeout=REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS,
        )
    )


def _worker_command(
    args: argparse.Namespace, board_id: str, output: Path, max_seconds: int | None
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "scripts.sync",
        "--archive",
        str(args.archive),
        "--board",
        board_id,
        "--session",
        str(args.session),
        "--warc-dir",
        str(args.warc_dir),
        "--max-pages",
        str(args.max_pages),
        "--max-posts",
        str(args.max_posts),
        "--lease-seconds",
        str(args.lease_seconds),
        "--session-prevalidated",
        "--parent-lock-held",
        "--output",
        str(output),
    ]
    if max_seconds is not None:
        command.extend(("--max-seconds", str(max_seconds)))
    if args.inventory:
        command.append("--inventory")
    if getattr(args, "listing_only", False):
        command.append("--listing-only")
    pause_file = getattr(args, "pause_file", None)
    if pause_file is not None:
        command.extend(("--pause-file", str(pause_file)))
    return command


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    args.archive = args.archive.expanduser().resolve(strict=True)
    args.session = args.session.expanduser().resolve()
    args.warc_dir = args.warc_dir.expanduser().resolve()
    args.report_dir = args.report_dir.expanduser().resolve()
    pause_file = getattr(args, "pause_file", None)
    args.pause_file = pause_file.expanduser().resolve() if pause_file is not None else None
    boards = _boards(
        args.archive,
        board_id=getattr(args, "board", None),
        inventory=args.inventory,
        inventory_since=getattr(args, "inventory_since", None),
    )
    if not boards:
        raise ValueError("canonical archive has no enabled boards")

    locks = ExitStack()
    try:
        locks.enter_context(FileLock(f"{args.archive}.cycle.lock", timeout=0))
        locks.enter_context(FileLock(f"{args.archive}.sync.lock", timeout=0))
    except Timeout as error:
        locks.close()
        raise RuntimeError("another crawl cycle or sync writer is running") from error

    cycle_id = f"cycle-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    results: list[dict[str, Any]] = []
    started_at = time.monotonic()
    try:
        if args.pause_file is not None and args.pause_file.exists():
            return {
                "ok": False,
                "cycle_id": cycle_id,
                "status": "partial",
                "stop_reason": "schedule_paused",
                "boards": results,
            }
        preflight = _preflight(args.session)
        if preflight is not None:
            return {"ok": False, "cycle_id": cycle_id, "status": preflight, "boards": results}
        session_validated_at = started_at

        report_dir = args.report_dir / cycle_id
        report_dir.mkdir(parents=True, exist_ok=False)
        consecutive_network_failures = 0
        consecutive_rate_limits = 0
        network_run_ids: list[str] = []
        preserved_attempts = 0
        status = "succeeded"
        stop_reason: str | None = None
        for board_id in boards:
            if args.pause_file is not None and args.pause_file.exists():
                status = "partial"
                stop_reason = "schedule_paused"
                break
            now = time.monotonic()
            remaining_seconds = (
                args.max_seconds - (now - started_at) if args.max_seconds > 0 else None
            )
            if remaining_seconds is not None and remaining_seconds <= 0:
                status = "partial"
                stop_reason = "time_budget"
                break
            if now - session_validated_at >= REDSTM_SESSION_REVALIDATE_SECONDS:
                preflight = _revalidate(args.session)
                if preflight == "auth_failed":
                    # The session routinely outlives its export lifetime mid-cycle; attempt
                    # one throttled re-login before abandoning the remaining boards.
                    preflight = _preflight(args.session)
                if preflight is not None:
                    status = preflight
                    stop_reason = "session_revalidation"
                    break
                session_validated_at = now
            report_path = report_dir / f"{board_id}.json"
            worker_seconds = (
                max(1, int(remaining_seconds)) if remaining_seconds is not None else None
            )
            try:
                completed = subprocess.run(
                    _worker_command(args, board_id, report_path, worker_seconds),
                    check=False,
                    timeout=(
                        worker_seconds + REDSTM_WORKER_GRACE_SECONDS
                        if worker_seconds is not None
                        else None
                    ),
                )
            except subprocess.TimeoutExpired:
                status = "partial"
                stop_reason = "worker_timeout"
                results.append(
                    {
                        "board_id": board_id,
                        "status": "failed",
                        "scheduled_posts": 0,
                        "outcomes": {},
                        "failures": ["runner_timeout"],
                    }
                )
                break
            if not report_path.is_file():
                status = "runner_failed"
                results.append(
                    {
                        "board_id": board_id,
                        "status": status,
                        "scheduled_posts": 0,
                        "outcomes": {},
                        "failures": ["runner_failed"],
                    }
                )
                break
            report = json.loads(report_path.read_text(encoding="utf-8"))
            failures = set(report.get("failures", ()))
            board_status = str(report.get("status", "failed"))
            outcomes = _outcome_counts(report)
            results.append(
                {
                    "board_id": board_id,
                    "status": board_status,
                    "scheduled_posts": int(report.get("scheduled_posts", 0)),
                    "outcomes": outcomes,
                    "failures": sorted(failures),
                }
            )
            if report.get("stop_reason") == "schedule_paused":
                status = "partial"
                stop_reason = "schedule_paused"
                break
            if "auth_required" in failures or report.get("error") == "SessionRefreshError":
                status = "auth_failed"
                break
            network_failure = bool(failures & _NETWORK_FAILURES)
            if network_failure and isinstance(report.get("run_id"), str):
                network_run_ids.append(report["run_id"])
            consecutive_network_failures = (
                consecutive_network_failures + 1 if network_failure else 0
            )
            if consecutive_network_failures >= REDSTM_CIRCUIT_BREAKER_FAILURES:
                status = "site_unreachable"
                preserved_attempts = FrontierStore(args.archive).preserve_network_attempts(
                    network_run_ids
                )
                break
            consecutive_rate_limits = (
                consecutive_rate_limits + 1 if "rate_limited" in failures else 0
            )
            if consecutive_rate_limits >= REDSTM_CIRCUIT_BREAKER_FAILURES:
                status = "rate_limited"
                break
            if completed.returncode != 0 or board_status != "succeeded":
                status = "partial"

        ok = status == "succeeded"
        changed_posts = sum(item["outcomes"].get("stored", 0) for item in results)
        failed_posts = sum(
            item["outcomes"].get("parse_failed", 0) + item["outcomes"].get("fetch_failed", 0)
            for item in results
        )
        boards_ok = sum(item["status"] == "succeeded" for item in results)
        if stop_reason != "schedule_paused":
            notify_dead_man(ok, os.environ.get("REDSTM_CYCLE_HEALTHCHECK_URL", ""))
        return {
            "ok": ok,
            "cycle_id": cycle_id,
            "status": status,
            "board_count": len(boards),
            "completed_boards": len(results),
            "changed_posts": changed_posts,
            "failed_posts": failed_posts,
            "boards_ok": boards_ok,
            "boards_failed": len(results) - boards_ok,
            "preserved_attempts": preserved_attempts,
            "stop_reason": stop_reason,
            "boards": results,
        }
    finally:
        locks.close()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run all enabled TypeMoon boards sequentially.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--report-dir", type=Path, default=Path(".data/operations/cycles"))
    parser.add_argument("--board")
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--max-posts", type=int, default=REDSTM_CYCLE_MAX_POSTS)
    parser.add_argument("--max-seconds", type=int, default=REDSTM_CYCLE_TIME_BUDGET_SECONDS)
    parser.add_argument("--lease-seconds", type=int, default=REDSTM_FRONTIER_LEASE_SECONDS)
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--listing-only", action="store_true")
    parser.add_argument("--inventory-since", help=argparse.SUPPRESS)
    parser.add_argument("--pause-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.max_pages is None:
        args.max_pages = REDSTM_INVENTORY_MAX_PAGES if args.inventory else REDSTM_CYCLE_MAX_PAGES
    if min(args.max_pages, args.max_posts, args.max_seconds, args.lease_seconds) < 1:
        parser.error("max-pages, max-posts, max-seconds, and lease-seconds must be positive")
    if args.listing_only and not args.inventory:
        parser.error("listing-only requires inventory mode")
    if args.inventory_since is not None:
        if not args.inventory:
            parser.error("inventory-since requires inventory mode")
        try:
            parsed = datetime.fromisoformat(args.inventory_since.replace("Z", "+00:00"))
        except ValueError:
            parser.error("inventory-since must be an ISO timestamp")
        if parsed.tzinfo is None:
            parser.error("inventory-since must include a timezone")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_cycle(args)
    except (OSError, RuntimeError, ValueError) as error:
        report = {"ok": False, "error": type(error).__name__, "message": str(error)}
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
