from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from scrapy.crawler import CrawlerProcess
from scrapy.utils.project import get_project_settings

from crawler.archive import connect_archive, initialize_archive
from crawler.session import SessionRefreshError, ensure_session_export
from crawler.settings import USER_AGENT
from crawler.spiders.typemoon import TypeMoonSpider
from crawler.store import ArchiveStore


def _capture_summary(archive: Path, run_id: str) -> dict[str, int]:
    with connect_archive(archive, read_only=True) as connection:
        counts = {
            str(row["outcome"]): int(row["count"])
            for row in connection.execute(
                "SELECT outcome, COUNT(*) AS count FROM captures "
                "WHERE run_id = ? GROUP BY outcome ORDER BY outcome",
                (run_id,),
            )
        }
    return counts


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


def run_sync(args: argparse.Namespace) -> dict[str, Any]:
    archive = args.archive.expanduser().resolve(strict=True)
    session_path = args.session.expanduser().resolve()
    warc_dir = args.warc_dir.expanduser().resolve()
    lock = FileLock(f"{archive}.sync.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout as error:
        raise RuntimeError("another sync process holds the archive lock") from error

    run_id: str | None = None
    store = ArchiveStore(archive)
    try:
        initialize_archive(archive)
        with connect_archive(archive, read_only=True) as connection:
            board = connection.execute(
                "SELECT 1 FROM boards WHERE board_id = ? AND is_enabled = 1", (args.board,)
            ).fetchone()
        if board is None:
            raise ValueError("board is missing or disabled in the canonical archive")

        session = ensure_session_export(
            session_path,
            user_id=os.environ.get("TYPEMOON_ID", ""),
            password=os.environ.get("TYPEMOON_PASSWORD", ""),
            user_agent=USER_AGENT,
        )
        run_id = store.start_run("sync")
        warc_dir.mkdir(parents=True, exist_ok=True)
        warc_path = warc_dir / f"{run_id}.warc.gz"
        settings = get_project_settings()
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
            max_posts=args.max_posts,
            lease_seconds=args.lease_seconds,
        )
        process.start(stop_after_crawl=True)

        outcomes = _capture_summary(archive, run_id)
        failed = outcomes.get("parse_failed", 0) + outcomes.get("fetch_failed", 0)
        status = "partial" if failed else "succeeded"
        spider = crawler.spider
        discovered = int(getattr(spider, "scheduled_posts", 0)) if spider is not None else 0
        store.finish_run(
            run_id,
            status=status,
            discovered=discovered,
            summary={"outcomes": outcomes},
        )
        return {
            "ok": status == "succeeded",
            "run_id": run_id,
            "status": status,
            "board_id": args.board,
            "scheduled_posts": discovered,
            "outcomes": outcomes,
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
        lock.release()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one bounded authenticated TypeMoon sync.")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--board", required=True)
    parser.add_argument("--session", type=Path, default=Path(".data/private/typemoon-session.json"))
    parser.add_argument("--warc-dir", type=Path, default=Path(".data/warc"))
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--max-posts", type=int, default=20)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.max_pages, args.max_posts, args.lease_seconds) < 1:
        parser.error("max-pages, max-posts, and lease-seconds must be positive")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_sync(args)
    except (OSError, RuntimeError, SessionRefreshError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
