from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from scrapy.crawler import CrawlerProcess
from scrapy.settings import Settings
from scrapy.utils.project import get_project_settings

from crawler import settings as crawler_settings
from crawler.archive import connect_archive, require_archive_schema
from crawler.session import SessionRefreshError, ensure_session_export, load_session_export
from crawler.settings import (
    REDSTM_FRONTIER_LEASE_SECONDS,
    REDSTM_IMPERSONATE_BROWSER,
    REDSTM_SYNC_MAX_PAGES,
    REDSTM_SYNC_MAX_POSTS,
    USER_AGENT,
)
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore
from scripts.healthcheck import notify_dead_man


def _capture_summary(archive: Path, run_id: str) -> dict[str, int]:
    with connect_archive(archive, read_only=True) as connection:
        counts = {
            str(row["outcome"]): int(row["count"])
            for row in connection.execute(
                "SELECT outcome, COUNT(*) AS count FROM captures "
                "WHERE run_id = ? AND entity_type = 'post' GROUP BY outcome ORDER BY outcome",
                (run_id,),
            )
        }
    return counts


def _capture_failure_codes(archive: Path, run_id: str) -> list[str]:
    with connect_archive(archive, read_only=True) as connection:
        return [
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT capture.error_code FROM captures AS capture "
                "WHERE capture.run_id = ? AND capture.error_code IS NOT NULL "
                "AND capture.id = (SELECT MAX(newer.id) FROM captures AS newer "
                "WHERE newer.run_id = capture.run_id AND newer.url = capture.url) "
                "ORDER BY capture.error_code",
                (run_id,),
            )
        ]


def _run_status(outcomes: dict[str, int], scheduled: int, failures: list[str]) -> str:
    incomplete = sum(outcomes.values()) != scheduled
    item_failures = outcomes.get("parse_failed", 0) + outcomes.get("fetch_failed", 0)
    if not failures and not incomplete and not item_failures:
        return "succeeded"
    return "partial" if outcomes else "failed"


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(f"{path.name}.partial")
    try:
        partial.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(partial, path)
    finally:
        partial.unlink(missing_ok=True)


def _project_settings(max_seconds: int | None = None) -> Settings:
    settings = get_project_settings()
    settings.setmodule(crawler_settings, priority="project")
    if max_seconds is not None and max_seconds > 0:
        settings.set("CLOSESPIDER_TIMEOUT", max_seconds, priority="cmdline")
    return settings


def _timed_out(crawler: Any) -> bool:
    return bool(
        crawler.stats is not None
        and crawler.stats.get_value("finish_reason") == "closespider_timeout"
    )


def run_sync(args: argparse.Namespace) -> dict[str, Any]:
    archive = args.archive.expanduser().resolve(strict=True)
    session_path = args.session.expanduser().resolve()
    warc_dir = args.warc_dir.expanduser().resolve()
    pause_file = getattr(args, "pause_file", None)
    if pause_file is not None:
        pause_file = pause_file.expanduser().resolve()
    lock = None if args.parent_lock_held else FileLock(f"{archive}.sync.lock", timeout=0)
    if lock is not None:
        try:
            lock.acquire()
        except Timeout as error:
            raise RuntimeError("another sync process holds the archive lock") from error

    run_id: str | None = None
    store = ArchiveStore(archive)
    try:
        require_archive_schema(archive)
        interrupted_runs = store.interrupt_stale_crawl_runs()
        with connect_archive(archive, read_only=True) as connection:
            board = connection.execute(
                "SELECT inventory_next_page, incremental_anchor_post_id "
                "FROM boards WHERE board_id = ? AND is_enabled = 1",
                (args.board,),
            ).fetchone()
        if board is None:
            raise ValueError("board is missing or disabled in the canonical archive")

        inventory_start_page = int(board["inventory_next_page"]) if args.inventory else 1
        session = (
            load_session_export(session_path, allow_expired=True)
            if args.session_prevalidated
            else ensure_session_export(
                session_path,
                user_id=os.environ.get("TYPEMOON_ID", ""),
                password=os.environ.get("TYPEMOON_PASSWORD", ""),
                user_agent=USER_AGENT,
            )
        )
        run_id = store.start_run("inventory" if args.inventory else "sync")
        warc_dir.mkdir(parents=True, exist_ok=True)
        warc_path = warc_dir / f"{run_id}.warc.gz"
        settings = _project_settings(args.max_seconds)
        settings.set("REDSTM_ARCHIVE_PATH", str(archive), priority="cmdline")
        settings.set("REDSTM_RUN_ID", run_id, priority="cmdline")
        settings.set("REDSTM_WARC_PATH", str(warc_path), priority="cmdline")
        process = CrawlerProcess(settings)
        crawler = process.create_crawler(TypeMoonSpider)
        process.crawl(
            crawler,
            board_id=args.board,
            archive_path=archive,
            run_id=run_id,
            session=session,
            max_pages=args.max_pages,
            start_page=inventory_start_page,
            max_posts=args.max_posts,
            lease_seconds=args.lease_seconds,
            inventory=args.inventory,
            listing_only=getattr(args, "listing_only", False),
            anchor_post_id=(
                None
                if args.inventory or board["incremental_anchor_post_id"] is None
                else int(board["incremental_anchor_post_id"])
            ),
            pause_file=pause_file,
            impersonate_browser=REDSTM_IMPERSONATE_BROWSER,
        )
        process.start(stop_after_crawl=True)

        spider = crawler.spider
        discovered = int(getattr(spider, "scheduled_posts", 0)) if spider is not None else 0
        failures = sorted(
            set(getattr(spider, "failure_codes", ())) | set(_capture_failure_codes(archive, run_id))
        )
        if _timed_out(crawler):
            failures = sorted({*failures, "sync_time_budget"})
        outcomes = _capture_summary(archive, run_id)
        paused = bool(getattr(spider, "paused", False))
        inventory_next_page = int(getattr(spider, "next_inventory_page", inventory_start_page))
        inventory_completed = bool(getattr(spider, "inventory_completed", False))
        listing_completed = bool(getattr(spider, "listing_completed", False))
        latest_post_id = getattr(spider, "latest_post_id", None)
        if not args.inventory and not paused and not listing_completed:
            failures = sorted({*failures, "listing_boundary_incomplete"})
        status = "partial" if paused else _run_status(outcomes, discovered, failures)
        # Listing-only inventory records no post outcomes. Page cursor advance is real progress
        # and must not collapse to a hard "failed" that trips the cycle's outage breaker.
        if (
            args.inventory
            and status == "failed"
            and (inventory_completed or inventory_next_page > inventory_start_page)
        ):
            status = "partial"
        if args.inventory:
            with connect_archive(archive) as connection:
                connection.execute(
                    """
                    UPDATE boards SET inventory_next_page = ?,
                        last_inventory_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                    WHERE board_id = ?
                    """,
                    (inventory_next_page, args.board),
                )
        elif listing_completed:
            if latest_post_id is not None and (
                type(latest_post_id) is not int or latest_post_id < 1
            ):
                raise RuntimeError("incremental anchor candidate is invalid")
            with connect_archive(archive) as connection:
                connection.execute(
                    """
                    UPDATE boards SET incremental_anchor_post_id =
                            COALESCE(?, incremental_anchor_post_id),
                        last_incremental_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                    WHERE board_id = ?
                    """,
                    (latest_post_id, args.board),
                )
        store.finish_run(
            run_id,
            status=status,
            discovered=discovered,
            summary={
                "outcomes": outcomes,
                "failures": failures,
                "interrupted_runs": interrupted_runs,
                "inventory_next_page": inventory_next_page if args.inventory else None,
                "listing_completed": listing_completed,
                "latest_post_id": latest_post_id,
            },
        )
        if not paused:
            notify_dead_man(status == "succeeded", os.environ.get("REDSTM_HEALTHCHECK_URL", ""))
        return {
            "ok": status == "succeeded",
            "run_id": run_id,
            "status": status,
            "board_id": args.board,
            "scheduled_posts": discovered,
            "outcomes": outcomes,
            "failures": failures,
            "interrupted_runs": interrupted_runs,
            "inventory_start_page": inventory_start_page if args.inventory else None,
            "inventory_next_page": inventory_next_page if args.inventory else None,
            "listing_completed": listing_completed,
            "latest_post_id": latest_post_id,
            "stop_reason": "schedule_paused" if paused else None,
            "warc_path": str(warc_path),
        }
    except Exception:
        if run_id is not None:
            try:
                store.finish_run(run_id, status="failed", summary={"error": "sync_failed"})
            except ValueError:
                pass
        raise
    finally:
        if lock is not None:
            lock.release()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one authenticated TypeMoon board sync.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--max-pages", type=int, default=REDSTM_SYNC_MAX_PAGES)
    parser.add_argument("--max-posts", type=int, default=REDSTM_SYNC_MAX_POSTS)
    parser.add_argument("--max-seconds", type=int)
    parser.add_argument("--lease-seconds", type=int, default=REDSTM_FRONTIER_LEASE_SECONDS)
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--listing-only", action="store_true")
    parser.add_argument("--pause-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--session-prevalidated", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--parent-lock-held", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    limits = [args.max_pages, args.max_posts]
    if args.max_seconds is not None:
        limits.append(args.max_seconds)
    if min(limits) < 1 or args.lease_seconds < 1:
        parser.error("max limits and lease-seconds must be positive")
    if args.listing_only and not args.inventory:
        parser.error("listing-only requires inventory mode")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_sync(args)
    except (OSError, RuntimeError, SessionRefreshError, ValueError, sqlite3.Error) as error:
        report = {
            "ok": False,
            "error": type(error).__name__,
            "message": str(error),
        }
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
