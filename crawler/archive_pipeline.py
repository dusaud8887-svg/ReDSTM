from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Self

from scrapy.crawler import Crawler
from scrapy.exceptions import NotConfigured

from crawler.frontier import FrontierLease
from crawler.items import CapturedPostItem
from crawler.pipelines import normalize_captured_post
from crawler.store import ArchiveStore


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("capture metadata must be non-empty text")
    return value.strip()


class ArchivePipeline:
    def __init__(self, archive_path: str | Path, run_id: str) -> None:
        if not run_id.strip():
            raise ValueError("run_id must be non-empty")
        self.store = ArchiveStore(archive_path)
        self.run_id = run_id

    @classmethod
    def from_crawler(cls, crawler: Crawler) -> Self:
        archive_path = crawler.settings.get("REDSTM_ARCHIVE_PATH")
        run_id = crawler.settings.get("REDSTM_RUN_ID")
        if not isinstance(archive_path, str) or not archive_path:
            raise NotConfigured("REDSTM_ARCHIVE_PATH is not configured")
        if not isinstance(run_id, str) or not run_id:
            raise NotConfigured("REDSTM_RUN_ID is not configured")
        return cls(archive_path, run_id)

    def process_item(self, item: Any) -> Any:
        if not isinstance(item, CapturedPostItem):
            return item

        lease = self._lease(item)
        captured_at = datetime.now(UTC)
        try:
            outcome = item.get("outcome")
            raw_sha256 = _optional_text(item.get("raw_sha256"))
            warc_file = _optional_text(item.get("warc_file"))
            http_status = item.get("http_status")
            if http_status is not None and (
                isinstance(http_status, bool)
                or not isinstance(http_status, int)
                or not 100 <= http_status <= 599
            ):
                raise ValueError("http_status must be between 100 and 599")

            if outcome == "stored":
                self.store.store_post(
                    self.run_id,
                    normalize_captured_post(item),
                    captured_at=captured_at,
                    raw_sha256=raw_sha256,
                    warc_file=warc_file,
                    http_status=200 if http_status is None else http_status,
                    lease=lease,
                )
                return item

            if outcome not in {"restricted", "parse_failed", "fetch_failed"}:
                raise ValueError(f"unsupported capture outcome: {outcome!r}")
            if outcome == "restricted":
                error_code, frontier_state = "permission_denied", "done"
            elif outcome == "parse_failed":
                error_code, frontier_state = "parse_drift", "dead"
            else:
                error_code, frontier_state = "auth_required", "retry"
            self.store.record_outcome(
                self.run_id,
                url=str(item["canonical_url"]),
                outcome=outcome,
                fetched_at=captured_at,
                http_status=http_status,
                board_id=str(item["board_id"]),
                external_post_id=int(item["external_post_id"]),
                error_code=error_code,
                raw_sha256=raw_sha256,
                warc_file=warc_file,
                warc_record_id=_optional_text(item.get("warc_record_id")),
                lease=lease,
                frontier_state=frontier_state,
            )
            return item
        except Exception:
            try:
                self.store.record_outcome(
                    self.run_id,
                    url=lease.url,
                    outcome="parse_failed",
                    fetched_at=captured_at,
                    board_id=lease.board_id,
                    external_post_id=lease.external_post_id,
                    error_code="storage_error",
                    lease=lease,
                    frontier_state="retry",
                )
            except Exception:
                pass
            raise

    @staticmethod
    def _lease(item: Mapping[str, object]) -> FrontierLease:
        value = item.get("frontier_lease")
        if value is None:
            raise ValueError("captured post requires a frontier lease")
        if not isinstance(value, FrontierLease):
            raise ValueError("frontier_lease must be a FrontierLease")
        if (
            value.board_id != item.get("board_id")
            or value.external_post_id != item.get("external_post_id")
            or value.url != item.get("canonical_url")
        ):
            raise ValueError("frontier lease does not match captured post")
        return value
