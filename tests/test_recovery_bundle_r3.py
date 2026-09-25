"""Native regression tests for recovery bundle r3; all objects and DBs are temporary."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.text_archive import collector, importer, repair_recovery_status
from scripts.text_archive.recovery_metadata import metadata_fingerprint
from scripts.text_archive.recovery_status import write_rejection_status

BID = "20260925T000001Z-pc-aaaaaaaa"


def test_invalid_json_uses_terminal_error_type(tmp_path: Path) -> None:
    p = tmp_path / "manifest.json"
    p.write_bytes(b"{broken")
    with pytest.raises(importer.BatchRejectedError):
        importer._json_file(p, 16384)
    p.write_bytes(b"\xff")
    with pytest.raises(importer.BatchRejectedError):
        importer._json_file(p, 16384)


def test_rejection_status_and_next_ready_batch(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    bad = inbox / "drop" / BID
    bad.mkdir(parents=True)
    manifest = b"{broken"
    expected = hashlib.sha256(manifest).hexdigest()
    (bad / "manifest.json").write_bytes(manifest)
    (bad / "ready.json").write_text(
        json.dumps({"schema": 1, "batch_id": BID, "manifest_sha256": expected})
    )
    importer._record_batch_rejection(inbox, BID, "batch_json_invalid")
    status = json.loads((inbox / "receipts" / f"{BID}.status.json").read_bytes())
    assert status["manifest_sha256"] == expected
    second = "20260925T000002Z-pc-bbbbbbbb"
    ready = inbox / "drop" / second
    ready.mkdir()
    (ready / "ready.json").write_text("{}")
    assert importer._next_ready_batch(inbox) == second


def test_server_refuses_unbound_rejection(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    (inbox / "drop" / BID).mkdir(parents=True)
    assert not write_rejection_status(inbox, BID, "no_valid_binding")
    assert not (inbox / "receipts" / f"{BID}.status.json").exists()


def test_repair_status_is_idempotent_but_not_replaceable(tmp_path: Path) -> None:
    payload = {"schema": 1, "batch_status": "receipt_repair", "receipt": {"batch_id": BID}}
    repair_recovery_status.atomic_status(tmp_path, BID, payload)
    path = tmp_path / f"{BID}.status.json"
    original = path.read_bytes()
    repair_recovery_status.atomic_status(tmp_path, BID, payload)
    assert path.read_bytes() == original
    with pytest.raises(ValueError, match="existing terminal status"):
        repair_recovery_status.atomic_status(tmp_path, BID, {**payload, "receipt": {}})
    assert path.read_bytes() == original


def test_malformed_legacy_rejection_does_not_stop_repair(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    batch = inbox / "drop" / BID
    batch.mkdir(parents=True)
    (batch / "rejected.json").write_text("[]", encoding="utf-8")
    db_path = tmp_path / "archive.sqlite"
    importer._connect(db_path).close()
    assert repair_recovery_status.repair(inbox, db_path, tmp_path / "objects", False) == {
        "rejection_status": 0,
        "receipt_proof": 0,
        "manual_review": 1,
    }


def test_pc_owner_applies_before_selection(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REDSTM_TEXT_JSON_OWNER", "pc")
    calls: list[str | None] = []
    monkeypatch.setattr(collector, "_fill_body_queue", lambda *args: calls.append("body"))

    def select(_db: object, _sources: object, _now: int, body_source: str | None) -> None:
        calls.append(body_source)
        raise collector.CollectorError("no_due_collector_work")

    monkeypatch.setattr(collector, "_next_unit", select)
    with pytest.raises(collector.CollectorError):
        collector.run_one(
            tmp_path / "db.sqlite",
            tmp_path / "objects",
            collector.configured_sources({}),
            body_source="blacktoon",
        )
    assert calls == [None]


def test_catalog_total_change_advances_and_stays_partial(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "db.sqlite")
    try:
        db.executescript(collector._SCHEMA)
        with db:
            db.execute(
                "INSERT INTO text_collector_state"
                "(source,next_page,total_count,page_size,next_check_at,last_error,updated_at) "
                "VALUES('blacktoon:list',1,1000,96,0,'','now')"
            )
        unit = collector.RequestUnit(
            collector.Source("blacktoon", "blacktoon452.com"),
            "list",
            "1",
            "https://example.invalid",
        )
        result = collector._apply_list(
            db,
            unit,
            {
                "items": [{"id": 11, "title": "Book", "author": "Writer"}],
                "total": 1001,
                "size": 96,
                "page": 1,
            },
        )
        assert result["consistency"] == "observed_partial"
        row = db.execute(
            "SELECT next_page,total_count,last_error FROM text_collector_state "
            "WHERE source='blacktoon:list'"
        ).fetchone()
        assert tuple(row) == (2, 1001, "catalog_changed_during_scan")
    finally:
        db.close()


def test_equivalence_requires_object_integrity(tmp_path: Path) -> None:
    raw = b"Actual original paragraph.\n"
    sha = hashlib.sha256(raw).hexdigest()
    key = importer._store_object(tmp_path, raw, sha)
    pc = b"# Title\n# https://example.invalid/novel/1/2\n\n" + raw
    assert importer._equivalent_novel_text(tmp_path, key, pc)
    (tmp_path / key).write_bytes(b"Changed original paragraph.\n")
    assert not importer._equivalent_novel_text(tmp_path, key, pc)


def test_metadata_hash_changes_for_link_without_new_body(tmp_path: Path) -> None:
    dbpath = tmp_path / "db.sqlite"
    db = importer._connect(dbpath)
    try:
        with db:
            db.execute(
                """INSERT INTO text_archive_items(
                identity,lane,source_site,source_work_id,source_chapter_id,source_url,title,
                author,content_sha256,bytes,object_key,canonical_work_id,canonical_chapter_id,
                batch_id,imported_at) VALUES(
                'id','novel','blacktoon','1','2','url','Book','Writer',?,1,'key',
                'old','chapter','batch','now')""",
                ("a" * 64,),
            )
        old = metadata_fingerprint(dbpath, "novel")
        with db:
            db.execute(
                "UPDATE text_archive_items SET canonical_work_id='linked' WHERE identity='id'"
            )
        assert metadata_fingerprint(dbpath, "novel") != old
    finally:
        db.close()
