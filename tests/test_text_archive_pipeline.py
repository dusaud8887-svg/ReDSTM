from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from scripts.text_archive import collector, compare_sources, importer, publisher, repair_authors

_BATCH_ID = "20260923T130000Z-pc-00000001"


def test_publication_record_closes_sqlite_connection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    connection = MagicMock()
    monkeypatch.setattr(publisher.sqlite3, "connect", lambda _, **__: connection)
    publisher._record_publication(tmp_path / "text.sqlite", "key", "digest")
    connection.close.assert_called_once_with()


def test_novel_publisher_collapses_same_body_with_different_source_headers() -> None:
    prose = b"Same chapter body.\n"
    rows = []
    for site in ("toki", "blacktoon"):
        raw = f"# Chapter 1\n# https://{site}.example/novel/1/1\n\n".encode() + prose
        rows.append(
            {
                "chapter_label": "1화",
                "chapter_kind": "main",
                "source_site": site,
                "source_chapter_id": "1",
                "source_url": f"https://{site}.example/novel/1/1",
                "content_sha256": hashlib.sha256(raw).hexdigest(),
                "text_sha256": importer.novel_text_sha256(raw),
                "imported_at": "now",
                "identity": f"novel_chapter:{site}:1:1",
            }
        )
    assert rows[0]["content_sha256"] != rows[1]["content_sha256"]
    assert len(publisher._unique_novel_chapters(rows)) == 1


def test_body_queue_window_refills_beyond_canary(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    try:
        with db:
            db.executemany(
                "INSERT INTO text_novel_sources(site,source_work_id,last_seen_at) "
                "VALUES('marumaru',?,?)",
                [(str(work), "now") for work in range(101)],
            )
            db.executemany(
                """INSERT INTO text_novel_chapters(
                   site,source_work_id,source_chapter_id,access,status,last_seen_at)
                   VALUES('marumaru',?,?,'free','discovered','now')""",
                [
                    (str(work), str(work * 100 + episode))
                    for work in range(101)
                    for episode in range(11)
                ],
            )
            collector._fill_body_queue(db, "marumaru")
            collector._fill_body_queue(db, "marumaru")
        rows = db.execute(
            "SELECT parent_work_id FROM text_collector_queue WHERE kind='episode'"
        ).fetchall()
        assert len(rows) == 1000
        assert {row[0] for row in rows} <= {str(work) for work in range(101)}
        with db:
            db.execute(
                "UPDATE text_collector_queue SET status='done' WHERE entity_id IN "
                "(SELECT entity_id FROM text_collector_queue LIMIT 100)"
            )
            db.execute(
                """UPDATE text_novel_chapters SET status='complete'
                   WHERE source_chapter_id IN (
                     SELECT entity_id FROM text_collector_queue WHERE status='done')"""
            )
            collector._fill_body_queue(db, "marumaru")
        assert db.execute("SELECT COUNT(*) FROM text_collector_queue").fetchone()[0] == 1100
    finally:
        db.close()


class FakeResponse:
    def __init__(self, value: object, status: int = 200, headers: dict[str, str] | None = None):
        self.status_code = status
        self.headers = headers or {}
        self.body = value if isinstance(value, bytes) else json.dumps(value).encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def iter_content(self, _chunk_size: int) -> Iterator[bytes]:
        yield self.body


class FakeSession:
    def __init__(self, *responses: FakeResponse):
        self.responses = list(responses)
        self.calls: list[str] = []
        self.trust_env = True

    def get(self, url: str, **kwargs: object) -> FakeResponse:
        assert kwargs["allow_redirects"] is False
        self.calls.append(url)
        return self.responses.pop(0)

    def close(self) -> None:
        return None


def _incoming_batch(inbox: Path) -> None:
    batch = inbox / "drop" / _BATCH_ID
    files = batch / "files"
    files.mkdir(parents=True)
    body = (
        "# fixture article title\n\n- channel: novel\n- category: 소설\n"
        "- author: 작가\n- created: 2026-09-23\n- id: 108\n"
        "- url: https://arca.live/b/novel/108\n\n---\n\nfixture article\n"
    ).encode()
    item = {
        "identity": "arcalive:novel:108:text",
        "kind": "arcalive_post",
        "board": "novel",
        "post_id": "108",
        "title": "소설",
        "category": "소설",
        "content_lane": "text",
        "source_url": "https://arca.live/b/novel/108",
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "relative_path": "files/000001.md",
    }
    (files / "000001.md").write_bytes(body)
    manifest = {
        "schema": 1,
        "batch_id": _BATCH_ID,
        "producer": "newtomi-pc",
        "items": [item],
    }
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    (batch / "manifest.json").write_bytes(raw)
    (batch / "ready.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "batch_id": _BATCH_ID,
                "manifest_sha256": hashlib.sha256(raw).hexdigest(),
            }
        ),
        encoding="utf-8",
    )


def _incoming_novel_batch(inbox: Path, batch_id: str) -> None:
    batch = inbox / "drop" / batch_id
    files = batch / "files"
    files.mkdir(parents=True)
    body = b"fixture novel chapter\n"
    item = {
        "identity": "novel_chapter:toki:63670:8794077",
        "kind": "novel_chapter",
        "site": "toki",
        "source_work_id": "63670",
        "source_chapter_id": "8794077",
        "source_url": "https://toki31.com/novel/63670/8794077",
        "work_title": "작품",
        "author": "작가",
        "chapter_label": "1화",
        "chapter_kind": "main",
        "access": "free",
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "relative_path": "files/000001.md",
    }
    (files / "000001.md").write_bytes(body)
    manifest = {
        "schema": 1,
        "batch_id": batch_id,
        "producer": "newtomi-pc",
        "items": [item],
    }
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    (batch / "manifest.json").write_bytes(raw)
    (batch / "ready.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "batch_id": batch_id,
                "manifest_sha256": hashlib.sha256(raw).hexdigest(),
            }
        ),
        encoding="utf-8",
    )


def test_publisher_pointer_is_last_and_receipt_advances_after_readback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    result = importer.import_batch(
        inbox,
        _BATCH_ID,
        db_path,
        tmp_path / "objects",
        receipts,
    )
    assert result is not None and result["revision"] == 1
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT author FROM text_archive_items").fetchone() == ("작가",)
        db.execute(
            "UPDATE text_archive_items SET title='소설',source_category='',author='' "
            "WHERE lane='arcalive'"
        )

    remote: dict[str, bytes] = {}
    calls: list[tuple[str, str]] = []

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] in {"copy", "hashsum"}:
            return _fake_r2(remote)(argv)
        if argv[3] == "copyto":
            local, remote_path = argv[4], argv[5]
            key = remote_path.split("redstm-text-archive/", 1)[1]
            remote[key] = Path(local).read_bytes()
            calls.append(("copy", key))
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        key = argv[4].split("redstm-text-archive/", 1)[1]
        calls.append(("cat", key))
        return subprocess.CompletedProcess(argv, 0, remote[key], b"")

    outcome = publisher.publish_lane(
        db_path,
        tmp_path / "objects",
        tmp_path / "build",
        receipts,
        "arcalive",
        runner=rclone,
    )
    pointer_events = [
        index for index, call in enumerate(calls) if call[1] == "published/arcalive/release.json"
    ]
    assert len(pointer_events) == 2
    assert pointer_events[0] == len(calls) - 2
    receipt = json.loads((receipts / f"{_BATCH_ID}.json").read_text(encoding="utf-8"))
    assert outcome["item_count"] == 1
    with sqlite3.connect(db_path) as db:
        metadata = db.execute(
            "SELECT title,source_category,author FROM text_archive_items"
        ).fetchone()
        assert metadata == (
            "fixture article title",
            "소설",
            "작가",
        )
    catalog_file = next((tmp_path / "build" / "published" / "indexes" / "arcalive").glob("*.json"))
    published_item = json.loads(catalog_file.read_text(encoding="utf-8"))["items"][0]
    assert published_item["title"] == "fixture article title"
    assert published_item["category"] == "소설"
    assert published_item["author"] == "작가"
    assert receipt["revision"] == 2
    assert receipt["items"][0]["published_at"]
    assert remote["published/arcalive/release.json"]
    calls.clear()
    assert (
        publisher.publish_lane(
            db_path, tmp_path / "objects", tmp_path / "build", receipts, "arcalive", runner=rclone
        )["status"]
        == "noop"
    )
    assert calls == [("cat", "published/arcalive/release.json")]


def test_arcalive_publisher_emits_work_view_without_changing_file_catalog(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_archive_items SET title='긴 연재 제목 1화'")
        db.execute(
            """INSERT INTO text_archive_items
               (identity,lane,source_site,source_board,source_post_id,source_category,
                content_lane,source_url,title,author,content_sha256,bytes,object_key,
                batch_id,imported_at)
               SELECT 'arcalive:novel:109:text',lane,source_site,source_board,'109',
                      source_category,content_lane,source_url,'긴 연재 제목 2화',author,
                      content_sha256,bytes,object_key,batch_id,imported_at
               FROM text_archive_items WHERE source_post_id='108'"""
        )
    tree = publisher.build_publish_tree(
        db_path, tmp_path / "objects", tmp_path / "build", "arcalive"
    )
    release = json.loads((tmp_path / "build" / tree["release_key"]).read_text(encoding="utf-8"))
    assert release["item_count"] == 2
    assert release["work_count"] == 1
    assert len(release["catalog_pages"]) == 1
    work_page = json.loads(
        (tmp_path / "build" / release["work_catalog_pages"][0]["key"]).read_text(encoding="utf-8")
    )
    work = work_page["items"][0]
    assert work["chapter_count"] == 2
    assert work["post_ids"] == [108, 109]
    detail = json.loads((tmp_path / "build" / work["detail_key"]).read_text(encoding="utf-8"))
    assert [chapter["identity"] for chapter in detail["chapters"]] == [
        "arcalive:novel:108:text",
        "arcalive:novel:109:text",
    ]


def test_arcalive_works_group_both_lane_posts_once(tmp_path: Path) -> None:
    """A post saved with images (lane both) joins its work; text wins when both exist."""
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_archive_items SET title='긴 연재 제목 1화'")
        for post_id, content_lane, number in (
            ("109", "both", 2),
            ("110", "both", 3),
            ("110", "text", 3),
        ):
            db.execute(
                """INSERT INTO text_archive_items
                   (identity,lane,source_site,source_board,source_post_id,source_category,
                    content_lane,source_url,title,author,content_sha256,bytes,object_key,
                    batch_id,imported_at)
                   SELECT ?,lane,source_site,source_board,?,source_category,?,source_url,?,
                          author,content_sha256,bytes,object_key,batch_id,imported_at
                   FROM text_archive_items WHERE source_post_id='108'""",
                (
                    f"arcalive:novel:{post_id}:{content_lane}",
                    post_id,
                    content_lane,
                    f"긴 연재 제목 {number}화",
                ),
            )
    tree = publisher.build_publish_tree(
        db_path, tmp_path / "objects", tmp_path / "build", "arcalive"
    )
    release = json.loads((tmp_path / "build" / tree["release_key"]).read_text(encoding="utf-8"))
    assert release["item_count"] == 4
    work_page = json.loads(
        (tmp_path / "build" / release["work_catalog_pages"][0]["key"]).read_text(encoding="utf-8")
    )
    work = work_page["items"][0]
    assert work["chapter_count"] == 3
    assert work["post_ids"] == [108, 109, 110]
    detail = json.loads((tmp_path / "build" / work["detail_key"]).read_text(encoding="utf-8"))
    assert [chapter["identity"] for chapter in detail["chapters"]] == [
        "arcalive:novel:108:text",
        "arcalive:novel:109:both",
        "arcalive:novel:110:text",
    ]


def test_arcalive_author_repair_verifies_objects_and_replays(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(repair_authors, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "state" / "text.sqlite"
    objects = tmp_path / "objects"
    importer.import_batch(inbox, _BATCH_ID, db_path, objects, inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        object_key = db.execute("SELECT object_key FROM text_archive_items").fetchone()[0]
        db.execute("UPDATE text_archive_items SET author=''")
    assert repair_authors.repair_authors(db_path, objects) == {
        "scanned": 1,
        "updated": 1,
        "missing": 0,
    }
    assert repair_authors.repair_authors(db_path, objects)["scanned"] == 0
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_archive_items SET author=''")
    (objects / object_key).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="failed verification"):
        repair_authors.repair_authors(db_path, objects)


def test_arcalive_catalog_can_pass_novel_canary_limit(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        original = dict(db.execute("SELECT * FROM text_archive_items").fetchone())
        columns = ",".join(original)
        placeholders = ",".join("?" for _ in original)
        for post_id in range(109, 1109):
            row = original.copy()
            row["identity"] = f"arcalive:novel:{post_id}:text"
            row["source_post_id"] = str(post_id)
            db.execute(
                f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
                tuple(row.values()),
            )
    tree = publisher.build_publish_tree(
        db_path, tmp_path / "objects", tmp_path / "build", "arcalive"
    )
    assert tree["item_count"] == 1001
    assert sum(1 for _ in publisher._plan_rows(tree["item_plan"])) == 1001
    assert "items" not in tree


def test_receipt_finalization_pages_more_than_one_hundred_batches(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", receipts)
    with sqlite3.connect(db_path) as db:
        manifest_sha, receipt_json, imported_at = db.execute(
            "SELECT manifest_sha256,receipt_json,imported_at FROM text_archive_batches"
        ).fetchone()
        original = json.loads(receipt_json)
        item = original["items"][0]
        db.execute("DELETE FROM text_archive_batches")
        for number in range(101):
            batch_id = f"20260923T130000Z-pc-{number:08d}"
            receipt = {**original, "batch_id": batch_id}
            db.execute(
                "INSERT INTO text_archive_batches VALUES(?,?,?,?,?)",
                (batch_id, manifest_sha, 1, json.dumps(receipt), imported_at),
            )
        db.execute(
            "INSERT INTO text_archive_publications VALUES(?,?,?)",
            (f"item:{item['identity']}", item["content_sha256"], "2026-09-25T00:00:00Z"),
        )
    publisher._finalize_receipts(db_path, receipts)
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM text_archive_batches WHERE revision=2").fetchone()[0]
            == 101
        )
    assert (receipts / "20260923T130000Z-pc-00000100.json").is_file()


def test_novel_chapters_publish_in_episode_order_not_import_order(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_novel_batch(inbox, _BATCH_ID)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        original = dict(db.execute("SELECT * FROM text_archive_items").fetchone())
        db.execute(
            "UPDATE text_archive_items SET chapter_label='252화', source_chapter_id='252' "
            "WHERE identity=?",
            (original["identity"],),
        )
        earlier = original.copy()
        earlier["identity"] = "novel_chapter:toki:63670:42"
        earlier["canonical_chapter_id"] = earlier["identity"]
        earlier["source_chapter_id"] = "42"
        earlier["chapter_label"] = "42화"
        earlier["imported_at"] = "2099-01-01T00:00:00Z"
        columns = ",".join(earlier)
        placeholders = ",".join("?" for _ in earlier)
        db.execute(
            f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
            tuple(earlier.values()),
        )
        db.execute(
            """INSERT INTO text_novel_chapters(
               site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
               source_episode_number_raw,source_episode_number_normalized,
               source_toc_position,access,status,last_seen_at)
               VALUES('toki','63670','42','42화','main','42',42,1,'free','complete','now')"""
        )
        numbered = earlier.copy()
        numbered["identity"] = "novel_chapter:toki:63670:12"
        numbered["canonical_chapter_id"] = numbered["identity"]
        numbered["source_chapter_id"] = "12"
        numbered["chapter_label"] = "제12화: 귀환"
        db.execute(
            f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
            tuple(numbered.values()),
        )
        db.execute(
            """INSERT INTO text_novel_chapters(
               site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
               source_episode_number_raw,source_episode_number_normalized,
               source_toc_position,access,status,last_seen_at)
               VALUES('toki','63670','12','제12화: 귀환','main','12',12,0,
                      'free','complete','now')"""
        )
        for label, source_id, imported_at in (
            ("프롤로그", "prologue", "2098-01-01T00:00:00Z"),
            ("에필로그", "epilogue", "2100-01-01T00:00:00Z"),
        ):
            extra = earlier.copy()
            extra["identity"] = f"novel_chapter:toki:63670:{source_id}"
            extra["canonical_chapter_id"] = extra["identity"]
            extra["source_chapter_id"] = source_id
            extra["chapter_label"] = label
            extra["imported_at"] = imported_at
            db.execute(
                f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
                tuple(extra.values()),
            )
    publisher.build_publish_tree(db_path, tmp_path / "objects", tmp_path / "build", "novel")
    details = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (tmp_path / "build" / "published" / "indexes" / "novel").glob("*.json")
    ]
    chapters = next(page["chapters"] for page in details if "chapters" in page)
    assert [chapter["label"] for chapter in chapters] == [
        "프롤로그",
        "제12화: 귀환",
        "42화",
        "252화",
        "에필로그",
    ]
    assert [chapter["reading_order"] for chapter in chapters] == list(range(len(chapters)))
    assert chapters[2]["source_episode_number_raw"] == "42"
    assert chapters[2]["source_episode_number"] == 42
    assert chapters[2]["source_toc_position"] == 1
    assert "novel:toki:63670:42" in chapters[2]["legacy_chapter_ids"]
    assert "novel_chapter:toki:63670:42" in chapters[2]["legacy_chapter_ids"]
    catalog = next(page["items"] for page in details if "items" in page)
    assert catalog[0]["latest_label"] == "252화"


def test_publisher_collapses_exact_cross_source_chapter_copies(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_novel_batch(inbox, _BATCH_ID)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        original = dict(db.execute("SELECT * FROM text_archive_items").fetchone())
        work_id = original["canonical_work_id"]
        duplicate = original.copy()
        duplicate.update(
            identity="novel_chapter:blacktoon:24753:914174",
            source_site="blacktoon",
            source_work_id="24753",
            source_chapter_id="914174",
            canonical_chapter_id="novel:blacktoon:24753:914174",
            source_url="https://blacktoon452.com/novel/24753/914174",
            imported_at="2099-01-01T00:00:00Z",
        )
        columns = ",".join(duplicate)
        placeholders = ",".join("?" for _ in duplicate)
        db.execute(
            f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
            tuple(duplicate.values()),
        )
        db.execute(
            "INSERT INTO text_novel_work_group_sources VALUES('blacktoon','24753',?)",
            (work_id,),
        )

    publisher.build_publish_tree(db_path, tmp_path / "objects", tmp_path / "build", "novel")
    pages = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (tmp_path / "build" / "published" / "indexes" / "novel").glob("*.json")
    ]
    detail = next(page for page in pages if "chapters" in page)
    assert len(detail["chapters"]) == 1
    assert {row["source_site"] for row in detail["chapters"][0]["source_variants"]} == {
        "toki",
        "blacktoon",
    }
    assert "novel:toki:63670:8794077" in detail["chapters"][0]["legacy_chapter_ids"]
    assert "novel_chapter:blacktoon:24753:914174" in detail["chapters"][0]["legacy_chapter_ids"]
    catalog = next(page["items"] for page in pages if "items" in page)
    assert catalog[0]["chapter_count"] == 1


def test_novel_catalog_preserves_pre_link_work_ids_as_aliases(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_novel_batch(inbox, _BATCH_ID)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.execute("INSERT INTO text_novel_work_groups VALUES('novel:linked:abc', 'now')")
        db.execute(
            "UPDATE text_novel_work_group_sources SET canonical_work_id='novel:linked:abc' "
            "WHERE site='toki' AND source_work_id='63670'"
        )
        db.execute(
            "INSERT INTO text_novel_work_group_sources "
            "VALUES('blacktoon','24753','novel:linked:abc')"
        )
        db.execute(
            "INSERT INTO text_novel_work_aliases "
            "VALUES('novel:old-linked','novel:linked:abc','now')"
        )
        db.execute(
            "UPDATE text_archive_items SET canonical_work_id='novel:linked:abc' WHERE lane='novel'"
        )

    publisher.build_publish_tree(db_path, tmp_path / "objects", tmp_path / "build", "novel")
    pages = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (tmp_path / "build" / "published" / "indexes" / "novel").glob("*.json")
    ]
    catalog = next(page["items"] for page in pages if "items" in page)
    assert catalog[0]["work_id"] == "novel:linked:abc"
    assert catalog[0]["legacy_work_ids"] == [
        "novel:blacktoon:24753",
        "novel:old-linked",
        "novel:toki:63670",
    ]


def test_novel_catalog_can_pass_old_canary_limit(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    _incoming_novel_batch(inbox, _BATCH_ID)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", inbox / "receipts")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        original = dict(db.execute("SELECT * FROM text_archive_items").fetchone())
        columns = ",".join(original)
        placeholders = ",".join("?" for _ in original)
        for chapter_id in range(9000000, 9001000):
            row = original.copy()
            row["identity"] = f"novel_chapter:toki:63670:{chapter_id}"
            row["canonical_chapter_id"] = row["identity"]
            row["source_chapter_id"] = str(chapter_id)
            db.execute(
                f"INSERT INTO text_archive_items ({columns}) VALUES ({placeholders})",
                tuple(row.values()),
            )
    tree = publisher.build_publish_tree(db_path, tmp_path / "objects", tmp_path / "build", "novel")
    assert tree["item_count"] == 1001
    assert sum(1 for _ in publisher._plan_rows(tree["item_plan"])) == 1001


def test_publisher_readback_failure_never_switches_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    _incoming_batch(inbox)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, _BATCH_ID, db_path, tmp_path / "objects", receipts)
    remote: dict[str, bytes] = {}
    calls: list[list[str]] = []

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(argv)
        if argv[3] == "copyto":
            remote_path = argv[5].split("redstm-text-archive/", 1)[1]
            remote[remote_path] = Path(argv[4]).read_bytes()
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        return subprocess.CompletedProcess(argv, 0, b"wrong", b"")

    with pytest.raises(OSError, match="readback mismatch"):
        publisher.publish_lane(
            db_path,
            tmp_path / "objects",
            tmp_path / "build",
            receipts,
            "arcalive",
            runner=rclone,
        )
    assert not any(argv[3] == "copyto" and argv[5].endswith("/release.json") for argv in calls)
    assert json.loads((receipts / f"{_BATCH_ID}.json").read_text())["revision"] == 1


def test_object_batch_uses_downloaded_sha256_before_accepting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    objects = []
    for content in (b"first", b"second"):
        digest = hashlib.sha256(content).hexdigest()
        key = f"published/objects/sha256/{digest[:2]}/{digest}.md"
        path = tmp_path / key.removeprefix("published/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        objects.append((key, digest))
    calls: list[str] = []

    def rclone(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        assert kwargs["timeout"] == 5 * 60
        calls.append(argv[3])
        if argv[3] == "copy":
            assert argv[4] == str(tmp_path / "objects/sha256")
            assert argv[argv.index("--transfers") + 1] == "2"
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        assert argv[3:5] == ["hashsum", "SHA256"]
        assert "--download" in argv
        checkfile = Path(argv[argv.index("--checkfile") + 1]).read_text()
        assert all(
            f"{digest}  {key.removeprefix('published/objects/sha256/')}" in checkfile
            for key, digest in objects
        )
        raise subprocess.CalledProcessError(1, argv)

    with pytest.raises(OSError, match="readback mismatch"):
        publisher._publish_object_batch(
            tmp_path / "build", tmp_path, "r2text:redstm-text-archive", objects, rclone
        )
    assert calls == ["copy", "hashsum"]


def test_derived_artifact_repairs_same_size_damage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = b"verified index"
    path = tmp_path / f"{hashlib.sha256(body).hexdigest()}.json"
    publisher._write_content_addressed(path, body)
    original = publisher._write
    writes = []

    def write(target: Path, value: bytes) -> None:
        writes.append(target)
        original(target, value)

    monkeypatch.setattr(publisher, "_write", write)
    publisher._write_content_addressed(path, body)
    assert writes == []
    path.write_bytes(b"x" * len(body))
    publisher._write_content_addressed(path, body)
    assert path.read_bytes() == body
    assert writes == [path]


def test_novel_publisher_writes_a_paged_receipt_snapshot_after_r2_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000002"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    remote: dict[str, bytes] = {}
    calls: list[tuple[str, str]] = []

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] in {"copy", "hashsum"}:
            return _fake_r2(remote)(argv)
        if argv[3] == "copyto":
            local, remote_path = argv[4], argv[5]
            key = remote_path.split("redstm-text-archive/", 1)[1]
            remote[key] = Path(local).read_bytes()
            calls.append(("copy", key))
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        key = argv[4].split("redstm-text-archive/", 1)[1]
        calls.append(("cat", key))
        return subprocess.CompletedProcess(argv, 0, remote[key], b"")

    written: list[Path] = []
    original_write = publisher._write

    def record_write(path: Path, body: bytes) -> None:
        written.append(path)
        original_write(path, body)

    monkeypatch.setattr(publisher, "_write", record_write)
    result = publisher.publish_lane(
        db_path,
        tmp_path / "objects",
        tmp_path / "build",
        receipts,
        "novel",
        runner=rclone,
    )
    current = json.loads(
        (receipts / "availability" / "novel" / "current.json").read_text(encoding="utf-8")
    )
    manifest_path = inbox / current["manifest_key"]
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    page_ref = manifest["pages"][0]
    page_bytes = (inbox / page_ref["key"]).read_bytes()
    page = json.loads(page_bytes)
    assert result["availability"]["snapshot_id"] == current["snapshot_id"]
    assert hashlib.sha256(manifest_bytes).hexdigest() == current["manifest_sha256"]
    assert hashlib.sha256(page_bytes).hexdigest() == page_ref["sha256"]
    assert page["items"][0]["identity"] == "novel_chapter:toki:63670:8794077"
    assert "body" not in page["items"][0]
    availability_writes = [path.name for path in written if "availability" in path.parts]
    assert availability_writes[-1] == "current.json"
    assert calls[-2:] == [
        ("copy", "published/novel/release.json"),
        ("cat", "published/novel/release.json"),
    ]
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE text_archive_publications SET verified_at='2020-01-01T00:00:00Z' "
            "WHERE key='item:novel_chapter:toki:63670:8794077'"
        )
    publisher.publish_lane(
        db_path,
        tmp_path / "objects",
        tmp_path / "build",
        receipts,
        "novel",
        runner=rclone,
    )
    current = json.loads(
        (receipts / "availability" / "novel" / "current.json").read_text(encoding="utf-8")
    )
    manifest = json.loads((inbox / current["manifest_key"]).read_text(encoding="utf-8"))
    page = json.loads((inbox / manifest["pages"][0]["key"]).read_text(encoding="utf-8"))
    assert page["items"][0]["published_at"] == "2020-01-01T00:00:00Z"
    with sqlite3.connect(db_path) as db:
        db.execute("INSERT INTO text_novel_work_groups VALUES('linked', 'now')")
        db.execute(
            "UPDATE text_novel_work_group_sources SET canonical_work_id='linked' "
            "WHERE site='toki' AND source_work_id='63670'"
        )
        db.execute("INSERT INTO text_novel_work_group_sources VALUES('blacktoon','24753','linked')")
        db.execute("UPDATE text_archive_items SET canonical_work_id='linked' WHERE lane='novel'")
    publisher.build_availability_snapshot(db_path, receipts)
    current = json.loads(
        (receipts / "availability" / "novel" / "current.json").read_text(encoding="utf-8")
    )
    manifest = json.loads((inbox / current["manifest_key"]).read_text(encoding="utf-8"))
    page = json.loads((inbox / manifest["pages"][0]["key"]).read_text(encoding="utf-8"))
    assert page["items"][0]["linked_sources"] == ["blacktoon:24753", "toki:63670"]


def test_novel_availability_streaming_keeps_snapshot_hash_across_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000002"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        columns = [row[1] for row in db.execute("PRAGMA table_info(text_archive_items)")]
        original = dict(
            db.execute("SELECT * FROM text_archive_items WHERE lane='novel'").fetchone()
        )
        second = dict(original)
        second["identity"] = "novel_chapter:toki:63670:8794078"
        second["source_chapter_id"] = "8794078"
        second["canonical_chapter_id"] = "8794078"
        second["source_url"] = "https://toki31.com/novel/63670/8794078"
        db.execute(
            f"INSERT INTO text_archive_items({','.join(columns)}) "
            f"VALUES({','.join('?' for _ in columns)})",
            [second[column] for column in columns],
        )
        db.executemany(
            "INSERT INTO text_archive_publications(key,sha256,verified_at) VALUES(?,?,?)",
            [
                (f"item:{identity}", original["content_sha256"], "2026-09-25T00:00:00Z")
                for identity in (original["identity"], second["identity"])
            ],
        )
    monkeypatch.setattr(publisher, "_AVAILABILITY_PAGE_SIZE", 1)
    result = publisher.build_availability_snapshot(db_path, receipts)
    pointer = json.loads((receipts / "availability/novel/current.json").read_text(encoding="utf-8"))
    manifest = json.loads((inbox / pointer["manifest_key"]).read_text(encoding="utf-8"))
    items = [
        json.loads((inbox / page["key"]).read_text(encoding="utf-8"))["items"][0]
        for page in manifest["pages"]
    ]
    assert result["item_count"] == manifest["page_count"] == 2
    assert pointer["snapshot_id"] == hashlib.sha256(publisher._json_bytes(items)).hexdigest()


def test_novel_availability_pages_stay_under_the_newtomi_byte_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Long Korean metadata closes a page before 500 items instead of exceeding 1 MiB."""
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000010"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        columns = [row[1] for row in db.execute("PRAGMA table_info(text_archive_items)")]
        original = dict(
            db.execute("SELECT * FROM text_archive_items WHERE lane='novel'").fetchone()
        )
        db.execute("DELETE FROM text_archive_items")
        rows = []
        for index in range(1200):
            row = dict(original)
            row["identity"] = f"novel_chapter:toki:63670:{index:07d}"
            row["source_chapter_id"] = row["canonical_chapter_id"] = f"{index:07d}"
            row["title"] = "가" * 500
            row["author"] = "나" * 300
            row["chapter_label"] = "다" * 300
            rows.append(row)
        db.executemany(
            f"INSERT INTO text_archive_items({','.join(columns)}) "
            f"VALUES({','.join('?' for _ in columns)})",
            [[row[column] for column in columns] for row in rows],
        )
        db.executemany(
            "INSERT INTO text_archive_publications(key,sha256,verified_at) VALUES(?,?,?)",
            [
                (f"item:{row['identity']}", original["content_sha256"], "2026-09-25T00:00:00Z")
                for row in rows
            ],
        )
    result = publisher.build_availability_snapshot(db_path, receipts)
    pointer = json.loads((receipts / "availability/novel/current.json").read_text(encoding="utf-8"))
    manifest = json.loads((inbox / pointer["manifest_key"]).read_text(encoding="utf-8"))
    sizes = [(inbox / page["key"]).stat().st_size for page in manifest["pages"]]
    assert result["item_count"] == sum(page["item_count"] for page in manifest["pages"]) == 1200
    assert manifest["page_count"] > 3 and manifest["page_size"] == 500
    assert all(0 < page["item_count"] <= 500 for page in manifest["pages"])
    assert max(sizes) <= publisher._AVAILABILITY_PAGE_BYTES
    assert max(sizes) > publisher._AVAILABILITY_PAGE_BYTES - 4096

    # One item that cannot fit any page leaves the previous current.json in place.
    monkeypatch.setattr(publisher, "_AVAILABILITY_PAGE_BYTES", 1024)
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_archive_items SET author='라' WHERE source_chapter_id='0000000'")
    with pytest.raises(ValueError, match="exceeds a page"):
        publisher.build_availability_snapshot(db_path, receipts)
    after = json.loads((receipts / "availability/novel/current.json").read_text(encoding="utf-8"))
    assert after == pointer


def test_novel_availability_keeps_newtomi_item_contract(tmp_path: Path) -> None:
    """Newtomi rejects a whole snapshot on one item outside main/side or free access."""
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000009"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        columns = [row[1] for row in db.execute("PRAGMA table_info(text_archive_items)")]
        original = dict(
            db.execute("SELECT * FROM text_archive_items WHERE lane='novel'").fetchone()
        )
        rows = []
        for chapter_id, label, kind, access in (
            ("8794078", "번외편", "SIDE_STORY", "free"),
            ("8794079", "후기", "legacy", "free"),
            ("8794080", "5화", "main", "point"),
        ):
            row = dict(original)
            row.update(
                identity=f"novel_chapter:toki:63670:{chapter_id}",
                source_chapter_id=chapter_id,
                source_url=f"https://toki31.com/novel/63670/{chapter_id}",
                chapter_label=label,
                chapter_kind=kind,
                access=access,
            )
            rows.append(row)
        db.executemany(
            f"INSERT INTO text_archive_items({','.join(columns)}) "
            f"VALUES({','.join('?' for _ in columns)})",
            [[row[column] for column in columns] for row in rows],
        )
        db.executemany(
            "INSERT INTO text_archive_publications(key,sha256,verified_at) VALUES(?,?,?)",
            [
                (f"item:{row['identity']}", original["content_sha256"], "2026-09-25T00:00:00Z")
                for row in (original, *rows)
            ],
        )
    publisher.build_availability_snapshot(db_path, receipts)
    pointer = json.loads((receipts / "availability/novel/current.json").read_text(encoding="utf-8"))
    manifest = json.loads((inbox / pointer["manifest_key"]).read_text(encoding="utf-8"))
    items = [
        item
        for page in manifest["pages"]
        for item in json.loads((inbox / page["key"]).read_text(encoding="utf-8"))["items"]
    ]
    kinds = {item["source_chapter_id"]: item["chapter_kind"] for item in items}
    assert kinds == {original["source_chapter_id"]: "main", "8794078": "side", "8794079": "side"}
    assert {item["access"] for item in items} == {"free"}


def test_publisher_does_not_claim_an_item_imported_after_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000003"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "text.sqlite"
    objects = tmp_path / "objects"
    importer.import_batch(inbox, batch_id, db_path, objects, inbox / "receipts")
    original_build = publisher.build_publish_tree

    def build_then_import(
        db_path_arg: Path,
        object_root: Path,
        output_root: Path,
        lane: str,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        tree = original_build(db_path_arg, object_root, output_root, lane, **_kwargs)
        if _kwargs.get("verified_only"):
            return tree
        with sqlite3.connect(db_path) as db:
            db.execute(
                """INSERT INTO text_archive_items(
                   identity,lane,source_site,source_work_id,source_chapter_id,source_url,
                   chapter_label,chapter_kind,content_sha256,bytes,object_key,
                   canonical_work_id,batch_id,imported_at)
                   VALUES('novel_chapter:toki:63670:999','novel','toki','63670','999',
                          'https://toki31.com/novel/63670/999','999화','main',?,1,
                          'objects/late.md','novel:toki:63670','late','now')""",
                ("f" * 64,),
            )
        return tree

    monkeypatch.setattr(publisher, "build_publish_tree", build_then_import)
    remote: dict[str, bytes] = {}

    def rclone(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] in {"copy", "hashsum"}:
            return _fake_r2(remote)(argv)
        key = argv[5 if argv[3] == "copyto" else 4].split("redstm-text-archive/", 1)[1]
        if argv[3] == "copyto":
            remote[key] = Path(argv[4]).read_bytes()
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        return subprocess.CompletedProcess(argv, 0, remote[key], b"")

    publisher.publish_lane(
        db_path, objects, tmp_path / "build", inbox / "receipts", "novel", runner=rclone
    )
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute(
                "SELECT 1 FROM text_archive_publications "
                "WHERE key='item:novel_chapter:toki:63670:999'"
            ).fetchone()
            is None
        )


def test_inbox_sftp_starts_at_chroot_root_for_drop_and_receipt_paths() -> None:
    template = Path("deploy/text-archive/sshd-match.conf").read_text(encoding="utf-8")
    assert "ForceCommand internal-sftp -u 0027 -d /" in template


def test_oracle_collector_checkpoints_and_skips_paid_chapters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REDSTM_TEXT_JSON_OWNER", "oracle")
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    objects = tmp_path / "objects"
    sources = collector.configured_sources({})
    session: Any = FakeSession(
        FakeResponse(
            {
                "data": {
                    "content": [{"id": 24753, "slug": "63670", "title": "T", "author": "A"}],
                    "total": 1,
                    "size": 96,
                }
            }
        ),
        FakeResponse({"data": {"content": [], "total": 0, "size": 96}}),
        FakeResponse(
            {
                "work": {
                    "id": 24753,
                    "title": "T",
                    "author": "A",
                },
                "episodes": [
                    {"id": 914174, "title": "1화", "episodeNumber": 1, "isFree": True},
                    {"id": 914175, "title": "2화", "price": 5},
                ],
            }
        ),
        FakeResponse(
            {
                "data": {
                    "id": 914174,
                    "title": "1화",
                    "bodyJson": [{"type": "paragraph", "text": "sample chapter"}],
                }
            }
        ),
    )
    catalog = collector.run_one(db_path, objects, sources, session=session)
    sibling_catalog = collector.run_one(db_path, objects, sources, session=session)
    work = collector.run_one(db_path, objects, sources, body_source="blacktoon", session=session)
    chapter = collector.run_one(db_path, objects, sources, body_source="blacktoon", session=session)
    assert [catalog["status"], sibling_catalog["status"], work["status"], chapter["status"]] == [
        "listed",
        "listed",
        "work_indexed",
        "chapter_saved",
    ]
    assert session.trust_env is False
    assert ["blacktoon454.com" in session.calls[index] for index in range(3)] == [True, False, True]
    with sqlite3.connect(db_path) as db:
        rows = db.execute(
            "SELECT source_chapter_id,access,status FROM text_novel_chapters "
            "ORDER BY source_chapter_id"
        ).fetchall()
        assert rows == [("914174", "free", "complete"), ("914175", "point", "waiting")]
        assert (
            db.execute(
                "SELECT title FROM text_novel_sources "
                "WHERE site='blacktoon' AND source_work_id='24753'"
            ).fetchone()[0]
            == "T"
        )
        assert db.execute(
            """SELECT source_episode_number_raw,source_episode_number_normalized,
                      source_toc_position FROM text_novel_chapters
               WHERE source_chapter_id='914174'"""
        ).fetchone() == ("1", 1.0, 0)
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 1
    body_path = objects / "objects" / "sha256" / chapter["sha256"][:2] / f"{chapter['sha256']}.md"
    assert body_path.read_text(encoding="utf-8") == "sample chapter\n"


def test_work_refresh_keeps_paid_and_review_markers(tmp_path: Path) -> None:
    # A work list without price fields must not undo what episode details learned: a
    # reset paid chapter would be fetched again every week.
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    unit = collector.RequestUnit(
        collector.Source("blacktoon", "blacktoon452.com"),
        "work",
        "42",
        "https://blacktoon452.com/api/works/42",
    )
    payload = {
        "work": {"id": 42, "title": "작품", "author": "작가"},
        "episodes": [{"id": 1, "number": 1}, {"id": 2, "number": 2}, {"id": 3, "number": 3}],
    }
    try:
        collector._apply_work(db, unit, payload, None)
        with db:
            db.execute(
                "UPDATE text_novel_chapters SET chapter_label='1화',chapter_kind='side',"
                "source_published_at='2026-01-01' WHERE source_chapter_id='1'"
            )
        collector._apply_work(db, unit, payload, None)
        kept = db.execute(
            "SELECT chapter_label,chapter_kind,source_published_at FROM text_novel_chapters "
            "WHERE source_chapter_id='1'"
        ).fetchone()
        assert tuple(kept) == ("1화", "side", "2026-01-01")
        titled = {
            **payload,
            "episodes": [{"id": 1, "number": 1, "title": "1화 개정", "publishedAt": "2026-02-02"}],
        }
        collector._apply_work(db, unit, titled, None)
        revised = db.execute(
            "SELECT chapter_label,source_published_at FROM text_novel_chapters "
            "WHERE source_chapter_id='1'"
        ).fetchone()
        assert tuple(revised) == ("1화 개정", "2026-02-02")
        with db:
            db.execute(
                "UPDATE text_novel_chapters SET access='point',status='waiting' "
                "WHERE source_chapter_id='1'"
            )
            db.execute(
                "UPDATE text_novel_chapters SET status='parse_review' WHERE source_chapter_id='2'"
            )
        collector._apply_work(db, unit, payload, None)
        rows = db.execute(
            "SELECT source_chapter_id,access,status FROM text_novel_chapters "
            "ORDER BY source_chapter_id"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("1", "point", "waiting"),
            ("2", "unknown", "parse_review"),
            ("3", "unknown", "unknown_access"),
        ]
        # An explicit free answer still releases a waiting chapter.
        free = {**payload, "episodes": [{"id": 1, "number": 1, "isFree": True}]}
        collector._apply_work(db, unit, free, None)
        assert tuple(
            db.execute(
                "SELECT access,status FROM text_novel_chapters WHERE source_chapter_id='1'"
            ).fetchone()
        ) == ("free", "discovered")
    finally:
        db.close()


def test_failed_units_back_off_and_removed_ones_wait_for_rare_reprobe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    try:
        db.executescript(collector._SCHEMA)
        with db:
            db.executemany(
                "INSERT INTO text_collector_queue(source,kind,entity_id,status,updated_at) "
                "VALUES('blacktoon','episode',?,'pending','now')",
                [("1",), ("2",)],
            )
    finally:
        db.close()
    unit = collector.RequestUnit(
        collector.Source("blacktoon", "blacktoon452.com"), "episode", "1", "https://x/1"
    )
    for _ in range(3):
        collector._note_failure(db_path, unit, "http_500", 1_000 + 900, backoff=True, now=1_000)
    gone = collector.RequestUnit(unit.source, "episode", "2", "https://x/2")
    collector._note_failure(db_path, gone, "http_404", 1_000 + 900, backoff=True, now=1_000)
    with sqlite3.connect(db_path) as check:
        rows = check.execute(
            "SELECT entity_id,status,attempts,next_check_at FROM text_collector_queue "
            "ORDER BY entity_id"
        ).fetchall()
    # Third failure waits 900 << 2 seconds; a 404 waits thirty days.
    assert rows == [
        ("1", "retry", 3, 1_000 + 3_600),
        ("2", "gone", 1, 1_000 + collector._GONE_REPROBE),
    ]


@pytest.mark.parametrize(
    "error,status,delay",
    [
        ("episode_body_missing", "retry", 900),
        ("body_empty_or_invalid", "retry", 900),
        ("access_unknown_requires_review", "review", collector._REVIEW_REPROBE),
        ("http_404", "gone", collector._GONE_REPROBE),
    ],
)
def test_collector_rechecks_deferred_bodies_after_their_deadline(
    tmp_path: Path,
    error: str,
    status: str,
    delay: int,
) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    try:
        db.executescript(collector._SCHEMA)
        db.execute(
            "INSERT INTO text_collector_queue(source,kind,entity_id,status,updated_at) "
            "VALUES('blacktoon','episode','1','pending','now')"
        )
        db.commit()
        source = collector.Source("blacktoon", "blacktoon452.com")
        unit = collector.RequestUnit(source, "episode", "1", source.base_url + "/api/episodes/1")
        collector._note_failure(db_path, unit, error, 1_900, backoff=True, now=1_000)
        assert tuple(
            db.execute("SELECT status,next_check_at FROM text_collector_queue").fetchone()
        ) == (status, 1_000 + delay)
        sources = collector.configured_sources({})
        assert collector._next_unit(db, sources, 1_000 + delay - 1, "both").kind == "list"
        db.execute(
            "INSERT INTO text_collector_state(source,next_page,next_check_at,updated_at) "
            "VALUES('blacktoon:list',0,?,'now'),('marumaru:list',0,?,'now')",
            (1_000 + delay + 10, 1_000 + delay + 10),
        )
        assert collector._next_unit(db, sources, 1_000 + delay, "both").entity_id == "1"
    finally:
        db.close()


def test_work_recrawl_repairs_imported_title_without_changing_identity(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    unit = collector.RequestUnit(
        collector.Source("blacktoon", "blacktoon452.com"),
        "work",
        "42",
        "https://blacktoon452.com/api/works/42",
    )
    try:
        with db:
            db.execute(
                """INSERT INTO text_archive_items(
                   identity,lane,source_site,source_work_id,source_chapter_id,
                   source_url,title,author,content_sha256,bytes,object_key,batch_id,imported_at)
                   VALUES('novel:blacktoon:42:7','novel','blacktoon','42','7',
                          'https://blacktoon452.com/novel/42/7','7화','',
                          'hash',1,'object','batch','now')"""
            )
        payload = {"work": {"id": 42, "title": "작품", "author": "작가"}, "episodes": []}
        collector._apply_work(db, unit, payload, None)
        assert tuple(
            db.execute(
                "SELECT identity,source_chapter_id,title,author FROM text_archive_items"
            ).fetchone()
        ) == ("novel:blacktoon:42:7", "7", "작품", "작가")
        db.execute("UPDATE text_novel_sources SET slug='known' WHERE source_work_id='42'")
        collector._apply_list(
            db,
            collector.RequestUnit(unit.source, "list", "0", unit.source.base_url),
            {
                "content": [{"id": 42, "title": "", "author": "", "slug": ""}],
                "total": 1,
                "size": 96,
            },
        )
        assert tuple(
            db.execute(
                "SELECT slug,title,author,title_key,author_key FROM text_novel_sources"
            ).fetchone()
        ) == ("known", "작품", "작가", importer._title_key("작품"), importer._title_key("작가"))
        db.execute("UPDATE text_archive_items SET author='' WHERE source_work_id='42'")
        collector._apply_work(
            db, unit, {"work": {"id": 42, "title": "새 작품"}, "episodes": []}, None
        )
        assert tuple(db.execute("SELECT title,author FROM text_archive_items").fetchone()) == (
            "새 작품",
            "작가",
        )
        with pytest.raises(collector.CollectorError, match="work_title_missing"):
            collector._apply_work(db, unit, {"work": {"id": 42}, "episodes": []}, None)
        assert tuple(db.execute("SELECT title,author FROM text_novel_sources").fetchone()) == (
            "새 작품",
            "작가",
        )
    finally:
        db.close()


def test_pc_import_keeps_known_work_metadata_when_new_chapter_omits_it(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    db_path = tmp_path / "text.sqlite"
    objects = tmp_path / "objects"
    receipts = inbox / "receipts"
    _incoming_novel_batch(inbox, _BATCH_ID)
    importer.import_batch(inbox, _BATCH_ID, db_path, objects, receipts)

    next_id = "20260927T000000Z-pc-00000002"
    _incoming_novel_batch(inbox, next_id)
    batch = inbox / "drop" / next_id
    manifest = json.loads((batch / "manifest.json").read_text(encoding="utf-8"))
    item = manifest["items"][0]
    item.update(
        identity="novel_chapter:toki:63670:8794078",
        source_chapter_id="8794078",
        source_url="https://toki31.com/novel/63670/8794078",
        work_title="",
        author="",
    )
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    (batch / "manifest.json").write_bytes(raw)
    (batch / "ready.json").write_text(
        json.dumps(
            {"schema": 1, "batch_id": next_id, "manifest_sha256": hashlib.sha256(raw).hexdigest()}
        ),
        encoding="utf-8",
    )
    result = importer.import_batch(inbox, next_id, db_path, objects, receipts)
    assert result is not None and result["items"][0]["status"] == "accepted"
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT title,author,title_key,author_key FROM text_novel_sources WHERE site='toki'"
        ).fetchone() == ("작품", "작가", importer._title_key("작품"), importer._title_key("작가"))
        assert db.execute(
            "SELECT title,author FROM text_archive_items WHERE source_chapter_id='8794078'"
        ).fetchone() == ("작품", "작가")


def test_collector_keeps_indexing_work_after_first_hundred_attempts(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        db.executescript(collector._SCHEMA)
        db.execute(
            "INSERT INTO text_collector_queue"
            "(source,kind,entity_id,status,attempts,updated_at) "
            "VALUES('blacktoon','work','24753','pending',100,'now')"
        )
        db.executemany(
            "INSERT INTO text_collector_state"
            "(source,next_page,total_count,page_size,next_check_at,updated_at) "
            "VALUES(?,0,0,96,100,'now')",
            [("blacktoon:list",), ("marumaru:list",)],
        )
        unit = collector._next_unit(db, collector.configured_sources({}), 1, None)
        assert (unit.source.name, unit.kind, unit.entity_id) == ("blacktoon", "work", "24753")
    finally:
        db.close()


def test_collector_finishes_due_catalog_pages_before_work_details(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        db.executescript(collector._SCHEMA)
        db.execute(
            "INSERT INTO text_collector_queue"
            "(source,kind,entity_id,status,updated_at) "
            "VALUES('blacktoon','work','24753','pending','now')"
        )
        db.execute(
            "INSERT INTO text_collector_state"
            "(source,next_page,total_count,page_size,next_check_at,updated_at) "
            "VALUES('blacktoon:list',1,8000,96,0,'now')"
        )
        db.execute(
            "INSERT INTO text_collector_state"
            "(source,next_page,total_count,page_size,next_check_at,updated_at) "
            "VALUES('marumaru:list',0,0,96,100,'now')"
        )
        unit = collector._next_unit(db, collector.configured_sources({}), 1, None)
        assert (unit.source.name, unit.kind, unit.entity_id) == ("blacktoon", "list", "1")
    finally:
        db.close()


def test_body_canary_is_not_starved_by_work_details(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        db.executescript(collector._SCHEMA)
        db.executemany(
            "INSERT INTO text_collector_queue"
            "(source,kind,entity_id,status,attempts,updated_at) VALUES(?,?,?,?,?,'now')",
            [
                ("blacktoon", "work", "24753", "pending", 0),
                ("blacktoon", "episode", "914174", "pending", 0),
            ],
        )
        db.executemany(
            "INSERT INTO text_collector_state"
            "(source,next_page,total_count,page_size,next_check_at,updated_at) "
            "VALUES(?,0,0,96,100,'now')",
            [("blacktoon:list",), ("marumaru:list",)],
        )
        sources = collector.configured_sources({})
        assert collector._next_unit(db, sources, 1, "blacktoon").kind == "episode"
        db.execute("UPDATE text_collector_queue SET attempts=1 WHERE kind='episode'")
        assert collector._next_unit(db, sources, 1, "blacktoon").kind == "work"
        db.execute("UPDATE text_collector_queue SET status='done' WHERE source='blacktoon'")
        db.execute(
            "INSERT INTO text_collector_queue"
            "(source,kind,entity_id,status,updated_at) "
            "VALUES('marumaru','episode','1472536','pending','now')"
        )
        assert collector._next_unit(db, sources, 1, "both").source.name == "marumaru"
        assert collector._next_unit(db, sources, 1, "both").kind == "episode"
    finally:
        db.close()


def test_oracle_collector_probes_unknown_access_without_publishing_paid_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REDSTM_TEXT_JSON_OWNER", "oracle")
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    sources = collector.configured_sources({})
    session: Any = FakeSession(
        FakeResponse({"content": [{"id": 24743, "title": "Novel"}], "total": 1, "size": 96}),
        FakeResponse({"content": [], "total": 0, "size": 96}),
        FakeResponse(
            {
                "work": {"id": 24743, "title": "Novel"},
                "episodes": [{"id": 31027, "number": 1}, {"id": 31028, "number": 2}],
            }
        ),
        FakeResponse({"id": 31027, "bodyJson": '[{"kind":"paid","text":"locked"}]'}),
        FakeResponse({"id": 31028, "bodyJson": '[{"kind":"narration","text":"free text"}]'}),
    )
    results = [
        collector.run_one(
            db_path, tmp_path / "objects", sources, body_source="blacktoon", session=session
        )
        for _ in range(5)
    ]
    assert [result["status"] for result in results] == [
        "listed",
        "listed",
        "work_indexed",
        "waiting",
        "chapter_saved",
    ]
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT source_chapter_id,access,status FROM text_novel_chapters "
            "ORDER BY source_chapter_id"
        ).fetchall() == [("31027", "point", "waiting"), ("31028", "free", "complete")]
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 1
        assert (
            db.execute(
                "SELECT SUM(attempts) FROM text_collector_queue WHERE kind='episode'"
            ).fetchone()[0]
            == 2
        )
        assert (
            db.execute(
                "SELECT COUNT(*) FROM text_collector_queue "
                "WHERE kind='episode' AND status='pending'"
            ).fetchone()[0]
            == 0
        )


def test_enabling_body_canary_queues_already_indexed_unknown_chapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REDSTM_TEXT_JSON_OWNER", "oracle")
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    sources = collector.configured_sources({})
    session: Any = FakeSession(
        FakeResponse({"content": [{"id": 24743, "title": "Novel"}], "total": 1, "size": 96}),
        FakeResponse({"content": [], "total": 0, "size": 96}),
        FakeResponse({"work": {"id": 24743, "title": "Novel"}, "episodes": [{"id": 31027}]}),
        FakeResponse({"id": 31027, "bodyJson": '[{"kind":"narration","text":"free text"}]'}),
    )
    for _ in range(3):
        collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute("SELECT COUNT(*) FROM text_collector_queue WHERE kind='episode'").fetchone()[
                0
            ]
            == 0
        )
    result = collector.run_one(
        db_path, tmp_path / "objects", sources, body_source="blacktoon", session=session
    )
    assert result["status"] == "chapter_saved"


def test_approved_novel_link_is_used_for_future_collector_chapters(tmp_path: Path) -> None:
    db_path = tmp_path / "text.sqlite"
    db = importer._connect(db_path)
    db.executescript(collector._SCHEMA)
    with db:
        for site, work_id, url in (
            ("blacktoon", "24753", "https://blacktoon452.com/novel/24753"),
            ("toki", "63670", "https://toki31.com/novel/63670"),
        ):
            db.execute(
                """INSERT INTO text_novel_sources(
                       site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (site, work_id, url, "63670", "에피소드", "작가", "에피소드", "작가", "now"),
            )
        db.execute(
            """INSERT INTO text_novel_chapters(
                   site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                   access,status,last_seen_at)
               VALUES('blacktoon','24753','914176','2화','main','free','discovered','now')"""
        )
        collector._enqueue(db, "blacktoon", "episode", "914176", "24753")
        importer._refresh_link_candidates(db, "toki", "63670")
    db.close()

    approved = importer.resolve_novel_link_candidate(
        db_path,
        "blacktoon",
        "24753",
        "toki",
        "63670",
        accept=True,
    )
    sources = collector.configured_sources({})
    db = importer._connect(db_path)
    try:
        result = collector._apply_episode(
            db,
            tmp_path / "objects",
            collector.RequestUnit(
                sources[0], "episode", "914176", "https://blacktoon452.com/api/episodes/914176"
            ),
            {
                "data": {
                    "id": 914176,
                    "title": "2화",
                    "bodyJson": [{"type": "paragraph", "text": "second chapter"}],
                }
            },
            sources[0].host,
        )
        assert result["status"] == "chapter_saved"
        row = db.execute(
            "SELECT canonical_work_id FROM text_archive_items WHERE source_chapter_id='914176'"
        ).fetchone()
        assert row[0] == approved["canonical_work_id"]
    finally:
        db.close()


def test_linked_chapter_coverage_never_skips_unverified_body(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    try:
        with db:
            db.execute("INSERT INTO text_novel_work_groups VALUES('group', 'now')")
            db.executemany(
                "INSERT INTO text_novel_work_group_sources VALUES(?,?, 'group')",
                [("toki", "63670"), ("blacktoon", "24753")],
            )
            db.execute(
                """INSERT INTO text_archive_items(
                   identity,lane,source_site,source_work_id,source_chapter_id,source_url,
                   chapter_label,chapter_kind,content_sha256,bytes,object_key,
                   canonical_work_id,batch_id,imported_at)
                   VALUES('novel_chapter:toki:63670:1','novel','toki','63670','1','https://toki31.com/novel/63670/1',
                          '1화','main',?,1,'object','group','batch','now')""",
                ("a" * 64,),
            )
            for chapter_id, label in (("2", "1화"), ("3", "2화"), ("4", "2화")):
                db.execute(
                    """INSERT INTO text_novel_chapters(
                       site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                       access,status,last_seen_at)
                       VALUES('blacktoon','24753',?,?,'main','free','discovered','now')""",
                    (chapter_id, label),
                )
                collector._enqueue(db, "blacktoon", "episode", chapter_id, "24753")
            assert importer.mark_cross_source_covered(db, "blacktoon", "24753") == 0
        rows = db.execute(
            "SELECT entity_id,status FROM text_collector_queue ORDER BY entity_id"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("2", "pending"),
            ("3", "pending"),
            ("4", "pending"),
        ]
        with db:
            db.execute(
                """INSERT INTO text_archive_items(
                   identity,lane,source_site,source_work_id,source_chapter_id,source_url,
                   chapter_label,chapter_kind,content_sha256,bytes,object_key,
                   canonical_work_id,batch_id,imported_at)
                   VALUES('novel_chapter:toki:63670:5','novel','toki','63670','5',
                          'https://toki31.com/novel/63670/5','1화','main',?,1,
                          'object-5','group','batch','now')""",
                ("b" * 64,),
            )
            assert importer.mark_cross_source_covered(db, "blacktoon", "24753") == 0
        status = db.execute(
            "SELECT status FROM text_collector_queue WHERE source='blacktoon' AND entity_id='2'"
        ).fetchone()[0]
        assert status == "pending"
    finally:
        db.close()


def test_source_cooldown_does_not_block_sibling_domain_and_unknown_blocks_need_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(
        FakeResponse({}, status=429, headers={"Retry-After": "3600"}),
        FakeResponse({"content": [], "total": 0, "size": 96}),
    )
    first = collector.run_one(
        db_path, tmp_path / "objects", collector.configured_sources({}), session=session
    )
    second = collector.run_one(
        db_path, tmp_path / "objects", collector.configured_sources({}), session=session
    )
    assert collector.configured_body_source({}) is None
    assert first["status"] == "cooldown"
    assert second["status"] == "listed"
    assert second["source"] != first["source"]
    assert len(session.calls) == 2
    with pytest.raises(collector.CollectorError, match="requires_review"):
        collector._plain_text([{"type": "image", "src": "not-followed"}])


def test_ondobook_identity_requires_novel_chapter_url() -> None:
    item = {
        "kind": "novel_chapter",
        "site": "ondobook",
        "source_work_id": "4609",
        "source_chapter_id": "680426",
        "identity": "novel_chapter:ondobook:4609:680426",
        "source_url": "https://25.ondobook.net/bbs/board.php?bo_table=novel&wr_id=680426",
    }
    assert importer._identity_matches(item)[0]
    item["source_url"] = "https://25.ondobook.net/bbs/board.php?bo_table=notice&wr_id=680426"
    assert not importer._identity_matches(item)[0]


def test_upstream_502_cools_only_failed_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(
        FakeResponse({}, status=502),
        FakeResponse({"content": [], "total": 0, "size": 96}),
    )
    sources = collector.configured_sources({})
    first = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    second = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert first["status"] == "held"
    assert second["status"] == "listed"
    assert first["source"] != second["source"]
    assert len(session.calls) == 2


def test_oracle_rotates_only_after_repeated_failure_and_valid_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(
        FakeResponse({}, status=503),
        FakeResponse({}, status=503),
        FakeResponse({"content": [{"id": 24753, "title": "Novel"}], "total": 1, "size": 96}),
    )
    sources = collector.configured_sources({})
    first = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert first["status"] == "held"
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_collector_state SET next_check_at=0 WHERE source='blacktoon:list'")
        db.execute(
            "INSERT INTO text_collector_state(source,next_check_at,updated_at) "
            "VALUES('marumaru:list',9999999999,'test')"
        )
    second = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert second["status"] == "listed"
    assert ["blacktoon454.com" in url for url in session.calls] == [True, True, False]
    assert "blacktoon455.com" in session.calls[-1]
    assert collector.configured_sources({}, db_path)[0].host == "blacktoon455.com"
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute(
                "SELECT source_url FROM text_novel_sources WHERE site='blacktoon'"
            ).fetchone()[0]
            == "https://blacktoon455.com/novel/24753"
        )


def test_oracle_keeps_cycling_candidates_after_one_full_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TABLE text_collector_hosts(source TEXT PRIMARY KEY, host TEXT NOT NULL, "
            "failures INTEGER NOT NULL DEFAULT 0, next_offset INTEGER NOT NULL DEFAULT 1, "
            "blocked INTEGER NOT NULL DEFAULT 0)"
        )
        db.execute(
            "INSERT INTO text_collector_hosts(source,host,failures,next_offset) "
            "VALUES('blacktoon','blacktoon452.com',5000,6)"
        )
    session: Any = FakeSession(
        FakeResponse({}, status=503),
        FakeResponse({"content": [{"id": 24753, "title": "Novel"}], "total": 1, "size": 96}),
    )
    sources = collector.configured_sources({}, db_path)
    result = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert result["status"] == "listed"
    assert "blacktoon453.com" in session.calls[-1]
    assert collector.configured_sources({}, db_path)[0].host == "blacktoon453.com"


def test_oracle_does_not_promote_challenged_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(
        FakeResponse({}, status=503),
        FakeResponse({}, status=503),
        FakeResponse({}, status=403),
    )
    sources = collector.configured_sources({})
    collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_collector_state SET next_check_at=0 WHERE source='blacktoon:list'")
        db.execute(
            "INSERT INTO text_collector_state(source,next_check_at,updated_at) "
            "VALUES('marumaru:list',9999999999,'test')"
        )
    result = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert result["status"] == "cooldown"
    assert collector.configured_sources({}, db_path)[0].host == "blacktoon454.com"
    with sqlite3.connect(db_path) as db:
        # The challenge pauses rotation until its cooldown ends, not forever.
        blocked_until = db.execute(
            "SELECT blocked FROM text_collector_hosts WHERE source='blacktoon'"
        ).fetchone()[0]
    assert time.time() + 5 * 3600 < blocked_until <= time.time() + 6 * 3600 + 60


def test_source_comparison_matches_unique_free_chapter_without_storing_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payloads = iter(
        [
            {"work": {"id": 24753}, "episodes": [{"id": 914174, "title": "1화", "isFree": True}]},
            {"work": {"id": 24753}, "episodes": [{"id": 1472536, "title": "1화", "isFree": True}]},
            {"id": 914174, "bodyJson": [{"type": "paragraph", "text": "same text"}]},
            {"id": 1472536, "bodyJson": [{"type": "paragraph", "text": "same text"}]},
        ]
    )
    calls: list[str] = []

    def fetch(
        _session: object, unit: collector.RequestUnit, _path: Path
    ) -> tuple[int, bytes, dict[str, str]]:
        calls.append(unit.url)
        return 200, json.dumps(next(payloads)).encode(), {}

    monkeypatch.setattr(compare_sources, "_get", fetch)
    session: Any = FakeSession()
    result = compare_sources.compare_work(
        tmp_path / "unused.sqlite", "24753", collector.configured_sources({}), session
    )
    assert result["status"] == "compared" and result["same_body"] is True
    assert result["same_chapter_labels"] is True
    assert result["chapter_counts"] == [1, 1]
    assert result["shared_unique_labels"] == 1
    assert len(calls) == 4


def test_retry_after_http_date_is_bounded_and_invalid_date_uses_default() -> None:
    now = int(datetime(2026, 9, 23, tzinfo=UTC).timestamp())
    far_future = format_datetime(datetime.fromtimestamp(now, UTC) + timedelta(days=30), usegmt=True)

    assert collector._retry_after(far_future, now, 3600) == now + 7 * 24 * 3600
    assert collector._retry_after("not-a-date", now, 3600) == now + 3600


def test_conflicting_episode_access_metadata_never_queues_as_free() -> None:
    _, _, _, episodes = collector.parse_work_detail(
        {
            "id": 24753,
            "title": "Novel",
            "author": "Author",
            "episodes": [
                {"id": 1, "title": "1화", "isFree": False, "price": 0},
                {"id": 2, "title": "2화", "isFree": True, "price": 5},
                {"id": 3, "title": "3화", "isFree": True, "price": 0},
            ],
        }
    )
    assert [episode["access"] for episode in episodes] == ["unknown", "unknown", "free"]


def test_live_json_shape_keeps_unknown_access_and_rejects_paid_placeholder() -> None:
    work_id, _title, _author, episodes = collector.parse_work_detail(
        {"work": {"id": 24743, "title": "Novel"}, "episodes": [{"id": 31027, "number": 1}]}
    )
    assert work_id == "24743"
    assert episodes == [
        {
            "id": "31027",
            "label": "1",
            "has_title": False,
            "has_kind": False,
            "episode_number": 1,
            "source_episode_number_raw": "1",
            "source_toc_position": 0,
            "source_published_at": None,
            "kind": "main",
            "access": "unknown",
        }
    ]
    assert (
        collector._plain_text('[{"kind":"narration","text":"sample chapter"}]') == "sample chapter"
    )
    with pytest.raises(collector.CollectorError, match="requires_review"):
        collector._plain_text('[{"kind":"paid","text":"locked"}]')


def test_work_title_is_independent_of_episode_order() -> None:
    rows = [{"id": 1, "title": "1화 출발"}, {"id": 2, "title": "2화 재회"}]
    for episodes in (rows, list(reversed(rows))):
        detail = collector.parse_work_detail({"id": 7, "title": "실제 작품", "episodes": episodes})
        assert detail.work_title == "실제 작품"
        assert [row["source_toc_position"] for row in detail.episodes] == [0, 1]


def test_work_linking_uses_normalized_title_and_nonempty_author(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        works = [
            ("blacktoon", "24753", "63670", "Ｒead Me", "Author"),
            ("marumaru", "31004", "63670", "Read Me", "Author"),
            ("marumaru", "31005", "63670", "Read Me", "Different Author"),
            ("marumaru", "31006", "", "Read Me", ""),
        ]
        with db:
            for site, work_id, slug, title, author in works:
                db.execute(
                    """INSERT INTO text_novel_sources(
                       site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        site,
                        work_id,
                        f"https://{site}452.com/novel/{work_id}",
                        slug,
                        title,
                        author,
                        importer._title_key(title),
                        importer._title_key(author),
                        "2026-09-23T00:00:00Z",
                    ),
                )
            for site, work_id, *_ in works:
                collector._refresh_link_candidates(db, site, work_id)
        rows = db.execute(
            "SELECT left_site,left_work_id,right_site,right_work_id,match_basis,status "
            "FROM text_novel_link_candidates"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            (
                "blacktoon",
                "24753",
                "marumaru",
                "31004",
                "normalized_title_author",
                "candidate",
            ),
        ]
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 0
    finally:
        db.close()


def test_paid_chapter_is_queued_again_after_it_becomes_free(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    try:
        with db:
            db.execute(
                """INSERT INTO text_novel_chapters(
                   site,source_work_id,source_chapter_id,access,status,last_seen_at)
                   VALUES('blacktoon','10','20','point','waiting','t0')"""
            )
            db.execute(
                """INSERT INTO text_collector_queue(
                   source,kind,entity_id,parent_work_id,status,updated_at)
                   VALUES('blacktoon','episode','20','10','done','t0')"""
            )
            db.execute(
                """UPDATE text_novel_chapters
                   SET access='free',status='discovered',last_seen_at='t1'"""
            )
            collector._fill_body_queue(db, "blacktoon")
        assert (
            db.execute("SELECT status FROM text_collector_queue WHERE entity_id='20'").fetchone()[0]
            == "pending"
        )
    finally:
        db.close()


def test_rejected_ready_batch_keeps_its_files_and_unblocks_the_next(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    old, new = "20260925T000000Z-pc-aaaaaaaa", "20260925T000001Z-pc-bbbbbbbb"
    for name in (old, new):
        folder = inbox / "drop" / name
        folder.mkdir(parents=True)
        (folder / "manifest.json").write_text("{}", encoding="utf-8")
        (folder / "ready.json").write_text("{}", encoding="utf-8")
    assert importer._next_ready_batch(inbox) == old
    importer._record_batch_rejection(inbox, old, "manifest_digest_mismatch")
    assert (inbox / "drop" / old / "manifest.json").read_text(encoding="utf-8") == "{}"
    assert importer._next_ready_batch(inbox) == new


def test_catalog_page_rejects_invalid_duplicate_and_shifted_pages(tmp_path: Path) -> None:
    with pytest.raises(collector.CollectorError, match="catalog_rows_rejected"):
        collector.parse_catalog_page(
            {
                "items": [{"id": "10", "title": "Good"}, {"id": "bad", "title": "Bad"}],
                "total": 2,
                "size": 96,
            }
        )
    with pytest.raises(collector.CollectorError, match="catalog_duplicate_id"):
        collector.parse_catalog_page(
            {
                "items": [{"id": 10, "title": "A"}, {"id": "10", "title": "B"}],
                "total": 2,
                "size": 96,
            }
        )
    db = importer._connect(tmp_path / "text.sqlite")
    db.executescript(collector._SCHEMA)
    source = collector.Source("blacktoon", "blacktoon452.com")
    try:
        with pytest.raises(collector.CollectorError, match="catalog_page_mismatch"):
            collector._apply_list(
                db,
                collector.RequestUnit(source, "list", "0", "https://blacktoon452.com/novel"),
                {"items": [{"id": 1, "title": "A"}], "total": 200, "size": 96, "page": 4},
            )
        collector._apply_list(
            db,
            collector.RequestUnit(source, "list", "0", "https://blacktoon452.com/novel"),
            {"items": [{"id": 1, "title": "A"}], "total": 200, "size": 96, "page": 0},
        )
        result = collector._apply_list(
            db,
            collector.RequestUnit(source, "list", "1", "https://blacktoon452.com/novel"),
            {"items": [{"id": 2, "title": "B"}], "total": 300, "size": 96, "page": 1},
        )
        state = db.execute(
            "SELECT next_page,total_count,last_error FROM text_collector_state"
        ).fetchone()
        assert result["consistency"] == "observed_partial"
        assert (state["next_page"], state["total_count"], state["last_error"]) == (
            2,
            300,
            "catalog_changed_during_scan",
        )
    finally:
        db.close()


def test_display_title_is_kept_when_an_episode_number_is_also_present() -> None:
    _work_id, _title, _author, episodes = collector.parse_work_detail(
        {
            "id": 9,
            "title": "작품",
            "episodes": [
                {
                    "id": 20,
                    "episodeNumber": 1,
                    "number": 1,
                    "title": "1화 - 개정판",
                }
            ],
        }
    )
    assert episodes[0]["label"] == "1화 - 개정판"
    assert episodes[0]["episode_number"] == 1


def test_pc_markdown_and_plain_body_are_the_same_novel_text(tmp_path: Path) -> None:
    prose = b"fixture novel chapter\n"
    inbox = tmp_path / "inbox"
    _incoming_novel_batch(inbox, _BATCH_ID)
    db_path = tmp_path / "state" / "text.sqlite"
    objects = tmp_path / "objects"
    receipts = inbox / "receipts"
    first = importer.import_batch(inbox, _BATCH_ID, db_path, objects, receipts)
    assert first is not None and first["items"][0]["status"] == "accepted"
    second_id = "20260925T000002Z-pc-00000002"
    wrapped = b"# 1\n# https://toki99.com/novel/63670/8794077\n\nfixture novel chapter\n"
    batch = inbox / "drop" / second_id
    files = batch / "files"
    files.mkdir(parents=True)
    item = {
        "identity": "novel_chapter:toki:63670:8794077",
        "kind": "novel_chapter",
        "site": "toki",
        "source_work_id": "63670",
        "source_chapter_id": "8794077",
        "source_url": "https://toki99.com/novel/63670/8794077",
        "work_title": "작품",
        "author": "작가",
        "chapter_label": "1화",
        "chapter_kind": "main",
        "access": "free",
        "bytes": len(wrapped),
        "sha256": hashlib.sha256(wrapped).hexdigest(),
        "text_sha256": hashlib.sha256(prose).hexdigest(),
        "relative_path": "files/000001.md",
    }
    (files / "000001.md").write_bytes(wrapped)
    manifest = {
        "schema": 1,
        "batch_id": second_id,
        "producer": "newtomi-pc",
        "items": [item],
    }
    raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    (batch / "manifest.json").write_bytes(raw)
    (batch / "ready.json").write_text(
        json.dumps(
            {"schema": 1, "batch_id": second_id, "manifest_sha256": hashlib.sha256(raw).hexdigest()}
        ),
        encoding="utf-8",
    )
    second = importer.import_batch(inbox, second_id, db_path, objects, receipts)
    assert second is not None
    assert second["items"][0]["status"] == "duplicate"
    assert second["items"][0]["content_sha256"] == hashlib.sha256(prose).hexdigest()
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM text_archive_conflicts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM text_archive_objects").fetchone()[0] == 1


def _novel_archive(tmp_path: Path) -> tuple[Path, Path, Path]:
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000009"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", inbox / "receipts")
    return db_path, tmp_path / "objects", inbox / "receipts"


def _fake_r2(remote: dict[str, bytes], *, fail_delete: bool = False) -> Any:
    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        operation = argv[3]
        if operation in {"copy", "delete"}:
            prefix = (
                argv[5 if operation == "copy" else 4]
                .partition("redstm-text-archive")[2]
                .lstrip("/")
            )
            names = Path(argv[argv.index("--files-from-raw") + 1]).read_text().split()
            if operation == "delete" and fail_delete:
                raise subprocess.CalledProcessError(1, argv)
            for name in names:
                key = f"{prefix}/{name}" if prefix else name
                if operation == "copy":
                    remote[key] = (Path(argv[4]) / name).read_bytes()
                else:
                    remote.pop(key, None)
        elif operation == "hashsum":
            prefix = argv[5].partition("redstm-text-archive")[2].lstrip("/")
            checksum = Path(argv[argv.index("--checkfile") + 1]).read_text()
            for line in checksum.splitlines():
                digest, name = line.split("  ", 1)
                key = f"{prefix}/{name}" if prefix else name
                if key not in remote or hashlib.sha256(remote[key]).hexdigest() != digest:
                    raise subprocess.CalledProcessError(1, argv)
        elif operation == "copyto":
            remote[argv[5].split("redstm-text-archive/", 1)[1]] = Path(argv[4]).read_bytes()
        elif operation == "cat":
            body = remote[argv[4].split("redstm-text-archive/", 1)[1]]
            return subprocess.CompletedProcess(argv, 0, body, b"")
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    return rclone


def _republish(
    db_path: Path, objects: Path, build: Path, receipts: Path, run: int, rclone: Any
) -> Any:
    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE text_archive_items SET imported_at=? WHERE lane='novel'",
            (f"2026-09-29T00:00:{run:02d}Z",),
        )
    return publisher.publish_lane(db_path, objects, build, receipts, "novel", runner=rclone)


@pytest.mark.parametrize("change", ["episode", "alias", "source", "label"])
def test_novel_metadata_changes_republish_without_a_new_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    db_path, objects, receipts = _novel_archive(tmp_path)
    build = tmp_path / "build"
    remote: dict[str, bytes] = {}
    rclone = _fake_r2(remote)
    publisher.publish_lane(db_path, objects, build, receipts, "novel", runner=rclone)
    assert (
        publisher.publish_lane(db_path, objects, build, receipts, "novel", runner=rclone)["status"]
        == "noop"
    )
    before = remote["published/novel/release.json"]
    with sqlite3.connect(db_path) as db:
        if change == "episode":
            db.execute(
                """UPDATE text_novel_chapters SET source_episode_number_raw='2',
                   source_episode_number_normalized=2,source_toc_position=1,
                   source_published_at='2026-10-03T00:00:00Z'"""
            )
        elif change == "alias":
            db.execute(
                """INSERT INTO text_novel_work_aliases
                   SELECT 'novel:toki:former',canonical_work_id,'now'
                FROM text_archive_items WHERE lane='novel' LIMIT 1"""
            )
        elif change == "source":
            db.execute(
                """INSERT INTO text_novel_work_group_sources
                   SELECT 'blacktoon','123',canonical_work_id
                   FROM text_archive_items WHERE lane='novel' LIMIT 1"""
            )
        else:
            db.execute("UPDATE text_novel_chapters SET chapter_label='수정된 1화'")
    result = publisher.publish_lane(db_path, objects, build, receipts, "novel", runner=rclone)
    assert result.get("status") != "noop"
    assert remote["published/novel/release.json"] != before
    payloads = [
        json.loads(body)
        for key, body in remote.items()
        if key.startswith("published/indexes/novel/")
    ]
    if change == "episode":
        assert any(
            entry["source_episode_number"] == 2
            and entry["source_published_at"] == "2026-10-03T00:00:00Z"
            for payload in payloads
            for entry in payload.get("chapters", [])
        )
    elif change in {"alias", "source"}:
        alias = "novel:toki:former" if change == "alias" else "novel:blacktoon:123"
        assert any(
            alias in entry.get("legacy_work_ids", [])
            for payload in payloads
            for entry in payload.get("items", [])
        )
    else:
        assert any(
            entry["label"] == "수정된 1화"
            for payload in payloads
            for entry in payload.get("chapters", [])
        )
    assert (
        publisher.publish_lane(db_path, objects, build, receipts, "novel", runner=rclone)["status"]
        == "noop"
    )


def test_catalog_build_rechecks_typemoon_headroom(tmp_path: Path) -> None:
    from scripts.text_archive.runtime import RuntimeWindowError

    db_path, objects, _receipts = _novel_archive(tmp_path)
    calls = 0

    def headroom() -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeWindowError("typemoon_memory_reserved")

    with pytest.raises(RuntimeWindowError, match="typemoon_memory_reserved"):
        publisher.build_publish_tree(
            db_path, objects, tmp_path / "build", "novel", headroom=headroom
        )
    assert calls == 2


def test_availability_window_deferral_keeps_the_published_lane(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from scripts.text_archive.runtime import RuntimeWindowError

    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000002"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    remote: dict[str, bytes] = {}

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] in {"copy", "hashsum"}:
            return _fake_r2(remote)(argv)
        if argv[3] == "copyto":
            key = argv[5].split("redstm-text-archive/", 1)[1]
            remote[key] = Path(argv[4]).read_bytes()
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        key = argv[4].split("redstm-text-archive/", 1)[1]
        return subprocess.CompletedProcess(argv, 0, remote[key], b"")

    def deferred(*_args: object, **_kwargs: object) -> dict[str, Any]:
        raise RuntimeWindowError("typemoon_memory_reserved")

    monkeypatch.setattr(publisher, "build_availability_snapshot", deferred)
    result = publisher.publish_lane(
        db_path, tmp_path / "objects", tmp_path / "build", receipts, "novel", runner=rclone
    )
    again = publisher.publish_lane(
        db_path, tmp_path / "objects", tmp_path / "build", receipts, "novel", runner=rclone
    )

    assert result["release_sha256"]
    assert result["availability"] == {
        "status": "deferred",
        "error": "RuntimeWindowError: typemoon_memory_reserved",
    }
    assert "published/novel/release.json" in remote
    assert again["status"] == "noop"
    assert again["availability"]["status"] == "deferred"


def test_rebuild_keeps_unchanged_files_and_reads_only_unpublished_objects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path, objects, _ = _novel_archive(tmp_path)
    build = tmp_path / "build"
    first = publisher.build_publish_tree(db_path, objects, build, "novel")
    written: list[Path] = []
    original_write = publisher._write

    def record_write(path: Path, body: bytes) -> None:
        written.append(path)
        original_write(path, body)

    monkeypatch.setattr(publisher, "_write", record_write)
    second = publisher.build_publish_tree(db_path, objects, build, "novel")
    assert second["release_key"] == first["release_key"]
    assert written == [build / "published/novel/release.json"]
    assert not (build / "published/objects").exists()

    target_key, digest, source_key, _ = next(publisher._plan_rows(second["object_plan"]))
    (objects / source_key).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="failed verification"):
        publisher.build_publish_tree(db_path, objects, build, "novel")
    publisher._record_publication(db_path, target_key, digest)
    (objects / source_key).unlink()
    publisher.build_publish_tree(db_path, objects, build, "novel")


def test_retention_keeps_recent_releases_and_their_references(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(publisher, "_RELEASE_RETENTION", 2)
    monkeypatch.setattr(publisher, "_RELEASE_KEEP_SECONDS", 0)
    db_path, objects, receipts = _novel_archive(tmp_path)
    build = tmp_path / "build"
    remote: dict[str, bytes] = {}
    rclone = _fake_r2(remote)
    results = [_republish(db_path, objects, build, receipts, run, rclone) for run in range(5)]
    releases = [f"published/releases/novel/{result['release_sha256']}.json" for result in results]
    assert len(set(releases)) == 5
    assert results[-1]["prune"]["status"] == "pruned"

    def keys(prefix: str) -> set[str]:
        return {key for key in remote if key.startswith(prefix)}

    assert keys("published/releases/") == set(releases[-2:])
    local = {path.relative_to(build).as_posix() for path in (build / "published").rglob("*.json")}
    assert local == {
        *keys("published/releases/"),
        *keys("published/indexes/"),
        "published/novel/release.json",
    }
    kept_pages = {
        page["key"] for key in releases[-2:] for page in json.loads(remote[key])["catalog_pages"]
    }
    detail_keys = {
        item["detail_key"] for key in kept_pages for item in json.loads(remote[key])["items"]
    }
    # The unchanged work detail dates from the first run and survives because kept pages use it.
    assert len(detail_keys) == 1
    assert keys("published/indexes/") == kept_pages | detail_keys
    assert len(keys("published/objects/")) == 1
    pointer = json.loads(remote["published/novel/release.json"])
    assert pointer["release_key"] == releases[-1]
    with sqlite3.connect(db_path) as db:
        ledger = {
            row[0]
            for row in db.execute(
                "SELECT key FROM text_archive_publications WHERE key LIKE 'published/%/novel/%'"
            )
        }
    assert ledger == keys("published/releases/") | keys("published/indexes/")


def test_retention_keeps_a_day_of_releases_for_tabs_holding_an_old_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Publishing reruns a minute after each run. Count-only retention dropped the first
    release's indexes within minutes, so a tab that loaded that catalog hit a 404."""
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(publisher, "_RELEASE_RETENTION", 1)
    db_path, objects, receipts = _novel_archive(tmp_path)
    build = tmp_path / "build"
    remote: dict[str, bytes] = {}
    rclone = _fake_r2(remote)
    results = [_republish(db_path, objects, build, receipts, run, rclone) for run in range(4)]
    releases = [f"published/releases/novel/{result['release_sha256']}.json" for result in results]
    assert {key for key in remote if key.startswith("published/releases/")} == set(releases)
    first_pages = [page["key"] for page in json.loads(remote[releases[0]])["catalog_pages"]]
    assert all(key in remote for key in first_pages)

    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE text_archive_publications SET verified_at='2000-01-01T00:00:00Z' WHERE key=?",
            (releases[0],),
        )
    later = _republish(db_path, objects, build, receipts, 4, rclone)
    assert releases[0] not in remote
    assert releases[1] in remote
    assert later["prune"]["status"] == "pruned"


def test_failed_prune_keeps_the_publish_and_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(publisher, "_RELEASE_RETENTION", 1)
    monkeypatch.setattr(publisher, "_RELEASE_KEEP_SECONDS", 0)
    db_path, objects, receipts = _novel_archive(tmp_path)
    build = tmp_path / "build"
    remote: dict[str, bytes] = {}
    _republish(db_path, objects, build, receipts, 0, _fake_r2(remote))
    failed = _republish(db_path, objects, build, receipts, 1, _fake_r2(remote, fail_delete=True))
    assert failed["prune"]["status"] == "failed"
    new_release = f"published/releases/novel/{failed['release_sha256']}.json"
    assert json.loads(remote["published/novel/release.json"])["release_key"] == new_release
    assert len([key for key in remote if key.startswith("published/releases/")]) == 2
    with sqlite3.connect(db_path) as db:
        pruning = db.execute(
            "SELECT COUNT(*) FROM text_archive_publications WHERE sha256='pruning'"
        ).fetchone()[0]
    assert pruning == 2  # the old release and its catalog page stay queued for the next run

    retried = _republish(db_path, objects, build, receipts, 2, _fake_r2(remote))
    assert retried["prune"]["remote_removed"] == 4
    assert [key for key in remote if key.startswith("published/releases/")] == [
        f"published/releases/novel/{retried['release_sha256']}.json"
    ]


def test_collector_process_runs_paced_steps_until_a_cooldown(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    results = iter([{"status": "stored"}, {"status": "held"}, {"status": "cooldown"}, {}])
    monkeypatch.setattr(collector, "run_one", lambda *_a, **_k: next(results))
    monkeypatch.setattr(collector, "configured_sources", lambda **_: ())
    monkeypatch.setattr(collector, "configured_body_source", lambda: None)
    monkeypatch.setattr("sys.argv", ["collector", "--seconds", "600"])

    collector.main()

    report = json.loads(capsys.readouterr().out)
    assert report == {"steps": {"cooldown": 1, "held": 1, "stored": 1}, "stop_reason": "cooldown"}

    def deferred(*_a: object, **_k: object) -> dict[str, object]:
        raise collector.RuntimeWindowError("typemoon_memory_reserved")

    monkeypatch.setattr(collector, "run_one", deferred)
    with pytest.raises(SystemExit) as stopped:
        collector.main()
    assert stopped.value.code == 75


def test_old_availability_snapshots_and_receipts_are_pruned(tmp_path: Path) -> None:
    import os

    receipts = tmp_path / "receipts"
    snapshots = receipts / "availability" / "novel" / "snapshots"
    now = 1_900_000_000.0
    for index, name in enumerate(["a", "b", "c", "d", "e"]):
        path = snapshots / name
        path.mkdir(parents=True)
        (path / "manifest.json").write_text("{}")
        age = (10 - index) * 86400
        os.utime(path, (now - age, now - age))
    # "a" is the oldest but current; b is old; c-e are the three newest.
    assert publisher.prune_availability_snapshots(receipts, keep_id="a", now=now) == 1
    assert sorted(path.name for path in snapshots.iterdir()) == ["a", "c", "d", "e"]

    drop = tmp_path / "drop"
    (drop / "20260101T000000Z-pc-aaaaaaaa").mkdir(parents=True)
    old_gone = receipts / "20250101T000000Z-pc-bbbbbbbb.json"
    old_pending = receipts / "20260101T000000Z-pc-aaaaaaaa.json"
    recent = receipts / "20260901T000000Z-pc-cccccccc.status.json"
    for path, age in ((old_gone, 90), (old_pending, 90), (recent, 5)):
        path.write_text("{}")
        os.utime(path, (now - age * 86400, now - age * 86400))
    assert publisher.prune_receipts(receipts, drop, now=now) == 1
    assert not old_gone.exists() and old_pending.exists() and recent.exists()


def test_drop_state_counts_only_rejected_status_sidecars(tmp_path: Path) -> None:
    from scripts.text_archive import status as text_status

    receipts = tmp_path / "receipts"
    receipts.mkdir()
    for batch, batch_status in (
        ("20261001T000000Z-pc-aaaaaaaa", "rejected"),
        ("20261001T000000Z-pc-bbbbbbbb", "receipt_repair"),
    ):
        (tmp_path / "drop" / batch).mkdir(parents=True)
        (tmp_path / "drop" / batch / "ready.json").write_text("{}")
        (receipts / f"{batch}.status.json").write_text(
            json.dumps({"schema": 1, "batch_status": batch_status})
        )
        if batch_status == "receipt_repair":
            (receipts / f"{batch}.json").write_text("{}")
    state = text_status._drop_state(tmp_path)
    assert state["text_rejected_in_drop"] == 1
    assert state["text_waiting"] == 0


@pytest.mark.parametrize("failed_lane", ["novel", "arcalive", "manual", "tuna"])
@pytest.mark.parametrize("deferred", [False, True])
def test_publisher_attempts_every_lane_after_a_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failed_lane: str,
    deferred: bool,
) -> None:
    attempted: list[str] = []
    reported: list[str] = []

    def publish(*args: Any) -> dict[str, Any]:
        lane = str(args[4])
        attempted.append(lane)
        if lane == failed_lane:
            if deferred:
                raise publisher.RuntimeWindowError("lane_busy")
            raise OSError("remote unavailable")
        return {"lane": lane, "status": "published"}

    monkeypatch.setattr(sys, "argv", ["publisher", "both"])
    monkeypatch.setattr(publisher, "publish_lane", publish)
    monkeypatch.setattr(
        publisher, "write_pc_state", lambda *a, **kw: reported.append(kw["outcome"])
    )
    monkeypatch.setattr(publisher, "publish_status", lambda *a: {})
    monkeypatch.setattr(publisher, "prune_receipts", lambda *a: 0)
    with pytest.raises(SystemExit) as stopped:
        publisher.main()
    assert stopped.value.code == (75 if deferred else 1)
    assert attempted == ["manual", "novel", "arcalive", "tuna"]
    assert reported == ["deferred" if deferred else "failed"]
    results = json.loads(capsys.readouterr().out)
    assert len([r for r in results if r.get("status") == "published"]) == 3


def test_many_small_bodies_are_verified_in_one_copy_and_hashsum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Groups of 8 cost two rclone starts each and verified ~900 bodies an hour."""
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    db_path, objects, receipts = _novel_archive(tmp_path)
    with sqlite3.connect(db_path) as db:
        for index in range(40):
            identity = "manual:" + f"{index:064x}"
            body = f"small document {index}".encode()
            digest = hashlib.sha256(body).hexdigest()
            key = f"objects/sha256/{digest[:2]}/{digest}.md"
            (objects / key).parent.mkdir(parents=True, exist_ok=True)
            (objects / key).write_bytes(body)
            db.execute(
                "INSERT INTO text_archive_items(identity,lane,source_site,source_url,title,"
                "content_sha256,bytes,object_key,batch_id,imported_at) "
                "VALUES(?,'manual','manual','',?,?,?,?, 'fixture','now')",
                (identity, identity, digest, len(body), key),
            )
            db.execute(
                "INSERT INTO text_manual_documents VALUES(?,'2026-10-01T00:00:00Z','fixture')",
                (identity,),
            )
    remote: dict[str, bytes] = {}
    normal = _fake_r2(remote)
    calls: list[str] = []

    def counting(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] in {"copy", "hashsum"} and "objects/sha256" in " ".join(argv):
            calls.append(argv[3])
        return normal(argv, **kwargs)

    result = publisher.publish_lane(
        db_path, objects, tmp_path / "build", receipts, "manual", runner=counting
    )
    assert result["item_count"] == 40 and result["pending_count"] == 0
    assert calls == ["copy", "hashsum"]


def test_partial_manual_publish_keeps_verified_progress_and_skips_failed_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(publisher, "_BODY_BATCH_OBJECTS", 8)
    db_path, objects, receipts = _novel_archive(tmp_path)
    build = tmp_path / "build"
    remote: dict[str, bytes] = {}
    identities: list[str] = []
    with sqlite3.connect(db_path) as db:
        for index in range(10):
            identity = "manual:" + f"{index:064x}"
            identities.append(identity)
            body = f"manual document {index}".encode()
            digest = hashlib.sha256(body).hexdigest()
            key = f"objects/sha256/{digest[:2]}/{digest}.md"
            target = objects / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            db.execute(
                "INSERT INTO text_archive_items(identity,lane,source_site,source_url,title,"
                "content_sha256,bytes,object_key,batch_id,imported_at) "
                "VALUES(?,'manual','manual','',?,?,?,?, 'fixture','now')",
                (identity, identity, digest, len(body), key),
            )
            db.execute(
                "INSERT INTO text_manual_documents VALUES(?,'2026-10-01T00:00:00Z','fixture')",
                (identity,),
            )
        # One body was verified by a previous interrupted run, without a visible catalog.
        key, digest = db.execute(
            "SELECT object_key,content_sha256 FROM text_archive_items WHERE identity=?",
            (identities[0],),
        ).fetchone()
    remote["published/" + key] = (objects / key).read_bytes()
    publisher._record_publication(db_path, "published/" + key, digest)
    normal = _fake_r2(remote)
    failed_keys: list[str] = []
    late = "manual:" + "f" * 64

    def fail_group(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] == "copy" and "objects/sha256" in argv[5]:
            if not failed_keys:
                # An import during the uploads reuses the already verified body. The release
                # then holds two items; the pending count must come from that same snapshot.
                with sqlite3.connect(db_path) as late_db:
                    late_db.execute(
                        "INSERT INTO text_archive_items(identity,lane,source_site,source_url,"
                        "title,content_sha256,bytes,object_key,batch_id,imported_at) "
                        "SELECT ?,lane,source_site,source_url,?,content_sha256,bytes,object_key,"
                        "batch_id,imported_at FROM text_archive_items WHERE identity=?",
                        (late, late, identities[0]),
                    )
                    late_db.execute(
                        "INSERT INTO text_manual_documents VALUES(?,'2026-10-01T00:00:00Z',"
                        "'fixture')",
                        (late,),
                    )
            failed_keys.extend(
                Path(argv[argv.index("--files-from-raw") + 1]).read_text().splitlines()
            )
            raise subprocess.TimeoutExpired(argv, 300)
        return normal(argv, **kwargs)

    first = publisher.publish_lane(db_path, objects, build, receipts, "manual", runner=fail_group)
    assert first["item_count"] == 2 and first["pending_count"] == 9
    assert first["transfer_error"] == "TimeoutExpired"
    pointer = json.loads(remote["published/manual/release.json"])
    release = json.loads(remote[pointer["release_key"]])
    assert release["item_count"] == 2
    with sqlite3.connect(db_path) as db:
        assert (
            db.execute(
                "SELECT count(*) FROM text_archive_publications WHERE key LIKE 'item:manual:%'"
            ).fetchone()[0]
            == 2
        )
    assert len(failed_keys) == 8
    copied: list[str] = []

    def retry(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if argv[3] == "copyto" and "objects/sha256" in argv[5]:
            copied.append(argv[5].split("published/objects/sha256/", 1)[1])
        return normal(argv, **kwargs)

    final = publisher.publish_lane(db_path, objects, build, receipts, "manual", runner=retry)
    assert final["item_count"] == 11 and final["pending_count"] == 0
    assert copied[0] not in failed_keys  # An unattempted file passes the failed group first.
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT count(*) FROM text_archive_publish_attempts").fetchone()[0] == 0


def test_shared_disk_reserve_allows_thirty_gib_free() -> None:
    from scripts.storage_policy import disk_low_bytes, disk_stop_bytes, text_disk_floor_bytes

    total = 194 * 1024**3
    assert disk_stop_bytes(total) == text_disk_floor_bytes(total) < 4 * 1024**3 + 1
    assert disk_low_bytes(total) < 5 * 1024**3 + 1 < 30 * 1024**3


def test_oracle_rotates_when_the_domain_is_withheld_with_451(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(
        FakeResponse(b"<html>legal</html>", status=451),
        FakeResponse(b"<html>legal</html>", status=451),
        FakeResponse({"content": [{"id": 24753, "title": "Novel"}], "total": 1, "size": 96}),
    )
    sources = collector.configured_sources({})
    first = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert (first["status"], first["reason"]) == ("held", "http_451")
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE text_collector_state SET next_check_at=0 WHERE source='blacktoon:list'")
        db.execute(
            "INSERT INTO text_collector_state(source,next_check_at,updated_at) "
            "VALUES('marumaru:list',9999999999,'test')"
        )
    second = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert second["status"] == "listed"
    assert "blacktoon455.com" in session.calls[-1]


def test_one_episodes_500_is_not_counted_as_a_host_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    counted: list[str] = []
    monkeypatch.setattr(collector, "_get", lambda *_args: (500, b"{}", {}))
    monkeypatch.setattr(collector, "_host_failure", lambda _db, unit: counted.append(unit.kind))
    source = collector.Source("blacktoon", "blacktoon454.com")
    for kind in ("episode", "work", "list"):
        unit = collector.RequestUnit(source, kind, "1", "https://blacktoon454.com/api/x/1")
        assert collector._fetch_with_rotation(MagicMock(), unit, tmp_path / "db")[1] == 500
    assert counted == ["work", "list"]


def test_episode_naming_another_work_is_held_for_review(tmp_path: Path) -> None:
    assert collector._episode_work_id({"id": 7, "bodyJson": "[]"}) == ""
    wrapped = {"data": {"episode": {"id": 7, "work": {"id": 48862}}}}
    assert collector._episode_work_id(wrapped) == "48862"
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        db.executescript(collector._SCHEMA)
        db.execute(
            "INSERT INTO text_collector_queue(source,kind,entity_id,parent_work_id,updated_at) "
            "VALUES('blacktoon','episode','2443225','24961','test')"
        )
        unit = collector.RequestUnit(
            collector.Source("blacktoon", "blacktoon454.com"),
            "episode",
            "2443225",
            "https://blacktoon454.com/api/episodes/2443225",
        )
        value = {
            "id": 2443225,
            "title": "5화",
            "bodyJson": [{"kind": "narration", "text": "another work's chapter"}],
            "work": {"id": 48862, "title": "다른 작품"},
        }
        with pytest.raises(collector.CollectorError, match="episode_work_id_invalid"):
            collector._apply_episode(db, tmp_path / "objects", unit, value, "blacktoon454.com")
    finally:
        db.close()
