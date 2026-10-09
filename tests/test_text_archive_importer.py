from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from scripts.text_archive import importer, publisher, runtime, status

_ROOT = Path(__file__).parent
_FIXTURE = _ROOT / "fixtures" / "text_archive_contract.json"
_BATCHES = (
    "20260923T120000Z-pc-00000001",
    "20260923T120001Z-pc-00000002",
    "20260923T120002Z-pc-00000003",
    "20260923T120003Z-pc-00000004",
)


@pytest.fixture
def cli_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Point every production path the importer CLI touches at tmp_path; a missed one
    (e.g. the attempts root) would otherwise write under /srv and fail on CI."""
    inbox, attempts = tmp_path / "inbox", tmp_path / "attempts"
    monkeypatch.setattr(importer, "_INBOX_ROOT", inbox)
    monkeypatch.setattr(importer, "_DB_PATH", tmp_path / "text.sqlite")
    monkeypatch.setattr(importer, "_OBJECT_ROOT", tmp_path / "objects")
    monkeypatch.setattr(importer, "_ATTEMPTS_ROOT", attempts)
    monkeypatch.setattr(importer, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(sys, "argv", ["importer"])
    return inbox, attempts


def test_manual_document_import_publish_duplicate_and_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "_window", nullcontext)
    identity = "manual:" + "a" * 64
    item: dict[str, object] = {
        "kind": "manual_document",
        "identity": identity,
        "title": "1~5권",
        "created_at": "2026-10-01T12:00:00+09:00",
        "folder": "작품/회차",
        "source_url": "",
    }
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    body = "# 본문 첫 줄은 제목이 아님\n원본: 본문 그대로\n".encode()
    _batch(inbox, _BATCHES[0], body=body, item=item)
    receipt = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "accepted"
    tree = publisher.build_publish_tree(db_path, objects, tmp_path / "build", "manual")
    release = json.loads((tmp_path / "build" / tree["release_key"]).read_text(encoding="utf-8"))
    page_path = tmp_path / "build" / release["catalog_pages"][0]["key"]
    page = json.loads(page_path.read_text(encoding="utf-8"))
    document = page["items"][0]
    assert document["title"] == "1~5권"
    assert document["created_at"] == item["created_at"]
    assert document["category"] == "작품/회차"
    with sqlite3.connect(db_path) as db:
        row = db.execute("SELECT lane,title,object_key FROM text_archive_items").fetchone()
    assert row[:2] == ("manual", "1~5권")
    assert (objects / row[2]).read_bytes() == body
    _batch(inbox, _BATCHES[1], body=body, item=item)
    receipt = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "duplicate"
    # The user's own file changed (an edit or a corrected decode): the newer body replaces it.
    _batch(inbox, _BATCHES[2], body=b"modified", item=item)
    receipt = importer.import_batch(inbox, _BATCHES[2], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "accepted"
    assert receipt["items"][0]["content_sha256"] == hashlib.sha256(b"modified").hexdigest()
    with sqlite3.connect(db_path) as db:
        replaced = db.execute("SELECT content_sha256,object_key FROM text_archive_items").fetchone()
        assert db.execute("SELECT COUNT(*) FROM text_archive_conflicts").fetchone()[0] == 0
    assert replaced[0] == hashlib.sha256(b"modified").hexdigest()
    assert (objects / replaced[1]).read_bytes() == b"modified"
    assert (objects / row[2]).read_bytes() == body
    # 2026-10-09 review ③: the same body under a new scan root carries a new folder.
    _batch(inbox, _BATCHES[3], body=b"modified", item={**item, "folder": "책장/작품/회차"})
    receipt = importer.import_batch(inbox, _BATCHES[3], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "duplicate"
    tree = publisher.build_publish_tree(db_path, objects, tmp_path / "build2", "manual")
    release = json.loads((tmp_path / "build2" / tree["release_key"]).read_text(encoding="utf-8"))
    page = json.loads(
        (tmp_path / "build2" / release["catalog_pages"][0]["key"]).read_text(encoding="utf-8")
    )
    assert page["items"][0]["category"] == "책장/작품/회차"


def test_a_requested_receipt_is_written_again_from_the_database(tmp_path: Path) -> None:
    # 2026-10-09 review JT-01: the PC was off past the 60-day receipt retention.
    inbox, db_path, objects = tmp_path / "inbox", tmp_path / "archive.db", tmp_path / "objects"
    receipts = inbox / "receipts"
    _batch(inbox, _BATCHES[0])
    receipt = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert receipt is not None
    final = {**receipt, "revision": 2}
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE text_archive_batches SET revision=2,receipt_json=? WHERE batch_id=?",
            (json.dumps(final, sort_keys=True), _BATCHES[0]),
        )
    db.close()
    (receipts / f"{_BATCHES[0]}.json").unlink()
    assert importer.restore_requested_receipts(inbox, db_path) == []  # nothing requested
    (inbox / "drop" / f".receipt-request-{_BATCHES[0]}").mkdir()
    (inbox / "drop" / ".receipt-request-20260101T000000Z-pc-ffffffff").mkdir()  # unknown
    assert importer.restore_requested_receipts(inbox, db_path) == [_BATCHES[0]]
    restored = json.loads((receipts / f"{_BATCHES[0]}.json").read_text(encoding="utf-8"))
    assert restored["revision"] == 2 and restored["manifest_sha256"] == receipt["manifest_sha256"]
    # A receipt already at the database revision is left alone; a stale one is replaced.
    assert importer.restore_requested_receipts(inbox, db_path) == []
    (receipts / f"{_BATCHES[0]}.json").write_text(json.dumps(receipt), encoding="utf-8")
    assert importer.restore_requested_receipts(inbox, db_path) == [_BATCHES[0]]
    assert importer._next_ready_batch(inbox) is None  # request folders are never batches


@pytest.mark.parametrize(
    "change",
    [
        {"created_at": "yesterday"},
        {"created_at": "2026-10-01T12:00:00"},
        {"folder": "../escape"},
        {"identity": "arcalive:novel:1:text"},
        {"source_url": "file:///private"},
    ],
)
def test_manual_document_rejects_invalid_metadata(change: dict[str, str]) -> None:
    item = {
        "kind": "manual_document",
        "identity": "manual:" + "a" * 64,
        "title": "제목",
        "created_at": "2026-10-01T12:00:00Z",
        "folder": ".",
        "source_url": "",
    }
    assert not importer._identity_matches({**item, **change})[0]


def test_large_manual_utf8_validation_is_bounded(tmp_path: Path) -> None:
    item: dict[str, object] = {
        "kind": "manual_document",
        "identity": "manual:" + "b" * 64,
        "title": "여러 권",
        "created_at": "2026-10-01T12:00:00Z",
        "folder": ".",
        "source_url": "",
    }
    # One non-BMP character would expand a full decoded ASCII body fourfold.
    body = b"a" * (3 * 1024 * 1024 - 1) + "😀".encode()
    inbox = tmp_path / "inbox"
    _batch(inbox, _BATCHES[0], body=body, item=item)
    tracemalloc.start()
    try:
        _, _, _, validation = importer._safe_batch(inbox, _BATCHES[0])
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert validation["candidates"][0]["reason"] == ""
    assert peak < len(body) * 2
    receipt = importer.import_batch(
        inbox, _BATCHES[0], tmp_path / "db", tmp_path / "objects", tmp_path / "receipts"
    )
    assert receipt is not None
    assert receipt["items"][0]["status"] == "accepted"


def test_bookkor_chapter_identity_requires_matching_work_and_chapter() -> None:
    item = {
        "kind": "novel_chapter",
        "site": "bookkor",
        "source_work_id": "4522",
        "source_chapter_id": "8675541",
        "identity": "novel_chapter:bookkor:4522:8675541",
        "source_url": "https://001.bookkor.com/sample-2/4522-ep-8675541",
    }
    assert importer._identity_matches(item)[0]
    assert not importer._identity_matches(
        {**item, "source_url": "https://001.bookkor.com/sample-2/4523-ep-8675541"}
    )[0]


def test_toonkor_chapter_identity_accepts_only_its_source_host() -> None:
    item = {
        "kind": "novel_chapter",
        "site": "toonkor",
        "source_work_id": "24960",
        "source_chapter_id": "837742",
        "identity": "novel_chapter:toonkor:24960:837742",
        "source_url": "https://toonkor404.com/novel/24960/837742",
    }
    assert importer._identity_matches(item)[0]
    assert not importer._identity_matches(
        {
            **item,
            "source_url": "https://blacktoon454.com/novel/24960/837742",
        }
    )[0]


def test_concurrent_connections_serialize_identity_migrations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "text.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript(importer._SCHEMA)
        db.execute(
            "INSERT INTO text_novel_sources(site,source_work_id,last_seen_at) VALUES(?,?,?)",
            ("blacktoon", "1", "2026-09-25T00:00:00Z"),
        )
    migrate = importer._migrate_stable_work_ids

    def check_migration_lock(db: sqlite3.Connection) -> None:
        assert db.in_transaction
        migrate(db)

    def connect_and_close(path: Path) -> None:
        importer._connect(path).close()

    monkeypatch.setattr(importer, "_migrate_stable_work_ids", check_migration_lock)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(connect_and_close, (path, path)))
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM text_novel_work_group_sources").fetchone() == (1,)
        assert db.execute("SELECT COUNT(*) FROM text_novel_identity_migrations").fetchone() == (3,)


def _batch(
    root: Path,
    batch_id: str,
    *,
    body: bytes = b"fixture body",
    ready: bool = True,
    item: dict[str, object] | None = None,
) -> Path:
    batch_dir = root / "drop" / batch_id
    files = batch_dir / "files"
    files.mkdir(parents=True)
    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    metadata = dict(fixture["item"] if item is None else item)
    metadata["bytes"] = len(body)
    metadata["sha256"] = hashlib.sha256(body).hexdigest()
    metadata.setdefault("relative_path", "files/000001.md")
    if re.fullmatch(r"files/[0-9]{6}\.md", str(metadata["relative_path"])):
        (files / Path(str(metadata["relative_path"])).name).write_bytes(body)
    manifest = {
        "schema": 1,
        "batch_id": batch_id,
        "producer": "newtomi-pc",
        "items": [metadata],
    }
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (batch_dir / "manifest.json").write_bytes(raw)
    if ready:
        (batch_dir / "ready.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "batch_id": batch_id,
                    "manifest_sha256": hashlib.sha256(raw).hexdigest(),
                }
            ),
            encoding="utf-8",
        )
    return batch_dir


def _process_status(tmp_path: Path, rss_kb: int = 100_000) -> Path:
    status = tmp_path / "proc-status"
    status.write_text(f"VmRSS: {rss_kb} kB\n", encoding="ascii")
    return status


def test_contract_fixture_hash_and_copies_match() -> None:
    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    body = fixture["body"]["text"].encode(fixture["body"]["encoding"])
    assert fixture["schema"] == 1
    assert len(body) == fixture["body"]["bytes"]
    assert hashlib.sha256(body).hexdigest() == fixture["body"]["sha256"]
    assert fixture["limits"]["availability_page_items"] == publisher._AVAILABILITY_PAGE_SIZE
    assert fixture["limits"]["availability_page_bytes"] == publisher._AVAILABILITY_PAGE_BYTES
    for newtomi_copy in (
        Path(r"E:\newtomi\tests\fixtures\text_archive_contract.json"),
        Path(__file__).resolve().parents[2]
        / "newtomi"
        / "tests"
        / "fixtures"
        / "text_archive_contract.json",
    ):
        if newtomi_copy.is_file():
            assert fixture == json.loads(newtomi_copy.read_text(encoding="utf-8"))


def test_importer_accepts_more_than_twenty_items_but_caps_total_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inbox = tmp_path / "inbox"
    batch = _batch(inbox, _BATCHES[0])
    manifest_path = batch / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    first = manifest["items"][0]
    for number in range(2, 22):
        item = dict(first)
        item.update(
            identity=f"arcalive:novel:{1000 + number}:text",
            post_id=str(1000 + number),
            source_url=f"https://arca.live/b/novel/{1000 + number}",
            relative_path=f"files/{number:06d}.md",
        )
        (batch / item["relative_path"]).write_bytes(b"fixture body")
        manifest["items"].append(item)
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    manifest_path.write_bytes(raw)
    (batch / "ready.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "batch_id": _BATCHES[0],
                "manifest_sha256": hashlib.sha256(raw).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    assert len(importer._safe_batch(inbox, _BATCHES[0])[3]["candidates"]) == 21
    monkeypatch.setattr(importer, "_MAX_BATCH_BYTES", 20 * len(b"fixture body"))
    with pytest.raises(importer.BatchRejectedError, match="batch_too_large"):
        importer._safe_batch(inbox, _BATCHES[0])


def test_arcalive_import_uses_post_title_for_reader(tmp_path: Path) -> None:
    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    item = dict(fixture["item"])
    item["title"] = "실제 글 제목"
    inbox = tmp_path / "inbox"
    _batch(inbox, _BATCHES[0], item=item)
    db_path = tmp_path / "text.sqlite"
    receipt = importer.import_batch(
        inbox, _BATCHES[0], db_path, tmp_path / "objects", tmp_path / "receipts"
    )
    assert receipt is not None and receipt["items"][0]["status"] == "accepted"
    with importer._connect(db_path) as db:
        assert tuple(
            db.execute("SELECT title,source_category FROM text_archive_items").fetchone()
        ) == ("실제 글 제목", "소설")


def test_next_ready_batch_skips_already_imported_batch(tmp_path: Path) -> None:
    _batch(tmp_path, _BATCHES[0])
    _batch(tmp_path, _BATCHES[1])
    receipts = tmp_path / "receipts"
    receipts.mkdir()
    (receipts / f"{_BATCHES[0]}.json").write_text("{}", encoding="utf-8")
    assert importer._next_ready_batch(tmp_path) == _BATCHES[1]


def test_ambiguous_novel_link_can_be_promoted_without_canary(tmp_path: Path) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    now = "2026-09-23T12:00:00Z"
    with db:
        for site, work_id, source_url in (
            ("blacktoon", "24753", "https://blacktoon452.com/novel/24753"),
            ("toki", "63670", "https://toki31.com/novel/63670"),
        ):
            db.execute(
                """INSERT INTO text_novel_sources(
                       site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (site, work_id, source_url, work_id, "에피소드", "작가", "에피소드", "작가", now),
            )
            db.execute(
                """INSERT INTO text_archive_items(
                       identity,lane,source_site,source_work_id,source_chapter_id,source_url,
                       title,author,chapter_label,chapter_kind,access,content_sha256,bytes,
                       object_key,canonical_work_id,canonical_chapter_id,batch_id,imported_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    f"novel_chapter:{site}:{work_id}:1",
                    "novel",
                    site,
                    work_id,
                    "1",
                    source_url + "/1",
                    "에피소드",
                    "작가",
                    "1화",
                    "main",
                    "free",
                    "a" * 64,
                    1,
                    "objects/sha256/aa/" + "a" * 64 + ".md",
                    f"novel:{site}:{work_id}",
                    f"novel:{site}:{work_id}:1",
                    "fixture",
                    now,
                ),
            )
        importer._refresh_link_candidates(db, "toki", "63670")
    db.close()

    candidates = importer.list_novel_link_candidates(db_path)
    assert len(candidates) == 1
    assert candidates[0]["match_basis"] == "normalized_title_author"
    candidate = candidates[0]
    assert (candidate["left_site"], candidate["left_work_id"]) == ("blacktoon", "24753")
    assert (candidate["right_site"], candidate["right_work_id"]) == ("toki", "63670")
    result = importer.resolve_novel_link_candidate(
        db_path,
        "blacktoon",
        "24753",
        "toki",
        "63670",
        accept=True,
    )
    assert result["status"] == "accepted"
    assert result["canonical_work_id"].startswith("novel:")
    assert len(result["canonical_work_id"].removeprefix("novel:")) == 36
    db = importer._connect(db_path)
    try:
        mappings = db.execute(
            "SELECT site,source_work_id,canonical_work_id FROM text_novel_work_group_sources"
        ).fetchall()
        assert {tuple(row) for row in mappings} == {
            ("blacktoon", "24753", result["canonical_work_id"]),
            ("toki", "63670", result["canonical_work_id"]),
        }
        assert {
            row[0]
            for row in db.execute(
                "SELECT DISTINCT canonical_work_id FROM text_archive_items WHERE lane='novel'"
            )
        } == {result["canonical_work_id"]}
        assert (
            importer._canonical_ids(
                {"source_work_id": "63670", "source_chapter_id": "2"}, "novel", "toki", db
            )[0]
            == result["canonical_work_id"]
        )
        importer._refresh_link_candidates(db, "toki", "63670")
        assert (
            db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "accepted"
        )
    finally:
        db.close()


@pytest.mark.parametrize(
    ("digests", "author", "linked"),
    [
        (("a" * 64, "b" * 64), "작가", True),
        (("a" * 64, "a" * 64), "작가", False),
        (("a" * 64, "b" * 64), "작가 미상", False),
    ],
)
def test_unique_title_author_and_matching_body_hashes_auto_link(
    tmp_path: Path, digests: tuple[str, str], author: str, linked: bool
) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    with db:
        for site, work_id in (("blacktoon", "24753"), ("toki", "63670")):
            db.execute(
                """INSERT INTO text_novel_sources(
                   site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (
                    site,
                    work_id,
                    work_id,
                    "고유 작품",
                    author,
                    importer._title_key("고유 작품"),
                    importer._title_key(author),
                    "now",
                ),
            )
            importer._canonical_work_id(db, site, work_id)
            for chapter_id, digest in zip(("1", "2"), digests, strict=True):
                db.execute(
                    """INSERT INTO text_novel_chapters(
                       site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                       access,content_sha256,text_sha256,status,last_seen_at)
                       VALUES(?,?,?,?,'main','free',?,?,'complete','now')""",
                    (site, work_id, chapter_id, f"{chapter_id}화", digest, digest),
                )
            importer._refresh_link_candidates(db, site, work_id)
    rows = db.execute(
        "SELECT canonical_work_id FROM text_novel_work_group_sources ORDER BY site"
    ).fetchall()
    assert len(rows) == 2 and (rows[0][0] == rows[1][0]) is linked
    assert db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == (
        "auto_accepted" if linked else "candidate"
    )
    db.close()


def test_punctuation_and_label_overlap_do_not_auto_link_editions(tmp_path: Path) -> None:
    assert importer._chapter_key("1.5화", "main") != importer._chapter_key("15화", "main")
    assert importer._chapter_key("1-2화", "main") != importer._chapter_key("12화", "main")
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        with db:
            for site, work_id in (("blacktoon", "1"), ("marumaru", "2")):
                db.execute(
                    """INSERT INTO text_novel_sources(
                       site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (site, work_id, work_id, "Same", "Author", "same", "author", "now"),
                )
                importer._canonical_work_id(db, site, work_id)
                for number in range(1, 11):
                    db.execute(
                        """INSERT INTO text_novel_chapters(
                           site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                           access,content_sha256,status,last_seen_at)
                           VALUES(?,?,?,?,'main','free',?,'complete','now')""",
                        (
                            site,
                            work_id,
                            str(number),
                            f"{number}화",
                            hashlib.sha256(f"{site}:{number}".encode()).hexdigest(),
                        ),
                    )
                importer._refresh_link_candidates(db, site, work_id)
        assert (
            db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "candidate"
        )
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT canonical_work_id) FROM text_novel_work_group_sources"
            ).fetchone()[0]
            == 2
        )
    finally:
        db.close()


def test_matching_body_hashes_at_different_chapter_positions_do_not_link(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        with db:
            for site, work_id, offset in (("blacktoon", "1", 0), ("marumaru", "2", 10)):
                db.execute(
                    """INSERT INTO text_novel_sources(
                       site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (site, work_id, work_id, "Same", "Author", "same", "author", "now"),
                )
                importer._canonical_work_id(db, site, work_id)
                for number, digest in ((1, "a" * 64), (2, "b" * 64)):
                    db.execute(
                        """INSERT INTO text_novel_chapters(
                           site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                           access,content_sha256,text_sha256,status,last_seen_at)
                           VALUES(?,?,?,?,'main','free',?,?,'complete','now')""",
                        (site, work_id, str(number), f"{number + offset}화", digest, digest),
                    )
                importer._refresh_link_candidates(db, site, work_id)
        assert (
            db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "candidate"
        )
    finally:
        db.close()


def test_old_label_only_link_is_split_and_covered_requeued(tmp_path: Path) -> None:
    path = tmp_path / "text.sqlite"
    db = importer._connect(path)
    with db:
        db.execute("DELETE FROM text_novel_identity_migrations WHERE version=3")
        db.execute("INSERT INTO text_novel_work_groups VALUES('old','now')")
        db.executemany(
            "INSERT INTO text_novel_work_group_sources VALUES(?,?,'old')",
            [("blacktoon", "1"), ("marumaru", "2")],
        )
        db.execute(
            """INSERT INTO text_novel_link_candidates VALUES(
               'blacktoon','1','marumaru','2','normalized_title_author+chapter_sequence',
               'auto_accepted','now')"""
        )
        db.execute(
            """INSERT INTO text_novel_chapters(site,source_work_id,source_chapter_id,
               chapter_label,chapter_kind,access,status,last_seen_at)
               VALUES('marumaru','2','1','1화','main','free','covered','now')"""
        )
    db.close()
    db = importer._connect(path)
    try:
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT canonical_work_id) FROM text_novel_work_group_sources"
            ).fetchone()[0]
            == 2
        )
        assert db.execute("SELECT status FROM text_novel_chapters").fetchone()[0] == "discovered"
        assert (
            db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "candidate"
        )
    finally:
        db.close()


@pytest.mark.parametrize("split", [False, True])
def test_three_source_weak_merge_has_explicit_group_resolution(tmp_path: Path, split: bool) -> None:
    path = tmp_path / "text.sqlite"
    db = importer._connect(path)
    with db:
        db.execute("INSERT INTO text_novel_work_groups VALUES('old','now')")
        for site, work in [("blacktoon", "1"), ("marumaru", "2"), ("toki", "3")]:
            db.execute("INSERT INTO text_novel_work_group_sources VALUES(?,?,'old')", (site, work))
            db.execute(
                "INSERT INTO text_novel_work_aliases VALUES(?,'old','now')",
                (f"novel:{site}:{work}",),
            )
        db.execute(
            "INSERT INTO text_novel_link_candidates VALUES('blacktoon','1','marumaru','2',"
            "'normalized_title_author+chapter_sequence','needs_review','now')"
        )
    db.close()
    result = importer.resolve_novel_review_group(path, "old", split=split)
    assert result["status"] == ("split" if split else "kept")
    db = importer._connect(path, read_only=True)
    try:
        groups = db.execute(
            "SELECT site,canonical_work_id FROM text_novel_work_group_sources ORDER BY site"
        ).fetchall()
        assert groups[0][1] == "old"
        assert len({row[1] for row in groups}) == (3 if split else 1)
        assert db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == (
            "rejected" if split else "accepted"
        )
        assert (
            db.execute(
                "SELECT COUNT(*) FROM text_novel_work_aliases a "
                "JOIN text_novel_work_group_sources s "
                "ON a.alias_work_id='novel:'||s.site||':'||s.source_work_id "
                "WHERE a.canonical_work_id=s.canonical_work_id"
            ).fetchone()[0]
            == 3
        )
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        db.close()
    with pytest.raises(KeyError):
        importer.resolve_novel_review_group(path, "old", split=split)


def test_initialized_text_connections_do_not_migrate_or_wait_for_a_writer(tmp_path: Path) -> None:
    path = tmp_path / "text.sqlite"
    db = importer._connect(path)
    db.execute("BEGIN IMMEDIATE")
    try:
        started = time.monotonic()
        for read_only in [False, True]:
            reader = importer._connect(path, read_only=read_only)
            try:
                assert reader.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 0
                assert reader.total_changes == 0
                assert not reader.in_transaction
                if read_only:
                    with pytest.raises(sqlite3.OperationalError, match="readonly"):
                        reader.execute("DELETE FROM text_archive_items")
            finally:
                reader.close()
        assert time.monotonic() - started < 2
    finally:
        db.rollback()
        db.close()


def test_three_source_weak_merge_remains_flagged_for_review(tmp_path: Path) -> None:
    path = tmp_path / "text.sqlite"
    db = importer._connect(path)
    with db:
        db.execute("DELETE FROM text_novel_identity_migrations WHERE version=3")
        db.execute("INSERT INTO text_novel_work_groups VALUES('old','now')")
        db.executemany(
            "INSERT INTO text_novel_work_group_sources VALUES(?,?,'old')",
            [("blacktoon", "1"), ("marumaru", "2"), ("toki", "3")],
        )
        db.execute(
            """INSERT INTO text_novel_link_candidates VALUES(
               'blacktoon','1','marumaru','2','normalized_title_author+chapter_sequence',
               'auto_accepted','now')"""
        )
    db.close()
    db = importer._connect(path)
    try:
        assert db.execute("SELECT status,match_basis FROM text_novel_link_candidates").fetchone()[
            :
        ] == ("needs_review", "normalized_title_author+chapter_sequence")
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT canonical_work_id) FROM text_novel_work_group_sources"
            ).fetchone()[0]
            == 1
        )
    finally:
        db.close()


def test_same_title_without_distinguishing_evidence_stays_unlinked(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    with db:
        for site, work_id in (("blacktoon", "24753"), ("toki", "63670")):
            db.execute(
                """INSERT INTO text_novel_sources(
                   site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (site, work_id, work_id, "동명 작품", "작가", "동명 작품", "작가", "now"),
            )
            importer._canonical_work_id(db, site, work_id)
            db.execute(
                """INSERT INTO text_novel_chapters(
                   site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                   access,status,last_seen_at)
                   VALUES(?,?,?,'1화','main','free','discovered','now')""",
                (site, work_id, "1"),
            )
            importer._refresh_link_candidates(db, site, work_id)
    assert db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "candidate"
    assert (
        len(
            {
                row[0]
                for row in db.execute("SELECT canonical_work_id FROM text_novel_work_group_sources")
            }
        )
        == 2
    )
    db.close()


def test_title_key_folds_width_spacing_and_punctuation() -> None:
    assert importer._title_key("［Ｒead　Me］ - 외전!") == "readme외전"


def test_legacy_work_ids_migrate_to_stable_ids_and_keep_aliases(tmp_path: Path) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    with db:
        db.execute("DELETE FROM text_novel_identity_migrations WHERE version=1")
        db.execute("INSERT INTO text_novel_work_groups VALUES('novel:linked:legacy','now')")
        for site, work_id in (("toki", "63670"), ("blacktoon", "24753")):
            db.execute(
                """INSERT INTO text_novel_sources(
                   site,source_work_id,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?, '작품','작가','작품','작가','now')""",
                (site, work_id),
            )
            db.execute(
                "INSERT INTO text_novel_work_group_sources VALUES(?,?,?)",
                (site, work_id, "novel:linked:legacy"),
            )
        db.execute(
            """INSERT INTO text_archive_items(
               identity,lane,source_site,source_work_id,source_chapter_id,source_url,title,
               author,chapter_label,chapter_kind,access,content_sha256,bytes,object_key,
               canonical_work_id,canonical_chapter_id,batch_id,imported_at)
               VALUES('novel_chapter:toki:63670:1','novel','toki','63670','1',
               'https://toki31.com/novel/63670/1','작품','작가','1화','main','free',
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,
               'objects/sha256/aa/fixture.md','novel:linked:legacy',
               'novel_chapter:toki:63670:1','fixture','now')"""
        )
    db.close()
    db = importer._connect(db_path)
    try:
        canonical = db.execute(
            "SELECT canonical_work_id FROM text_novel_work_group_sources"
        ).fetchone()[0]
        assert canonical.startswith("novel:") and canonical != "novel:toki:63670"
        aliases = {
            row[0]
            for row in db.execute(
                "SELECT alias_work_id FROM text_novel_work_aliases WHERE canonical_work_id=?",
                (canonical,),
            )
        }
        assert {"novel:linked:legacy", "novel:toki:63670"} <= aliases
        assert (
            db.execute(
                "SELECT canonical_work_id FROM text_archive_items WHERE lane='novel'"
            ).fetchone()[0]
            == canonical
        )
    finally:
        db.close()


def test_existing_cross_site_works_are_listed_without_shared_slug(tmp_path: Path) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    with db:
        for site, work_id in (("blacktoon", "24753"), ("toki", "63670")):
            db.execute(
                """INSERT INTO text_novel_sources(
                   site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (site, work_id, work_id, "에피소드", "작가", "에피소드", "작가", "now"),
            )
    db.close()
    candidates = importer.list_novel_link_candidates(db_path)
    assert [(row["left_site"], row["right_site"], row["match_basis"]) for row in candidates] == [
        ("blacktoon", "toki", "normalized_title_author")
    ]


def test_novel_link_rejection_does_not_create_group(tmp_path: Path) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    with db:
        for site, work_id in (("blacktoon", "24753"), ("toki", "63670")):
            db.execute(
                """INSERT INTO text_novel_sources(
                       site,source_work_id,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (site, work_id, "63670", "에피소드", "작가", "에피소드", "작가", "now"),
            )
        importer._refresh_link_candidates(db, "toki", "63670")
    db.close()
    result = importer.resolve_novel_link_candidate(
        db_path, "blacktoon", "24753", "toki", "63670", accept=False
    )
    assert result["status"] == "rejected"
    db = importer._connect(db_path)
    try:
        assert db.execute("SELECT COUNT(*) FROM text_novel_work_groups").fetchone()[0] == 0
        assert (
            db.execute("SELECT status FROM text_novel_link_candidates").fetchone()[0] == "rejected"
        )
    finally:
        db.close()


def test_import_is_idempotent_and_holds_changed_source_content(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    db_path = tmp_path / "state" / "text.sqlite"
    objects = tmp_path / "state" / "objects"
    receipts = inbox / "receipts"
    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    item = dict(fixture["item"])

    _batch(inbox, _BATCHES[0], item=item)
    accepted = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert accepted is not None
    assert accepted["items"][0]["status"] == fixture["expected"]["first_import"]
    assert accepted["items"][0]["canonical_chapter_id"] == item["identity"]
    assert (
        objects
        / "objects"
        / "sha256"
        / fixture["body"]["sha256"][:2]
        / f"{fixture['body']['sha256']}.md"
    ).read_bytes() == b"fixture body"

    _batch(inbox, _BATCHES[1], item=item)
    duplicate = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert duplicate is not None
    assert duplicate["items"][0]["status"] == fixture["expected"]["same_identity_same_sha"]

    _batch(inbox, _BATCHES[2], body=b"changed body", item=item)
    conflict = importer.import_batch(inbox, _BATCHES[2], db_path, objects, receipts)
    assert conflict is not None
    assert conflict["items"][0]["status"] == fixture["expected"]["same_identity_different_sha"]

    changed_identity = dict(item)
    changed_identity.update(
        {
            "identity": "arcalive:novel:109:text",
            "post_id": "109",
            "source_url": "https://arca.live/b/novel/109",
        }
    )
    _batch(inbox, _BATCHES[3], item=changed_identity)
    shared = importer.import_batch(inbox, _BATCHES[3], db_path, objects, receipts)
    assert shared is not None
    assert shared["items"][0]["status"] == "accepted"

    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM text_archive_objects").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 2
        assert db.execute("SELECT COUNT(*) FROM text_archive_conflicts").fetchone()[0] == 1
    for batch_id in _BATCHES:
        assert json.loads((receipts / f"{batch_id}.json").read_text())["revision"] == 1


def test_novel_import_keeps_source_ids_and_records_only_a_link_candidate(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    db_path = tmp_path / "state" / "text.sqlite"
    objects = tmp_path / "state" / "objects"
    receipts = inbox / "receipts"
    db = importer._connect(db_path)
    with db:
        db.execute(
            """INSERT INTO text_novel_sources(
                   site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
               VALUES('blacktoon','24753','https://blacktoon452.com/novel/24753',
                      '63670','Shared Book','A Writer',?,?, 'now')""",
            (importer._title_key("Shared Book"), importer._title_key("A Writer")),
        )
    db.close()
    novel: dict[str, object] = {
        "identity": "novel_chapter:toki:63670:8794077",
        "kind": "novel_chapter",
        "site": "toki",
        "source_work_id": "63670",
        "source_chapter_id": "8794077",
        "source_url": "https://toki31.com/novel/63670/8794077",
        "work_title": "Shared Book",
        "author": "A Writer",
        "chapter_label": "1화",
        "chapter_kind": "main",
        "access": "free",
        "relative_path": "files/000001.md",
    }
    _batch(inbox, _BATCHES[0], item=novel)
    receipt = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert receipt is not None
    canonical = receipt["items"][0]["canonical_work_id"]
    assert canonical.startswith("novel:") and canonical != "novel:toki:63670"
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT slug FROM text_novel_sources WHERE site='toki' AND source_work_id='63670'"
        ).fetchone() == ("63670",)
        assert db.execute(
            "SELECT left_site,left_work_id,right_site,right_work_id,status "
            "FROM text_novel_link_candidates"
        ).fetchall() == [("blacktoon", "24753", "toki", "63670", "candidate")]
        assert (
            db.execute(
                "SELECT canonical_work_id FROM text_novel_work_group_sources "
                "WHERE site='toki' AND source_work_id='63670'"
            ).fetchone()[0]
            == canonical
        )


def test_legacy_toki_sources_backfill_numeric_slug_without_merging(tmp_path: Path) -> None:
    db_path = tmp_path / "state" / "text.sqlite"
    db = importer._connect(db_path)
    with db:
        db.execute("PRAGMA user_version=0")  # Simulate a database predating the schema checkpoint.
        db.execute(
            """INSERT INTO text_novel_sources(
                   site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
               VALUES('blacktoon','24753','https://blacktoon452.com/novel/24753',
                      '63670','Shared Book','A Writer','shared book','a writer','now')"""
        )
        db.execute(
            """INSERT INTO text_novel_sources(
                   site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
               VALUES('toki','63670','https://toki31.com/novel/63670','','Shared Book',
                      'A Writer','shared book','a writer','now')"""
        )
    db.close()
    db = importer._connect(db_path)
    try:
        assert (
            db.execute(
                "SELECT slug FROM text_novel_sources WHERE site='toki' AND source_work_id='63670'"
            ).fetchone()[0]
            == "63670"
        )
        assert db.execute("SELECT COUNT(*) FROM text_novel_link_candidates").fetchone()[0] == 1
        assert (
            db.execute(
                "SELECT COUNT(DISTINCT site || ':' || source_work_id) FROM text_novel_sources"
            ).fetchone()[0]
            == 2
        )
    finally:
        db.close()


def test_not_ready_and_unsafe_path_never_become_published_input(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    db_path = tmp_path / "state" / "text.sqlite"
    objects = tmp_path / "state" / "objects"
    receipts = inbox / "receipts"
    _batch(inbox, _BATCHES[0], ready=False)
    assert importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts) is None
    assert not (receipts / f"{_BATCHES[0]}.json").exists()

    fixture = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    item = dict(fixture["item"])
    item["relative_path"] = fixture["expected"]["rejected_paths"][0]
    _batch(inbox, _BATCHES[1], item=item)
    rejected = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert rejected is not None
    assert rejected["items"][0]["status"] == "rejected"
    assert rejected["items"][0]["reason"] == "relative_path_invalid"
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM text_archive_objects").fetchone()[0] == 0


def test_importer_operation_window_checks_locks_resources_and_timer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    publish_lock = tmp_path / "static" / ".publish.lock"
    publish_lock.parent.mkdir()
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 300000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3000000 kB\n")
    status = _process_status(tmp_path)
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(total=200 * 1024**3, free=41 * 1024**3),
    )

    with runtime.operation_window(
        publish_lock=publish_lock,
        lane_path=tmp_path / "no-lane.json",
        meminfo_path=meminfo,
        status_path=status,
        root_path=tmp_path,
    ):
        # Probe only: TypeMoon can take its publish lock at once while text works.
        with runtime.FileLock(str(publish_lock), timeout=0):
            pass

    # TypeMoon announces a heavy step but its cgroup is unreadable: its whole peak is reserved.
    lane = _typemoon_lane(tmp_path)
    with pytest.raises(runtime.RuntimeWindowError, match="typemoon_memory_reserved"):
        with runtime.operation_window(
            publish_lock=publish_lock,
            lane_path=lane,
            meminfo_path=meminfo,
            status_path=status,
            cgroup_root=tmp_path / "no-cgroup",
            root_path=tmp_path,
        ):
            pytest.fail("a starting TypeMoon run keeps its memory")


@pytest.mark.parametrize(
    ("meminfo_text", "disk_free", "reason"),
    [
        (
            "MemAvailable: 150000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3900000 kB\n",
            41 * 1024**3,
            "memory_below_floor",
        ),
        (
            "MemAvailable: 400000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3900000 kB\n",
            4 * 1024**3 - 1,
            "disk_below_floor",
        ),
    ],
)
def test_operation_window_defers_below_resource_floors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    meminfo_text: str,
    disk_free: int,
    reason: str,
) -> None:
    publish_lock = tmp_path / "static" / ".publish.lock"
    publish_lock.parent.mkdir()
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(meminfo_text)
    status = _process_status(tmp_path)
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(total=200 * 1024**3, free=disk_free),
    )

    with pytest.raises(runtime.RuntimeWindowError, match=reason):
        with runtime.operation_window(
            publish_lock=publish_lock,
            meminfo_path=meminfo,
            status_path=status,
            root_path=tmp_path,
            lane_path=tmp_path / "no-lane.json",
        ):
            pytest.fail("resource limits must defer the text operation")


def _typemoon_lane(root: Path) -> Path:
    lane = root / ".typemoon-lane.json"
    lane.write_text(json.dumps({"phase": "crawling", "updated_at": time.time()}), encoding="utf-8")
    return lane


def _typemoon_cgroup(root: Path, unit: str, current: int) -> Path:
    unit_root = root / "system.slice" / unit
    unit_root.mkdir(parents=True)
    (unit_root / "cgroup.procs").write_text("1234\n", encoding="ascii")
    (unit_root / "memory.current").write_text(f"{current}\n", encoding="ascii")
    return root


def test_operation_window_leaves_typemoon_its_measured_headroom(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    publish_lock = tmp_path / "static" / ".publish.lock"
    publish_lock.parent.mkdir()
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 400000 kB\n")
    status = _process_status(tmp_path)
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _: SimpleNamespace(total=200 * 1024**3, free=100 * 1024**3),
    )

    lane = _typemoon_lane(tmp_path)

    def window(cgroups: Path, need: int = 150 * 1024**2, lane_path: Path = lane) -> Any:
        return runtime.operation_window(
            publish_lock=publish_lock,
            lane_path=lane_path,
            need_bytes=need,
            meminfo_path=meminfo,
            status_path=status,
            cgroup_root=cgroups,
            root_path=tmp_path,
        )

    # A crawl just starting (100 MiB of its 620 MiB peak) keeps 520 MiB: no room for text.
    early = _typemoon_cgroup(tmp_path / "early", "redstm-control.service", 100 * 1024**2)
    assert runtime.typemoon_reserve(early, lane) == 520 * 1024**2
    # The every-minute control poll and outage sleeps write no lane file: nothing is reserved,
    # and a lane file the runner left behind when it died goes stale.
    assert runtime.typemoon_reserve(early, tmp_path / "no-lane.json") == 0
    assert runtime.typemoon_reserve(early, lane, now=time.time() + 600) == 0
    # A step that names a smaller peak (a body fill) keeps only that much back.
    fill = tmp_path / "fill-lane.json"
    fill.write_text(
        json.dumps({"phase": "recovery", "updated_at": time.time(), "peak_mib": 360}),
        encoding="utf-8",
    )
    assert runtime.typemoon_reserve(early, fill) == 260 * 1024**2
    with pytest.raises(runtime.RuntimeWindowError, match="typemoon_memory_reserved"):
        with window(early):
            pytest.fail("text must wait while TypeMoon can still grow into the free memory")
    # Near its peak TypeMoon needs little more; the rest is text's.
    late = _typemoon_cgroup(tmp_path / "late", "redstm-schedule.service", 580 * 1024**2)
    with window(late):
        pass
    # Idle TypeMoon reserves nothing; a small collector step needs less than a publish.
    meminfo.write_text("MemAvailable: 150000 kB\n")
    idle = tmp_path / "no-lane.json"
    with window(tmp_path / "idle", need=60 * 1024**2, lane_path=idle):
        pass
    with pytest.raises(runtime.RuntimeWindowError, match="memory_below_floor"):
        with window(tmp_path / "idle", lane_path=idle):
            pytest.fail("a publish-sized step must wait for memory")


def test_heavy_text_operations_run_one_at_a_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    publish_lock = tmp_path / "static" / ".publish.lock"
    publish_lock.parent.mkdir()
    operation_lock = tmp_path / ".operation.lock"
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 800000 kB\n")
    status = _process_status(tmp_path)
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _: SimpleNamespace(total=200 * 1024**3, free=100 * 1024**3),
    )

    options: dict[str, Any] = {
        "publish_lock": publish_lock,
        "operation_lock": operation_lock,
        "meminfo_path": meminfo,
        "status_path": status,
        "cgroup_root": tmp_path / "cgroup",
        "root_path": tmp_path,
        "lane_path": tmp_path / "no-lane.json",
    }
    with runtime.FileLock(str(operation_lock)):
        with pytest.raises(runtime.RuntimeWindowError, match="text_operation_busy"):
            with runtime.operation_window(exclusive=True, **options):
                pytest.fail("a second heavy text step must wait")
        # The light collector does not take the heavy-step lock.
        with runtime.operation_window(**options):
            pass


def test_operation_window_defers_only_for_typemoon_publish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    control_lock = tmp_path / "state" / "control.lock"
    publish_lock = tmp_path / "static" / ".publish.lock"
    control_lock.parent.mkdir()
    publish_lock.parent.mkdir()
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 400000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3900000 kB\n")
    status = _process_status(tmp_path)
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _: SimpleNamespace(total=200 * 1024**3, free=100 * 1024**3),
    )

    with runtime.FileLock(str(control_lock)):
        with runtime.operation_window(
            publish_lock=publish_lock,
            meminfo_path=meminfo,
            status_path=status,
            root_path=tmp_path,
            lane_path=tmp_path / "no-lane.json",
        ):
            pass
    with runtime.FileLock(str(publish_lock)):
        with pytest.raises(runtime.RuntimeWindowError, match="typemoon_publish_busy"):
            with runtime.operation_window(
                publish_lock=publish_lock,
                meminfo_path=meminfo,
                status_path=status,
                root_path=tmp_path,
                lane_path=tmp_path / "no-lane.json",
            ):
                pytest.fail("a held TypeMoon publish lock must defer the text operation")


def test_main_drains_every_ready_batch_in_one_run(
    cli_roots: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    inbox, _attempts = cli_roots
    _batch(inbox, _BATCHES[0])
    _batch(inbox, _BATCHES[1], body=b"second body")
    _batch(inbox, _BATCHES[2], ready=False)
    importer.main()
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["batch_id"] for line in lines] == list(_BATCHES[:2])
    assert (inbox / "receipts" / f"{_BATCHES[1]}.json").is_file()
    assert not (inbox / "receipts" / f"{_BATCHES[2]}.json").exists()


def test_temporary_batch_failure_retains_original_and_allows_later_batch(
    cli_roots: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    inbox, attempts = cli_roots
    _batch(inbox, _BATCHES[0])
    _batch(inbox, _BATCHES[1], body=b"second body")
    real_import = importer.import_batch

    def broken(inbox_root: Path, batch_id: str, *args: Any) -> Any:
        if batch_id == _BATCHES[0]:
            raise sqlite3.OperationalError("database is locked")
        return real_import(inbox_root, batch_id, *args)

    monkeypatch.setattr(importer, "import_batch", broken)
    with pytest.raises(SystemExit) as stopped:
        importer.main()
    assert stopped.value.code == 1
    assert (inbox / "receipts" / f"{_BATCHES[1]}.json").is_file()
    assert importer._next_ready_batch(inbox, attempts) is None
    for _attempt in range(8):
        record = attempts / f"{_BATCHES[0]}.json"
        if record.exists():
            data = json.loads(record.read_text(encoding="utf-8"))
            data["next_at"] = 0
            record.write_text(json.dumps(data), encoding="utf-8")
        try:
            importer.main()
        except SystemExit:
            pass
    capsys.readouterr()
    assert not (inbox / "receipts" / f"{_BATCHES[0]}.status.json").exists()
    assert not (inbox / "drop" / _BATCHES[0] / "rejected.json").exists()
    monkeypatch.setattr(importer, "import_batch", real_import)
    data = json.loads(record.read_text(encoding="utf-8"))
    data["next_at"] = 0
    record.write_text(json.dumps(data), encoding="utf-8")
    importer.main()
    assert (inbox / "receipts" / f"{_BATCHES[0]}.json").is_file()


def _imported_for_status(tmp_path: Path) -> tuple[Path, Path]:
    inbox = tmp_path / "inbox"
    _batch(inbox, _BATCHES[0])
    db_path = tmp_path / "text.sqlite"
    importer.import_batch(inbox, _BATCHES[0], db_path, tmp_path / "objects", inbox / "receipts")
    _batch(inbox, _BATCHES[1], body=b"waiting body")
    return inbox, db_path


def test_status_reports_deliveries_drop_backlog_and_collector_state(tmp_path: Path) -> None:
    inbox, db_path = _imported_for_status(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute(
            """INSERT INTO text_collector_groups(group_id,last_request_at,cooldown_until,
               last_status,last_error,last_source) VALUES('g',1,2000000000,429,?,'blacktoon')""",
            ("x" * 400,),
        )
        db.execute(
            """CREATE TABLE text_collector_hosts(
               source TEXT PRIMARY KEY, host TEXT NOT NULL, failures INTEGER NOT NULL,
               blocked INTEGER NOT NULL)"""
        )
        db.executemany(
            "INSERT INTO text_collector_hosts(source,host,failures,blocked) VALUES(?,?,?,?)",
            (
                ("blacktoon", "blacktoon454.com", 2, 1_800_000_000 + 3600),
                ("marumaru", "marumaru103.com", 4, 1),
            ),
        )
    attempts = tmp_path / "attempts"
    attempts.mkdir()
    (attempts / f"{_BATCHES[1]}.json").write_text(
        json.dumps({"attempts": 2, "next_at": 1_800_000_900, "reason": "import_failed:OSError"})
    )
    (attempts / f"{_BATCHES[2]}.json").write_text(
        json.dumps({"attempts": 1, "next_at": 1, "reason": "import_failed:OSError"})
    )
    document = status.build_status(
        db_path, inbox, now=1_800_000_000, attempts_roots=(attempts, tmp_path / "absent")
    )
    assert document["imports"] == {"backing_off": 1, "reasons": {"import_failed:OSError": 1}}
    assert document["pc"]["oldest_unpublished_at"]  # imported, revision 1
    assert document["generated_at"] == "2027-01-15T08:00:00Z"
    assert document["lanes"]["arcalive"]["items"] == 1
    assert document["lanes"]["arcalive"]["published"] == 0
    assert document["pc"]["batches"] == 1
    assert document["drop"]["text_waiting"] == 1
    group = document["collector"]["groups"][0]
    assert group["cooldown_until"] == "2033-05-18T03:33:20Z"
    assert group["last_status"] == 429 and len(group["last_error"]) == 160
    assert document["collector"]["hosts"]["blacktoon"]["blocked"] is True
    assert document["collector"]["hosts"]["marumaru"]["blocked"] is False
    body = json.dumps(document, ensure_ascii=False)
    assert "fixture body" not in body and str(tmp_path) not in body


def test_status_upload_is_read_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    inbox, db_path = _imported_for_status(tmp_path)
    stored: dict[str, bytes] = {}

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] == "copyto":
            stored[argv[5]] = Path(argv[4]).read_bytes()
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        return subprocess.CompletedProcess(argv, 0, stored[argv[4]], b"")

    monkeypatch.setattr(status, "operation_window", lambda **_: nullcontext())
    result: dict[str, Any] = status.publish_status(
        db_path, inbox, tmp_path / "build", runner=rclone
    )
    key = "r2text:redstm-text-archive/published/status/text.json"
    assert result["status"] == "published"
    assert json.loads(stored[key])["schema"] == 1
    assert hashlib.sha256(stored[key]).hexdigest()


def test_a_deferred_step_leaves_its_reason_for_the_status_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    publish_lock = tmp_path / "static" / ".publish.lock"
    publish_lock.parent.mkdir()
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 100000 kB\n")
    deferrals = tmp_path / "deferrals.json"
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _: SimpleNamespace(total=200 * 1024**3, free=100 * 1024**3),
    )
    with pytest.raises(runtime.RuntimeWindowError, match="memory_below_floor"):
        with runtime.operation_window(
            publish_lock=publish_lock,
            lane_path=tmp_path / "no-lane.json",
            meminfo_path=meminfo,
            status_path=_process_status(tmp_path),
            root_path=tmp_path,
            deferrals_path=deferrals,
        ):
            pytest.fail("not enough memory")

    recorded = status._deferrals(deferrals)
    assert [entry["reason"] for entry in recorded.values()] == ["memory_below_floor"]


# Arcalive body equivalence (Newtomi feedback 2026-10-04): a re-downloaded post whose only
# differences are known image URL signatures and header metadata is the same text; a changed
# link query or a changed sentence is not.
_ARCA_ITEM = json.loads(_FIXTURE.read_text(encoding="utf-8"))["item"]
_ARCA_KEY = "20230607sac/" + "a" * 64 + ".webp"


def _post(
    *,
    title: str = "제목",
    category: str = "소설",
    image: str = f"https://ac-o.arca.live/{_ARCA_KEY}?expires=1&key=OLD&type=orig",
    link: str = "https://example.com/page?ref=1",
    sentence: str = "본문 한 줄",
) -> bytes:
    return (
        f"# {title}\n\n- channel: novel\n- category: {category}\n- author: 작가\n"
        f"- created: 2026-09-23\n- id: 108\n- url: https://arca.live/b/novel/108\n\n---\n\n"
        f"{sentence}\n\n[image] {image}\n\n[링크]({link})\n"
    ).encode()


def test_new_image_signature_and_header_metadata_are_the_same_body() -> None:
    old = _post()
    renewed = _post(
        title="제목 (수정)",
        category="잡담",
        image=f"https://ac.arca.live/{_ARCA_KEY}?expires=999&key=NEW",
    )
    assert old != renewed
    assert importer.canonical_arcalive_bytes(old) == importer.canonical_arcalive_bytes(renewed)
    assert b"arca-media:" + _ARCA_KEY.encode() in (importer.canonical_arcalive_bytes(old) or b"")


def test_shared_arcalive_body_contract() -> None:
    contract = json.loads(
        (_ROOT / "fixtures/arcalive_text_contract.json").read_text(encoding="utf-8")
    )
    for case in contract["cases"]:
        expected = case["canonical"].encode() if case["canonical"] is not None else None
        assert importer.canonical_arcalive_bytes(case["raw"].encode()) == expected


@pytest.mark.parametrize(
    "change",
    [
        {"link": "https://example.com/page?ref=2"},
        {"sentence": "본문 두 줄"},
        {"image": "https://ac-o.arca.live/20230607sac/" + "b" * 64 + ".webp?expires=1"},
        {"image": f"https://example.com/{_ARCA_KEY}?expires=2"},
    ],
)
def test_links_other_images_and_text_still_differ(change: dict[str, str]) -> None:
    assert importer.canonical_arcalive_bytes(_post()) != importer.canonical_arcalive_bytes(
        _post(**change)
    )


def test_not_an_arcalive_post_has_no_rule() -> None:
    assert importer.canonical_arcalive_bytes(b"plain text\n") is None
    assert importer.canonical_arcalive_bytes(b"# t\nnot a header line\n---\nbody\n") is None


def test_reimport_with_new_signatures_is_a_proven_duplicate_and_a_real_edit_is_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REDSTM_TEXT_ARCALIVE_EQUIVALENCE", "1")
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    first = _post()
    _batch(inbox, _BATCHES[0], body=first, item=dict(_ARCA_ITEM))
    receipt = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert receipt is not None and receipt["items"][0]["status"] == "accepted"

    renewed = _post(image=f"https://ac.arca.live/{_ARCA_KEY}?expires=999&key=NEW")
    text_sha = hashlib.sha256(importer.canonical_arcalive_bytes(renewed) or b"").hexdigest()
    _batch(inbox, _BATCHES[1], body=renewed, item={**_ARCA_ITEM, "text_sha256": text_sha})
    receipt = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert receipt is not None
    item = receipt["items"][0]
    assert item["status"] == "duplicate"
    assert item["submitted_raw_sha256"] == hashlib.sha256(renewed).hexdigest()
    assert (
        item["stored_object_sha256"] == item["content_sha256"] == hashlib.sha256(first).hexdigest()
    )
    assert item["text_sha256"] == text_sha
    assert item["equivalence_version"] == 1
    # Only the fields Newtomi's receipt parser accepts (storage.py's fixed list).
    assert set(item) <= {
        "identity",
        "status",
        "reason",
        "content_sha256",
        "submitted_raw_sha256",
        "stored_object_sha256",
        "text_sha256",
        "equivalence_version",
        "canonical_work_id",
        "canonical_chapter_id",
        "published_at",
    }
    # The stored file keeps the first download's bytes.
    assert (objects / importer._object_key(item["content_sha256"])).read_bytes() == first

    edited = _post(sentence="본문 두 줄")
    _batch(inbox, _BATCHES[2], body=edited, item=dict(_ARCA_ITEM))
    receipt = importer.import_batch(inbox, _BATCHES[2], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "held_conflict"


def test_an_arcalive_text_hash_is_checked_by_the_arcalive_rule(tmp_path: Path) -> None:
    body = _post()
    wrong = hashlib.sha256(b"something else").hexdigest()
    _batch(tmp_path / "inbox", _BATCHES[0], body=body, item={**_ARCA_ITEM, "text_sha256": wrong})
    receipt = importer.import_batch(
        tmp_path / "inbox", _BATCHES[0], tmp_path / "db", tmp_path / "objects", tmp_path / "r"
    )
    assert receipt is not None
    assert receipt["items"][0]["status"] == "rejected"
    assert receipt["items"][0]["reason"] == "text_sha256_mismatch"


def test_pc_state_reports_waiting_batches_and_why_publish_waited(tmp_path: Path) -> None:
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    for index, batch_id in enumerate(_BATCHES[:2]):
        _batch(inbox, batch_id, body=f"body {index}".encode(), item=dict(_ARCA_ITEM))
        importer.import_batch(inbox, batch_id, db_path, objects, receipts)
    deferrals = tmp_path / "deferrals.json"
    deferrals.write_text(
        json.dumps(
            {"publisher": {"reason": "typemoon_memory_reserved", "at": "2026-10-04T06:30Z"}}
        ),
        encoding="utf-8",
    )
    path = status.write_pc_state(
        db_path, receipts, outcome="published", now=1_000.0, deferrals_path=deferrals
    )
    path = status.write_pc_state(
        db_path,
        receipts,
        outcome="deferred",
        reason="typemoon_memory_reserved",
        now=2_000.0,
        deferrals_path=deferrals,
    )
    state = json.loads(path.read_text(encoding="utf-8"))
    assert path.name == "publish-status.json"
    assert state["last_run"] == {
        "at": "1970-01-01T00:33:20Z",
        "outcome": "deferred",
        "reason": "typemoon_memory_reserved",
    }
    # A deferred run keeps the last success it did not have itself.
    assert state["last_success_at"] == "1970-01-01T00:16:40Z"
    assert state["pending"]["batches"] == 2
    assert state["pending"]["items"] == 2
    assert state["pending"]["oldest_batch_id"] == _BATCHES[0]
    assert state["deferrals"]["publisher"]["reason"] == "typemoon_memory_reserved"
    assert state["novel_snapshot"] is None


def test_a_batch_with_nothing_to_publish_gets_its_final_receipt(tmp_path: Path) -> None:
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    _batch(inbox, _BATCHES[0], body=b"first", item=dict(_ARCA_ITEM))
    importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    _batch(inbox, _BATCHES[1], body=b"changed", item=dict(_ARCA_ITEM))
    held = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert held is not None and held["items"][0]["status"] == "held_conflict"
    publisher._finalize_receipts(db_path, receipts)
    with sqlite3.connect(db_path) as db:
        revisions = dict(db.execute("SELECT batch_id,revision FROM text_archive_batches"))
    # The held batch is final now; the accepted one still waits for its publication.
    assert revisions == {_BATCHES[0]: 1, _BATCHES[1]: 2}
    receipt = json.loads((receipts / f"{_BATCHES[1]}.json").read_text(encoding="utf-8"))
    assert receipt["revision"] == 2
    assert receipt["items"][0]["status"] == "held_conflict"
    assert "published_at" not in receipt["items"][0]


def test_arcalive_equivalence_stays_off_until_newtomi_knows_the_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("REDSTM_TEXT_ARCALIVE_EQUIVALENCE", raising=False)
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    _batch(inbox, _BATCHES[0], body=_post(), item=dict(_ARCA_ITEM))
    importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    renewed = _post(image=f"https://ac.arca.live/{_ARCA_KEY}?expires=999&key=NEW")
    _batch(inbox, _BATCHES[1], body=renewed, item=dict(_ARCA_ITEM))
    receipt = importer.import_batch(inbox, _BATCHES[1], db_path, objects, receipts)
    assert receipt is not None
    assert receipt["items"][0]["status"] == "held_conflict"


def test_unexpected_or_fatal_import_failure_still_backs_off(
    cli_roots: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A RuntimeError, or an OOM kill that never reaches an except clause, used to leave no
    attempt record, so every timer tick retried the same head batch with no backoff."""
    inbox, attempts = cli_roots
    _batch(inbox, _BATCHES[0])

    def crash(*_args: Any) -> Any:
        raise RuntimeError("schema guard")

    monkeypatch.setattr(importer, "import_batch", crash)
    with pytest.raises(SystemExit):
        importer.main()
    record = json.loads((attempts / f"{_BATCHES[0]}.json").read_text(encoding="utf-8"))
    assert record["attempts"] == 1 and record["reason"] == "import_failed:RuntimeError"
    assert importer._next_ready_batch(inbox, attempts) is None

    def killed(*_args: Any) -> Any:
        raise KeyboardInterrupt  # stands in for SIGKILL: no handler runs

    record["next_at"] = 0
    (attempts / f"{_BATCHES[0]}.json").write_text(json.dumps(record), encoding="utf-8")
    monkeypatch.setattr(importer, "import_batch", killed)
    with pytest.raises(KeyboardInterrupt):
        importer.main()
    record = json.loads((attempts / f"{_BATCHES[0]}.json").read_text(encoding="utf-8"))
    assert record["attempts"] == 2 and record["reason"] == "import_started"
    assert importer._next_ready_batch(inbox, attempts) is None
    capsys.readouterr()


def test_unwritable_attempts_root_still_reports_the_import_failure(
    cli_roots: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    inbox, attempts = cli_roots
    _batch(inbox, _BATCHES[0])
    attempts.write_text("not a directory", encoding="utf-8")

    def crash(*_args: Any) -> Any:
        raise RuntimeError("schema guard")

    monkeypatch.setattr(importer, "import_batch", crash)
    outcome = importer._import_one(inbox, _BATCHES[0])
    assert outcome is not None and outcome["status"] == "failed"
    assert outcome["reason"].startswith("import_failed:")
    assert "attempt_record_failed:" in outcome["reason"]
    assert not (inbox / "receipts" / f"{_BATCHES[0]}.json").exists()
    capsys.readouterr()


def test_slow_publisher_transfer_allows_new_batch_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 1000000 kB\n")
    options: dict[str, Any] = {
        "publish_lock": tmp_path / "publish.lock",
        "operation_lock": tmp_path / "operation.lock",
        "lane_path": tmp_path / "no-lane.json",
        "meminfo_path": meminfo,
        "status_path": _process_status(tmp_path),
        "root_path": tmp_path,
    }
    monkeypatch.setattr(
        runtime.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(total=200 * 1024**3, free=41 * 1024**3),
    )
    monkeypatch.setattr(
        publisher,
        "operation_window",
        lambda **kwargs: runtime.operation_window(**kwargs, **options),
    )
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    _batch(inbox, _BATCHES[0])
    calls: list[str] = []

    def transfer(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        # Execute an actual import while the remote upload/readback window is open.
        with runtime.operation_window(exclusive=True, lock_wait_seconds=0, **options):
            receipt = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
        assert receipt is not None and receipt["revision"] == 1
        calls.append(argv[3])
        return subprocess.CompletedProcess(
            argv, 0, b"fixture body" if argv[3] == "cat" else b"", b""
        )

    digest = hashlib.sha256(b"fixture body").hexdigest()
    source = objects / f"objects/sha256/{digest[:2]}/{digest}.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fixture body")
    publisher._publish_object_batch(
        tmp_path / "build",
        objects,
        "r2text:redstm-text-archive",
        [(f"published/objects/sha256/{digest[:2]}/{digest}.md", digest)],
        transfer,
    )
    assert calls == ["copyto", "cat"]
    assert json.loads((receipts / f"{_BATCHES[0]}.json").read_text())["revision"] == 1


def test_manual_document_above_old_limit_imports_and_reuses_streamed_object(
    tmp_path: Path,
) -> None:
    inbox, db_path, objects, receipts = (
        tmp_path / "inbox",
        tmp_path / "archive.db",
        tmp_path / "objects",
        tmp_path / "receipts",
    )
    item: dict[str, object] = {
        "kind": "manual_document",
        "identity": "manual:" + "b" * 64,
        "title": "large complete novel",
        "created_at": "2026-10-01T00:00:00Z",
        "folder": "fixture",
        "source_url": "",
    }
    body = b"large complete novel prose\n" * 1_500_000
    assert 32 * 1024**2 < len(body) < 64 * 1024**2
    _batch(inbox, _BATCHES[0], body=body, item=item)
    first = importer.import_batch(inbox, _BATCHES[0], db_path, objects, receipts)
    assert first is not None and first["items"][0]["status"] == "accepted"
    digest = hashlib.sha256(body).hexdigest()
    # Reusing a content object must not allocate a second complete body.
    tracemalloc.start()
    try:
        key = importer._store_object(objects, body, digest)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 2 * 1024**2
    with (objects / key).open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == digest


def test_existing_initialized_archive_adds_publish_attempt_queue(tmp_path: Path) -> None:
    path = tmp_path / "existing.sqlite"
    db = importer._connect(path)
    db.execute("DROP TABLE text_archive_publish_attempts")
    db.commit()
    db.close()
    db = importer._connect(path)
    try:
        assert db.execute("SELECT count(*) FROM text_archive_publish_attempts").fetchone()[0] == 0
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
    finally:
        db.close()
