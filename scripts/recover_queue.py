from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from scrapy.crawler import CrawlerProcess

from crawler.archive import require_archive_schema
from crawler.frontier import FrontierStore
from crawler.session import SessionExport, SessionRefreshError, ensure_session_export
from crawler.settings import (
    REDSTM_CAPPED_RETRY_ERROR_CODES,
    REDSTM_FRONTIER_LEASE_SECONDS,
    REDSTM_RECOVERY_MAX_POSTS,
    REDSTM_RECOVERY_TIME_BUDGET_SECONDS,
    REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS,
    REDSTM_STALE_DETAIL_RESERVED_POSTS,
    REDSTM_STALE_DETAIL_REVISIT_SECONDS,
    USER_AGENT,
)
from crawler.spiders.typemoon import TypeMoonRecoverySpider
from crawler.store import ArchiveStore
from scripts.crawl_cycle import _session_status
from scripts.healthcheck import notify_dead_man
from scripts.sync import (
    _capture_failure_codes,
    _capture_summary,
    _project_settings,
    _run_status,
    _timed_out,
    _write_report,
)


def _recovery_batch(
    frontier: FrontierStore,
    *,
    limit: int,
    now: datetime | None = None,
    board_id: str | None = None,
) -> tuple[list[tuple[str, int]], int]:
    selected_at = now or datetime.now(UTC)
    due = frontier.recovery_candidates(limit=limit, now=selected_at, board_id=board_id)
    # Reserve bounded forward progress even while the due queue stays full. Increase only
    # after canary evidence because every reserved slot is another old-source request.
    stale_limit = max(
        min(REDSTM_STALE_DETAIL_RESERVED_POSTS, limit),
        limit - len(due),
    )
    revisited = (
        frontier.requeue_stale_details(
            limit=stale_limit,
            stale_before=selected_at - timedelta(seconds=REDSTM_STALE_DETAIL_REVISIT_SECONDS),
            board_id=board_id,
        )
        if stale_limit
        else []
    )
    candidates = due[: limit - len(revisited)] + revisited
    return candidates, len(revisited)


def _aware_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise argparse.ArgumentTypeError("timestamp must be ISO-8601") from error
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("timestamp must include a timezone")
    return parsed.astimezone(UTC)


def run_recovery(args: argparse.Namespace) -> dict[str, Any]:
    archive = args.archive.expanduser().resolve(strict=True)
    session_path = args.session.expanduser().resolve()
    warc_dir = args.warc_dir.expanduser().resolve()
    pause_file = getattr(args, "pause_file", None)
    if pause_file is not None:
        pause_file = pause_file.expanduser().resolve()
    lock = FileLock(f"{archive}.sync.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout as error:
        raise RuntimeError("another archive process holds the lock") from error

    run_id: str | None = None
    store = ArchiveStore(archive)
    try:
        require_archive_schema(archive)
        interrupted_runs = store.interrupt_stale_crawl_runs()
        frontier = FrontierStore(archive)
        requeue_code = getattr(args, "requeue_dead", None)
        full_content_before = getattr(args, "full_content_before", None)
        full_content_max_rowid = getattr(args, "full_content_max_rowid", None)
        board_id = getattr(args, "board", None)
        paused = pause_file is not None and pause_file.exists()
        if paused:
            requeued_dead = revisited_posts = 0
            candidates: list[tuple[str, int]] = []
        else:
            if full_content_before is not None and full_content_max_rowid is not None:
                requeued_dead = revisited_posts = 0
                candidates = frontier.requeue_full_content(
                    limit=args.max_posts,
                    max_rowid=full_content_max_rowid,
                    attempted_before=full_content_before,
                    board_id=board_id,
                )
            else:
                requeued_dead = (
                    frontier.requeue_dead(
                        error_code=requeue_code,
                        limit=args.max_posts,
                        board_id=board_id,
                    )
                    if requeue_code
                    else 0
                )
                candidates, revisited_posts = _recovery_batch(
                    frontier,
                    limit=args.max_posts,
                    board_id=board_id,
                )
        run_id = store.start_run("retry")
        warc_dir.mkdir(parents=True, exist_ok=True)
        warc_path = warc_dir / f"{run_id}.warc.gz"

        scheduled = 0
        failures: list[str] = []
        preflight_status: str | None = None
        sessions: list[SessionExport] = []
        if candidates and not paused:
            # Classify session preflight failures exactly like crawl_cycle so an origin
            # outage reports site_unreachable (not a local runner defect) to operations.
            preflight_status = _session_status(
                lambda: sessions.append(
                    ensure_session_export(
                        session_path,
                        user_id=os.environ.get("TYPEMOON_ID", ""),
                        password=os.environ.get("TYPEMOON_PASSWORD", ""),
                        user_agent=USER_AGENT,
                        timeout=REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS,
                    )
                )
            )
        if candidates and not paused and preflight_status is None:
            session = sessions[-1]
            settings = _project_settings()
            settings.set("REDSTM_ARCHIVE_PATH", str(archive), priority="cmdline")
            settings.set("REDSTM_RUN_ID", run_id, priority="cmdline")
            settings.set("REDSTM_WARC_PATH", str(warc_path), priority="cmdline")
            settings.set("CLOSESPIDER_TIMEOUT", args.max_seconds, priority="cmdline")
            process = CrawlerProcess(settings)
            crawler = process.create_crawler(TypeMoonRecoverySpider)
            process.crawl(
                crawler,
                candidates=candidates,
                archive_path=archive,
                run_id=run_id,
                session=session,
                lease_seconds=args.lease_seconds,
                pause_file=pause_file,
            )
            process.start(stop_after_crawl=True)
            spider = crawler.spider
            scheduled = int(getattr(spider, "scheduled_posts", 0)) if spider else 0
            paused = bool(getattr(spider, "paused", False))
            failures = sorted(
                set(getattr(spider, "failure_codes", ()))
                | set(_capture_failure_codes(archive, run_id))
            )
            if _timed_out(crawler):
                failures = sorted({*failures, "recovery_time_budget"})

        outcomes = _capture_summary(archive, run_id)
        full_content_remaining = (
            frontier.full_content_remaining(
                max_rowid=full_content_max_rowid,
                attempted_before=full_content_before,
                board_id=board_id,
            )
            if full_content_before is not None and full_content_max_rowid is not None
            else None
        )
        if preflight_status is not None:
            status = preflight_status
        else:
            status = "partial" if paused else _run_status(outcomes, scheduled, failures)
        store.finish_run(
            run_id,
            # crawl_runs only stores terminal DB statuses; the report keeps the precise one.
            status=status if status in {"succeeded", "partial", "failed"} else "failed",
            discovered=len(candidates),
            summary={
                "selected_posts": len(candidates),
                "outcomes": outcomes,
                "failures": failures,
                "preflight_status": preflight_status,
                "interrupted_runs": interrupted_runs,
                "requeued_dead": requeued_dead,
                "revisited_posts": revisited_posts,
                "full_content_remaining": full_content_remaining,
            },
        )
        if not paused:
            notify_dead_man(
                status == "succeeded", os.environ.get("REDSTM_RECOVERY_HEALTHCHECK_URL", "")
            )
        return {
            "ok": status == "succeeded",
            "run_id": run_id,
            "status": status,
            "selected_posts": len(candidates),
            "scheduled_posts": scheduled,
            "outcomes": outcomes,
            "failures": failures,
            "interrupted_runs": interrupted_runs,
            "requeued_dead": requeued_dead,
            "revisited_posts": revisited_posts,
            "full_content_remaining": full_content_remaining,
            "stop_reason": "schedule_paused" if paused else None,
            "warc_path": str(warc_path),
        }
    except Exception:
        if run_id is not None:
            try:
                store.finish_run(run_id, status="failed", summary={"error": "recovery_failed"})
            except ValueError:
                pass
        raise
    finally:
        lock.release()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recover one bounded legacy frontier batch.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--max-posts", type=int, default=REDSTM_RECOVERY_MAX_POSTS)
    parser.add_argument("--max-seconds", type=int, default=REDSTM_RECOVERY_TIME_BUDGET_SECONDS)
    parser.add_argument("--lease-seconds", type=int, default=REDSTM_FRONTIER_LEASE_SECONDS)
    parser.add_argument("--board")
    parser.add_argument("--full-content-before", type=_aware_datetime)
    parser.add_argument("--full-content-max-rowid", type=int)
    parser.add_argument("--pause-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument(
        "--requeue-dead",
        choices=tuple(sorted(REDSTM_CAPPED_RETRY_ERROR_CODES)),
        help="Requeue at most max-posts matching dead entries before recovery",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.max_posts, args.max_seconds, args.lease_seconds) < 1:
        parser.error("max-posts, max-seconds and lease-seconds must be positive")
    full_content = (args.full_content_before, args.full_content_max_rowid)
    if (full_content[0] is None) != (full_content[1] is None):
        parser.error("full-content checkpoint arguments must be provided together")
    if args.full_content_max_rowid is not None and args.full_content_max_rowid < 0:
        parser.error("full-content-max-rowid must be non-negative")
    if args.requeue_dead and args.full_content_before is not None:
        parser.error("requeue-dead cannot be combined with full-content mode")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_recovery(args)
    except (OSError, RuntimeError, SessionRefreshError, ValueError) as error:
        report = {"ok": False, "error": type(error).__name__, "message": str(error)}
        if args.output is not None:
            _write_report(args.output, report)
        print(json.dumps(report, ensure_ascii=False))
        return 1
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
