from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from scrapy.crawler import CrawlerProcess
from scrapy.settings import Settings
from scrapy.utils.project import get_project_settings

from crawler import settings as crawler_settings
from crawler.archive import connect_archive, initialize_archive
from crawler.session import SessionRefreshError, ensure_session_export, load_session_export
from crawler.settings import REDSTM_FRONTIER_LEASE_SECONDS, USER_AGENT
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
                "SELECT DISTINCT error_code FROM captures "
                "WHERE run_id = ? AND error_code IS NOT NULL ORDER BY error_code",
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
    if max_seconds is not None:
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
        initialize_archive(archive)
        interrupted_runs = store.interrupt_stale_crawl_runs()
        with connect_archive(archive, read_only=True) as connection:
            board = connection.execute(
                "SELECT inventory_next_page FROM boards WHERE board_id = ? AND is_enabled = 1",
                (args.board,),
            ).fetchone()
        if board is None:
            raise ValueError("board is missing or disabled in the canonical archive")

        session = (
            load_session_export(session_path)
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
            start_page=int(board["inventory_next_page"]) if args.inventory else 1,
            max_posts=args.max_posts,
            lease_seconds=args.lease_seconds,
            inventory=args.inventory,
            pause_file=pause_file,
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
        status = "partial" if paused else _run_status(outcomes, discovered, failures)
        inventory_next_page = int(getattr(spider, "next_inventory_page", 1))
        inventory_completed = bool(getattr(spider, "inventory_completed", False))
        if args.inventory:
            with connect_archive(archive) as connection:
                connection.execute(
                    """
                    UPDATE boards SET inventory_next_page = ?,
                        last_inventory_at = CASE
                            WHEN ? THEN CURRENT_TIMESTAMP ELSE last_inventory_at
                        END
                    WHERE board_id = ?
                    """,
                    (inventory_next_page, inventory_completed, args.board),
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
            "inventory_next_page": inventory_next_page if args.inventory else None,
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
    parser = argparse.ArgumentParser(description="Run one bounded authenticated TypeMoon sync.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--max-posts", type=int, default=20)
    parser.add_argument("--max-seconds", type=int)
    parser.add_argument("--lease-seconds", type=int, default=REDSTM_FRONTIER_LEASE_SECONDS)
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--pause-file", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--session-prevalidated", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--parent-lock-held", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    limits = [args.max_pages, args.max_posts, args.lease_seconds]
    if args.max_seconds is not None:
        limits.append(args.max_seconds)
    if min(limits) < 1:
        parser.error("max-pages, max-posts, max-seconds, and lease-seconds must be positive")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_sync(args)
    except (OSError, RuntimeError, SessionRefreshError, ValueError) as error:
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
