from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
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
        # Stickiness: finish in-progress boards (next_page > 1) before starting fresh ones.
        # Among in-progress, most recently checkpointed first so the active board continues.
        # Among not-yet-done page-1 boards, oldest / never-touched first for fairness.
        order = (
            "CASE WHEN inventory_next_page > 1 THEN 0 ELSE 1 END, "
            "CASE WHEN inventory_next_page > 1 THEN last_inventory_at END DESC, "
            "CASE WHEN inventory_next_page = 1 THEN COALESCE(last_inventory_at, '') END ASC, "
            "board_id"
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


def _inventory_pass_coverage(
    archive: Path,
    started_at: str,
    *,
    board_id: str | None = None,
) -> dict[str, int]:
    """Pass-level board coverage for inventory reports (completed / in progress / pending)."""
    with connect_archive(archive, read_only=True) as connection:
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
    total = int(row[0] or 0) if row is not None else 0
    completed = int(row[1] or 0) if row is not None else 0
    in_progress = int(row[2] or 0) if row is not None else 0
    pending = max(total - completed - in_progress, 0)
    return {
        "inventory_total_boards": total,
        "inventory_completed_boards": completed,
        "inventory_in_progress_boards": in_progress,
        "inventory_pending_boards": pending,
    }


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
        inventory_since = getattr(args, "inventory_since", None)
        if (
            args.inventory
            and inventory_since is not None
            and _boards(args.archive, board_id=getattr(args, "board", None), inventory=True)
        ):
            # Every enabled board is already covered since the pass epoch: a resumed
            # full-catalog whose previous cycle finished the last board. Nothing left
            # to fetch is completion, not failure — report success so the runner can
            # close the pass checkpoint.
            return {
                "ok": True,
                "cycle_id": f"cycle-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-"
                f"{uuid.uuid4().hex[:8]}",
                "status": "succeeded",
                "board_count": 0,
                "completed_boards": 0,
                "changed_posts": 0,
                "failed_posts": 0,
                "boards_ok": 0,
                "boards_failed": 0,
                "stop_reason": None,
                "boards": [],
                "inventory_coverage_complete": True,
            }
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
        status = "succeeded"
        stop_reason: str | None = None
        for board_id in boards:
            if args.pause_file is not None and args.pause_file.exists():
                status = "partial"
                stop_reason = "schedule_paused"
                break
            disk_stop_bytes = int(getattr(args, "disk_stop_bytes", 0))
            if disk_stop_bytes and shutil.disk_usage(args.archive).free < disk_stop_bytes:
                status = "partial"
                stop_reason = "disk_low"
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
                # One board hung past the worker budget: record and continue so the rest of
                # the cycle still advances. Durable cursors keep progress for this board.
                status = "partial"
                results.append(
                    {
                        "board_id": board_id,
                        "status": "failed",
                        "scheduled_posts": 0,
                        "outcomes": {},
                        "failures": ["runner_timeout"],
                    }
                )
                consecutive_network_failures += 1
                if consecutive_network_failures >= REDSTM_CIRCUIT_BREAKER_FAILURES:
                    status = "site_unreachable"
                    stop_reason = "worker_timeout"
                    break
                continue
            if not report_path.is_file():
                status = "partial"
                results.append(
                    {
                        "board_id": board_id,
                        "status": "failed",
                        "scheduled_posts": 0,
                        "outcomes": {},
                        "failures": ["runner_failed"],
                    }
                )
                consecutive_network_failures += 1
                if consecutive_network_failures >= REDSTM_CIRCUIT_BREAKER_FAILURES:
                    status = "runner_failed"
                    stop_reason = "missing_report"
                    break
                continue
            report = json.loads(report_path.read_text(encoding="utf-8"))
            failures = set(report.get("failures", ()))
            board_status = str(report.get("status", "failed"))
            outcomes = _outcome_counts(report)
            board_result: dict[str, Any] = {
                "board_id": board_id,
                "status": board_status,
                "scheduled_posts": int(report.get("scheduled_posts", 0)),
                "outcomes": outcomes,
                "failures": sorted(failures),
            }
            if args.inventory:
                for key in (
                    "inventory_start_page",
                    "inventory_next_page",
                    "inventory_completed",
                    "listing_completed",
                    "listing_row_skipped",
                ):
                    if key in report:
                        board_result[key] = report[key]
            results.append(board_result)
            if report.get("stop_reason") == "schedule_paused":
                status = "partial"
                stop_reason = "schedule_paused"
                break
            if "auth_required" in failures or report.get("error") == "SessionRefreshError":
                # One re-login attempt mid-cycle, then continue other boards if refresh works.
                preflight = _preflight(args.session)
                if preflight is not None:
                    status = "auth_failed" if preflight == "auth_failed" else preflight
                    stop_reason = "session_revalidation"
                    break
                session_validated_at = time.monotonic()
                status = "partial"
                consecutive_network_failures = 0
                continue
            network_failure = bool(failures & _NETWORK_FAILURES)
            # Inventory full-catalog often advances many listing pages before a later dribble
            # timeout. Counting that board as a pure outage aborts the pass after three boards
            # that each made real cursor progress. Only zero-progress network boards feed the
            # site_unreachable breaker; page advance resets the streak.
            inventory_progress = False
            if args.inventory:
                start_page = report.get("inventory_start_page")
                next_page = report.get("inventory_next_page")
                # Board completion resets next_page to 1 (often << start_page). That is real
                # progress and must not feed the site-wide outage breaker.
                inventory_progress = bool(report.get("inventory_completed")) or (
                    type(start_page) is int and type(next_page) is int and next_page > start_page
                )
            # Boards that stored detail bodies (or advanced inventory pages) still made
            # progress despite transport noise — do not feed the site-wide outage breaker.
            stored_progress = int(outcomes.get("stored", 0) or 0) > 0
            if network_failure and not inventory_progress and not stored_progress:
                consecutive_network_failures += 1
            else:
                consecutive_network_failures = 0
            if consecutive_network_failures >= REDSTM_CIRCUIT_BREAKER_FAILURES:
                status = "site_unreachable"
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
        report = {
            "ok": ok,
            "cycle_id": cycle_id,
            "status": status,
            "board_count": len(boards),
            "completed_boards": len(results),
            "changed_posts": changed_posts,
            "failed_posts": failed_posts,
            "boards_ok": boards_ok,
            "boards_failed": len(results) - boards_ok,
            "stop_reason": stop_reason,
            "boards": results,
        }
        if args.inventory:
            report["inventory_boards_completed_this_cycle"] = sum(
                1 for item in results if item.get("inventory_completed") is True
            )
            report["listing_row_skipped"] = sum(
                int(item["listing_row_skipped"])
                for item in results
                if type(item.get("listing_row_skipped")) is int
            )
            inventory_since = getattr(args, "inventory_since", None)
            if inventory_since is not None:
                report.update(
                    _inventory_pass_coverage(
                        args.archive,
                        inventory_since,
                        board_id=getattr(args, "board", None),
                    )
                )
        if stop_reason == "disk_low":
            report["safe_code"] = "disk_low"
        return report
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
    parser.add_argument("--disk-stop-bytes", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.max_pages is None:
        args.max_pages = REDSTM_INVENTORY_MAX_PAGES if args.inventory else REDSTM_CYCLE_MAX_PAGES
    # Inventory allows max_pages=0 (unlimited); non-inventory still requires a positive cap.
    page_ok = args.max_pages >= 0 if args.inventory else args.max_pages >= 1
    if not page_ok or min(args.max_posts, args.max_seconds, args.lease_seconds) < 1:
        parser.error(
            "max-posts, max-seconds, and lease-seconds must be positive; "
            "max-pages must be positive (or 0 for unlimited inventory)"
        )
    if args.disk_stop_bytes < 0:
        parser.error("disk-stop-bytes must not be negative")
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
    except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
        report = {
            "ok": False,
            "status": "failed",
            "error": type(error).__name__,
            "message": str(error),
        }
        # Contention over the canonical archive (another cycle/sync holding the file
        # lock, or sqlite's own busy lock) gets a distinct safe code so /ops explains
        # the failure instead of showing a generic one.
        held = isinstance(error, RuntimeError) and "another crawl cycle" in str(error)
        busy = isinstance(error, sqlite3.OperationalError) and "lock" in str(error).casefold()
        if held or busy:
            report["safe_code"] = "archive_locked"
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
