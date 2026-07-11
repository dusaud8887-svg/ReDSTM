from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from scrapy.crawler import CrawlerProcess
from scrapy.utils.project import get_project_settings

from crawler.archive import initialize_archive
from crawler.frontier import FrontierStore
from crawler.session import SessionRefreshError, ensure_session_export
from crawler.settings import USER_AGENT
from crawler.spiders.typemoon import TypeMoonRecoverySpider
from crawler.store import ArchiveStore
from scripts.sync import _capture_summary, _write_report


def run_recovery(args: argparse.Namespace) -> dict[str, Any]:
    archive = args.archive.expanduser().resolve(strict=True)
    session_path = args.session.expanduser().resolve()
    warc_dir = args.warc_dir.expanduser().resolve()
    lock = FileLock(f"{archive}.sync.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout as error:
        raise RuntimeError("another archive process holds the lock") from error

    run_id: str | None = None
    store = ArchiveStore(archive)
    try:
        initialize_archive(archive)
        candidates = FrontierStore(archive).recovery_candidates(limit=args.max_posts)
        run_id = store.start_run("retry")
        warc_dir.mkdir(parents=True, exist_ok=True)
        warc_path = warc_dir / f"{run_id}.warc.gz"

        scheduled = 0
        if candidates:
            session = ensure_session_export(
                session_path,
                user_id=os.environ.get("TYPEMOON_ID", ""),
                password=os.environ.get("TYPEMOON_PASSWORD", ""),
                user_agent=USER_AGENT,
            )
            settings = get_project_settings()
            settings.set("REDSTM_ARCHIVE_PATH", str(archive), priority="cmdline")
            settings.set("REDSTM_RUN_ID", run_id, priority="cmdline")
            settings.set("REDSTM_WARC_PATH", str(warc_path), priority="cmdline")
            process = CrawlerProcess(settings)
            crawler = process.create_crawler(TypeMoonRecoverySpider)
            process.crawl(
                crawler,
                candidates=candidates,
                archive_path=archive,
                run_id=run_id,
                session=session,
                lease_seconds=args.lease_seconds,
            )
            process.start(stop_after_crawl=True)
            spider = crawler.spider
            scheduled = int(getattr(spider, "scheduled_posts", 0)) if spider else 0

        outcomes = _capture_summary(archive, run_id)
        failed = outcomes.get("parse_failed", 0) + outcomes.get("fetch_failed", 0)
        status = "partial" if failed else "succeeded"
        store.finish_run(
            run_id,
            status=status,
            discovered=len(candidates),
            summary={"selected_posts": len(candidates), "outcomes": outcomes},
        )
        return {
            "ok": status == "succeeded",
            "run_id": run_id,
            "status": status,
            "selected_posts": len(candidates),
            "scheduled_posts": scheduled,
            "outcomes": outcomes,
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
    parser.add_argument("--max-posts", type=int, default=20)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.max_posts, args.lease_seconds) < 1:
        parser.error("max-posts and lease-seconds must be positive")
    return args


def main() -> int:
    args = _parse_args()
    try:
        report = run_recovery(args)
    except (OSError, RuntimeError, SessionRefreshError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    if args.output is not None:
        _write_report(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
