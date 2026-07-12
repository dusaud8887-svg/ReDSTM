from __future__ import annotations

from pathlib import Path

import pytest

import crawler.archive_pipeline as archive_pipeline_module
from crawler.archive import connect_archive, initialize_archive
from crawler.archive_pipeline import ArchivePipeline
from crawler.frontier import FrontierLease, FrontierStore
from crawler.items import CapturedPostItem
from crawler.store import ArchiveStore


def _setup(path: Path) -> tuple[ArchivePipeline, FrontierStore, str]:
    initialize_archive(path)
    with connect_archive(path) as connection:
        connection.execute(
            """
            INSERT INTO boards (
                board_id, name, canonical_url, first_seen_at, last_seen_at
            ) VALUES ('write_free21', 'Board', 'https://www.typemoon.net/write_free21',
                      '2026-07-11T00:00:00+00:00', '2026-07-11T00:00:00+00:00')
            """
        )
    store = ArchiveStore(path)
    run_id = store.start_run("sync")
    return ArchivePipeline(path, run_id), FrontierStore(path), run_id


def _claim(frontier: FrontierStore, post_id: int) -> FrontierLease:
    url = f"https://www.typemoon.net/write_free21/{post_id}"
    frontier.seed("write_free21", post_id, url)
    lease = frontier.claim_identity("write_free21", post_id, lease_seconds=60)
    assert lease is not None
    return lease


def _item(lease: FrontierLease, outcome: str) -> CapturedPostItem:
    values: dict[str, object] = {
        "board_id": lease.board_id,
        "external_post_id": lease.external_post_id,
        "canonical_url": lease.url,
        "outcome": outcome,
        "http_status": 200,
        "raw_sha256": "a" * 64,
        "warc_file": "capture.warc.gz",
        "warc_record_id": "<urn:uuid:test>",
        "frontier_lease": lease,
        "warnings": ["secret fixture text must not enter the ledger"],
    }
    if outcome == "stored":
        values.update(title="Title", views=1, body_html="<p>Body</p>", comments=[])
    elif outcome == "fetch_failed":
        values["error_code"] = "auth_required"
    return CapturedPostItem(values)


def test_pipeline_stores_post_and_completes_lease_atomically(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    pipeline, frontier, run_id = _setup(path)
    lease = _claim(frontier, 1)

    item = _item(lease, "stored")
    assert pipeline.process_item(item) is item

    with connect_archive(path) as connection:
        capture = connection.execute(
            "SELECT outcome, raw_sha256, warc_file FROM captures WHERE run_id = ?", (run_id,)
        ).fetchone()
        frontier_row = connection.execute(
            """
            SELECT state FROM crawl_frontier
            WHERE board_id = ? AND external_post_id = ?
            """,
            (lease.board_id, lease.external_post_id),
        ).fetchone()
    assert tuple(capture) == ("stored", "a" * 64, "capture.warc.gz")
    assert tuple(frontier_row) == ("done",)


@pytest.mark.parametrize(
    ("outcome", "expected_state", "error_code"),
    [
        ("restricted", "done", "permission_denied"),
        ("parse_failed", "dead", "parse_drift"),
        ("fetch_failed", "retry", "auth_required"),
    ],
)
def test_pipeline_records_terminal_outcome_without_warning_text(
    tmp_path: Path, outcome: str, expected_state: str, error_code: str
) -> None:
    path = tmp_path / "archive.sqlite"
    pipeline, frontier, run_id = _setup(path)
    lease = _claim(frontier, 2)

    pipeline.process_item(_item(lease, outcome))

    with connect_archive(path) as connection:
        capture = connection.execute(
            "SELECT outcome, error_code FROM captures WHERE run_id = ?", (run_id,)
        ).fetchone()
        frontier_row = connection.execute(
            """
            SELECT state, last_error_code, lease_token
            FROM crawl_frontier WHERE board_id = ? AND external_post_id = ?
            """,
            (lease.board_id, lease.external_post_id),
        ).fetchone()
    assert tuple(capture) == (outcome, error_code)
    assert tuple(frontier_row) == (expected_state, error_code, None)


def test_pipeline_rejects_mismatched_lease_before_writing(tmp_path: Path) -> None:
    path = tmp_path / "archive.sqlite"
    pipeline, frontier, run_id = _setup(path)
    lease = _claim(frontier, 3)
    item = _item(lease, "restricted")
    item["external_post_id"] = 4

    with pytest.raises(ValueError, match="does not match"):
        pipeline.process_item(item)

    with connect_archive(path) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM captures WHERE run_id = ?", (run_id,)
            ).fetchone()[0]
            == 0
        )
        assert (
            connection.execute(
                "SELECT state FROM crawl_frontier WHERE board_id = ? AND external_post_id = ?",
                (lease.board_id, lease.external_post_id),
            ).fetchone()[0]
            == "running"
        )


def test_pipeline_records_storage_error_before_reraising(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "archive.sqlite"
    pipeline, frontier, run_id = _setup(path)
    lease = _claim(frontier, 4)

    def fail_normalize(item: CapturedPostItem) -> None:
        raise ValueError("invalid normalized content")

    monkeypatch.setattr(archive_pipeline_module, "normalize_captured_post", fail_normalize)
    with pytest.raises(ValueError, match="invalid normalized content"):
        pipeline.process_item(_item(lease, "stored"))

    with connect_archive(path, read_only=True) as connection:
        assert tuple(
            connection.execute(
                "SELECT outcome, error_code FROM captures WHERE run_id = ?", (run_id,)
            ).fetchone()
        ) == ("parse_failed", "storage_error")
        assert tuple(
            connection.execute(
                "SELECT state FROM crawl_frontier WHERE external_post_id = 4"
            ).fetchone()
        ) == ("retry",)
