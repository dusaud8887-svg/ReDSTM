from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from scripts.text_archive import importer, runtime, status

_ROOT = Path(__file__).parent
_FIXTURE = _ROOT / "fixtures" / "text_archive_contract.json"
_BATCHES = (
    "20260923T120000Z-pc-00000001",
    "20260923T120001Z-pc-00000002",
    "20260923T120002Z-pc-00000003",
    "20260923T120003Z-pc-00000004",
)


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
        runtime.shutil, "disk_usage", lambda _path: SimpleNamespace(free=41 * 1024**3)
    )

    def inactive(_command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(_command, 3)

    with runtime.operation_window(
        publish_lock=publish_lock,
        meminfo_path=meminfo,
        status_path=status,
        root_path=tmp_path,
        run=inactive,
    ):
        assert publish_lock.exists()

    def active(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 0)

    with pytest.raises(runtime.RuntimeWindowError, match="schedule_active"):
        with runtime.operation_window(
            publish_lock=publish_lock,
            meminfo_path=meminfo,
            status_path=status,
            root_path=tmp_path,
            run=active,
        ):
            pytest.fail("active TypeMoon schedule must block the text operation")


@pytest.mark.parametrize(
    ("meminfo_text", "disk_free", "reason"),
    [
        (
            "MemAvailable: 250000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3900000 kB\n",
            41 * 1024**3,
            "memory_below_floor",
        ),
        (
            "MemAvailable: 400000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3900000 kB\n",
            40 * 1024**3 - 1,
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
    monkeypatch.setattr(runtime.shutil, "disk_usage", lambda _path: SimpleNamespace(free=disk_free))

    def inactive(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 3)

    with pytest.raises(runtime.RuntimeWindowError, match=reason):
        with runtime.operation_window(
            publish_lock=publish_lock,
            meminfo_path=meminfo,
            status_path=status,
            root_path=tmp_path,
            run=inactive,
        ):
            pytest.fail("resource limits must defer the text operation")


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
    monkeypatch.setattr(runtime.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))

    def inactive(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 3)

    with runtime.FileLock(str(control_lock)):
        with runtime.operation_window(
            publish_lock=publish_lock,
            meminfo_path=meminfo,
            status_path=status,
            root_path=tmp_path,
            run=inactive,
        ):
            pass
    with runtime.FileLock(str(publish_lock)):
        with pytest.raises(runtime.RuntimeWindowError, match="typemoon_publish_busy"):
            with runtime.operation_window(
                publish_lock=publish_lock,
                meminfo_path=meminfo,
                status_path=status,
                root_path=tmp_path,
                run=inactive,
            ):
                pytest.fail("a held TypeMoon publish lock must defer the text operation")


def test_main_drains_every_ready_batch_in_one_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    inbox = tmp_path / "inbox"
    _batch(inbox, _BATCHES[0])
    _batch(inbox, _BATCHES[1], body=b"second body")
    _batch(inbox, _BATCHES[2], ready=False)
    monkeypatch.setattr(importer, "_INBOX_ROOT", inbox)
    monkeypatch.setattr(importer, "_DB_PATH", tmp_path / "text.sqlite")
    monkeypatch.setattr(importer, "_OBJECT_ROOT", tmp_path / "objects")
    monkeypatch.setattr(importer, "operation_window", lambda **_: nullcontext())
    monkeypatch.setattr(sys, "argv", ["importer"])
    importer.main()
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["batch_id"] for line in lines] == list(_BATCHES[:2])
    assert (inbox / "receipts" / f"{_BATCHES[1]}.json").is_file()
    assert not (inbox / "receipts" / f"{_BATCHES[2]}.json").exists()


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
    document = status.build_status(db_path, inbox, now=1_800_000_000)
    assert document["generated_at"] == "2027-01-15T08:00:00Z"
    assert document["lanes"]["arcalive"]["items"] == 1
    assert document["lanes"]["arcalive"]["published"] == 0
    assert document["pc"]["batches"] == 1
    assert document["drop"]["text_waiting"] == 1
    group = document["collector"]["groups"][0]
    assert group["cooldown_until"] == "2033-05-18T03:33:20Z"
    assert group["last_status"] == 429 and len(group["last_error"]) == 160
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
