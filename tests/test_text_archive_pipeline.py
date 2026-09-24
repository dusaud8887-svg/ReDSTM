from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from collections.abc import Iterator
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from typing import Any

import pytest

from scripts.text_archive import collector, importer, publisher

_BATCH_ID = "20260923T130000Z-pc-00000001"


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
    monkeypatch.setattr(publisher, "operation_window", nullcontext)
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
        db.execute(
            "UPDATE text_archive_items SET title='소설',source_category='' WHERE lane='arcalive'"
        )

    remote: dict[str, bytes] = {}
    calls: list[tuple[str, str]] = []

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
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
        assert db.execute("SELECT title,source_category FROM text_archive_items").fetchone() == (
            "fixture article title",
            "소설",
        )
    catalog_file = next((tmp_path / "build" / "published" / "indexes" / "arcalive").glob("*.json"))
    published_item = json.loads(catalog_file.read_text(encoding="utf-8"))["items"][0]
    assert published_item["title"] == "fixture article title"
    assert published_item["category"] == "소설"
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


def test_publisher_readback_failure_never_switches_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", nullcontext)
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


def test_novel_publisher_writes_a_paged_receipt_snapshot_after_r2_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", nullcontext)
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000002"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "state" / "text.sqlite"
    receipts = inbox / "receipts"
    importer.import_batch(inbox, batch_id, db_path, tmp_path / "objects", receipts)
    remote: dict[str, bytes] = {}
    calls: list[tuple[str, str]] = []

    def rclone(argv: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
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
        db.executemany(
            "INSERT INTO text_novel_work_group_sources VALUES(?,?, 'linked')",
            [("toki", "63670"), ("blacktoon", "24753")],
        )
        db.execute("UPDATE text_archive_items SET canonical_work_id='linked' WHERE lane='novel'")
    publisher.build_availability_snapshot(db_path, receipts)
    current = json.loads(
        (receipts / "availability" / "novel" / "current.json").read_text(encoding="utf-8")
    )
    manifest = json.loads((inbox / current["manifest_key"]).read_text(encoding="utf-8"))
    page = json.loads((inbox / manifest["pages"][0]["key"]).read_text(encoding="utf-8"))
    assert page["items"][0]["linked_sources"] == ["blacktoon:24753", "toki:63670"]


def test_publisher_does_not_claim_an_item_imported_after_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(publisher, "operation_window", nullcontext)
    inbox = tmp_path / "inbox"
    batch_id = "20260923T140000Z-pc-00000003"
    _incoming_novel_batch(inbox, batch_id)
    db_path = tmp_path / "text.sqlite"
    objects = tmp_path / "objects"
    importer.import_batch(inbox, batch_id, db_path, objects, inbox / "receipts")
    original_build = publisher.build_publish_tree

    def build_then_import(
        db_path_arg: Path, object_root: Path, output_root: Path, lane: str
    ) -> dict[str, Any]:
        tree = original_build(db_path_arg, object_root, output_root, lane)
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
        key = argv[-1].split("redstm-text-archive/", 1)[1]
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
    monkeypatch.setattr(collector, "operation_window", nullcontext)
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
                    {"id": 914174, "title": "1화", "isFree": True},
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
    assert ["blacktoon452.com" in session.calls[index] for index in range(3)] == [True, False, True]
    with sqlite3.connect(db_path) as db:
        rows = db.execute(
            "SELECT source_chapter_id,access,status FROM text_novel_chapters "
            "ORDER BY source_chapter_id"
        ).fetchall()
        assert rows == [("914174", "free", "complete"), ("914175", "point", "waiting")]
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 1
    body_path = objects / "objects" / "sha256" / chapter["sha256"][:2] / f"{chapter['sha256']}.md"
    assert body_path.read_text(encoding="utf-8") == "sample chapter\n"


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


def test_oracle_collector_probes_unknown_access_without_publishing_paid_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", nullcontext)
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
    monkeypatch.setattr(collector, "operation_window", nullcontext)
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
        canary_verified=True,
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


def test_linked_chapter_coverage_skips_only_unique_label_and_kind(tmp_path: Path) -> None:
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
            assert importer.mark_cross_source_covered(db, "blacktoon", "24753") == 1
        rows = db.execute(
            "SELECT entity_id,status FROM text_collector_queue ORDER BY entity_id"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("2", "covered"),
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


def test_shared_origin_cooldown_blocks_sibling_domain_and_unknown_blocks_need_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", nullcontext)
    monkeypatch.setattr(collector, "_REQUEST_GAP", 0)
    db_path = tmp_path / "text.sqlite"
    session: Any = FakeSession(FakeResponse({}, status=429, headers={"Retry-After": "3600"}))
    first = collector.run_one(
        db_path, tmp_path / "objects", collector.configured_sources({}), session=session
    )
    second = collector.run_one(
        db_path, tmp_path / "objects", collector.configured_sources({}), session=session
    )
    assert collector.configured_body_source({}) is None
    assert first["status"] == "cooldown"
    assert second == {"status": "deferred", "reason": "source_group_cooldown"}
    assert len(session.calls) == 1
    with pytest.raises(collector.CollectorError, match="requires_review"):
        collector._plain_text([{"type": "image", "src": "not-followed"}])


def test_oracle_rotates_only_after_repeated_failure_and_valid_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", nullcontext)
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
        db.execute(
            "UPDATE text_collector_state SET next_check_at=0 WHERE source='blacktoon:list'"
        )
        db.execute(
            "INSERT INTO text_collector_state(source,next_check_at,updated_at) "
            "VALUES('marumaru:list',9999999999,'test')"
        )
    second = collector.run_one(db_path, tmp_path / "objects", sources, session=session)
    assert second["status"] == "listed"
    assert ["blacktoon452.com" in url for url in session.calls] == [True, True, False]
    assert "blacktoon453.com" in session.calls[-1]
    assert collector.configured_sources({}, db_path)[0].host == "blacktoon453.com"
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT source_url FROM text_novel_sources WHERE site='blacktoon'"
        ).fetchone()[0] == "https://blacktoon453.com/novel/24753"


def test_oracle_does_not_promote_challenged_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(collector, "operation_window", nullcontext)
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
    assert collector.configured_sources({}, db_path)[0].host == "blacktoon452.com"
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT blocked FROM text_collector_hosts WHERE source='blacktoon'"
        ).fetchone()[0] == 1


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
    assert episodes == [{"id": "31027", "label": "1", "kind": "main", "access": "unknown"}]
    assert (
        collector._plain_text('[{"kind":"narration","text":"sample chapter"}]') == "sample chapter"
    )
    with pytest.raises(collector.CollectorError, match="requires_review"):
        collector._plain_text('[{"kind":"paid","text":"locked"}]')


def test_work_linking_needs_same_slug_title_and_nonempty_author(tmp_path: Path) -> None:
    db = importer._connect(tmp_path / "text.sqlite")
    try:
        works = [
            ("blacktoon", "24753", "63670", "Ｒead Me", "Author"),
            ("marumaru", "31004", "63670", "Read Me", "Author"),
            ("marumaru", "31005", "63670", "Read Me", "Different Author"),
            ("marumaru", "31006", "", "Read Me", "Author"),
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
                        collector._text_key(title),
                        collector._text_key(author),
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
            ("blacktoon", "24753", "marumaru", "31004", "slug_title_author", "candidate")
        ]
        assert db.execute("SELECT COUNT(*) FROM text_archive_items").fetchone()[0] == 0
    finally:
        db.close()
