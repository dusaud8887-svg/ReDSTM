from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from crawler.archive import connect_archive
from crawler.session import SessionNetworkError, SessionRefreshError, ensure_session_export
from crawler.settings import REDSTM_FRONTIER_LEASE_SECONDS, USER_AGENT
from scripts.healthcheck import notify_dead_man
from scripts.sync import _write_report

_NETWORK_FAILURES = {"listing_fetch_failed", "network_error"}


def _boards(archive: Path) -> list[str]:
    with connect_archive(archive, read_only=True) as connection:
        return [
            str(row[0])
            for row in connection.execute(
                "SELECT board_id FROM boards WHERE is_enabled = 1 ORDER BY board_id"
            )
        ]


def _preflight(session: Path) -> str | None:
    for attempt in range(2):
        try:
            ensure_session_export(
                session,
                user_id=os.environ.get("TYPEMOON_ID", ""),
                password=os.environ.get("TYPEMOON_PASSWORD", ""),
                user_agent=USER_AGENT,
                timeout=60,
            )
            return None
        except SessionNetworkError:
            if attempt == 0:
                time.sleep(30)
                continue
            return "site_unreachable"
        except SessionRefreshError:
            return "auth_failed"
    raise AssertionError("unreachable")


def _worker_command(args: argparse.Namespace, board_id: str, output: Path) -> list[str]:
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
        "--output",
        str(output),
    ]
    if args.inventory:
        command.append("--inventory")
    return command


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    args.archive = args.archive.expanduser().resolve(strict=True)
    args.session = args.session.expanduser().resolve()
    args.warc_dir = args.warc_dir.expanduser().resolve()
    args.report_dir = args.report_dir.expanduser().resolve()
    boards = _boards(args.archive)
    if not boards:
        raise ValueError("canonical archive has no enabled boards")

    lock = FileLock(f"{args.archive}.cycle.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout as error:
        raise RuntimeError("another crawl cycle is running") from error

    cycle_id = f"cycle-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    results: list[dict[str, Any]] = []
    try:
        preflight = _preflight(args.session)
        if preflight is not None:
            return {"ok": False, "cycle_id": cycle_id, "status": preflight, "boards": results}

        report_dir = args.report_dir / cycle_id
        report_dir.mkdir(parents=True, exist_ok=False)
        consecutive_network_failures = 0
        status = "succeeded"
        for board_id in boards:
            report_path = report_dir / f"{board_id}.json"
            completed = subprocess.run(_worker_command(args, board_id, report_path), check=False)
            if not report_path.is_file():
                status = "runner_failed"
                results.append({"board_id": board_id, "status": status})
                break
            report = json.loads(report_path.read_text(encoding="utf-8"))
            failures = set(report.get("failures", ()))
            board_status = str(report.get("status", "failed"))
            results.append(
                {
                    "board_id": board_id,
                    "status": board_status,
                    "scheduled_posts": int(report.get("scheduled_posts", 0)),
                    "failures": sorted(failures),
                }
            )
            if "auth_required" in failures or report.get("error") == "SessionRefreshError":
                status = "auth_failed"
                break
            network_failure = bool(failures & _NETWORK_FAILURES)
            consecutive_network_failures = (
                consecutive_network_failures + 1 if network_failure else 0
            )
            if consecutive_network_failures >= 3:
                status = "site_unreachable"
                break
            if completed.returncode != 0 or board_status != "succeeded":
                status = "partial"

        ok = status == "succeeded"
        notify_dead_man(ok, os.environ.get("REDSTM_CYCLE_HEALTHCHECK_URL", ""))
        return {
            "ok": ok,
            "cycle_id": cycle_id,
            "status": status,
            "board_count": len(boards),
            "completed_boards": len(results),
            "boards": results,
        }
    finally:
        lock.release()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run all enabled TypeMoon boards sequentially.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--report-dir", type=Path, default=Path(".data/operations/cycles"))
    parser.add_argument("--max-pages", type=int, default=3)
    parser.add_argument("--max-posts", type=int, default=20)
    parser.add_argument("--lease-seconds", type=int, default=REDSTM_FRONTIER_LEASE_SECONDS)
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.max_pages, args.max_posts, args.lease_seconds) < 1:
        parser.error("max-pages, max-posts, and lease-seconds must be positive")
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
