from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_MAX_ITEMS = 20
_MAX_FILE_BYTES = 2 * 1024 * 1024
_MAX_MANIFEST_BYTES = 256 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_BATCH_ID = re.compile(r"\d{8}T\d{6}Z-pc-[a-f0-9]{8}\Z")
_BOARD = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
_SITE_HOSTS = {
    "toki": re.compile(r"(?:toki\d*\.com|manatoki\d*\.(?:com|net))\Z", re.I),
    "newtoki": re.compile(r"newtoki\d*\.(?:org|com|net)\Z", re.I),
    "sbxh": re.compile(r"sbxh\d*\.com\Z", re.I),
    "blacktoon": re.compile(r"blacktoon\d*\.com\Z", re.I),
    "marumaru": re.compile(r"marumaru\d*\.com\Z", re.I),
}
_ITEM_FIELDS = {
    "identity",
    "kind",
    "site",
    "source_work_id",
    "source_chapter_id",
    "source_url",
    "work_title",
    "author",
    "chapter_label",
    "chapter_kind",
    "access",
    "bytes",
    "sha256",
    "observed_at",
    "board",
    "post_id",
    "category",
    "title",
    "content_lane",
    "completed_at",
    "relative_path",
}
_SCHEMA = """
CREATE TABLE IF NOT EXISTS text_archive_items (
  identity TEXT PRIMARY KEY, lane TEXT NOT NULL, source_site TEXT NOT NULL,
  source_work_id TEXT, source_chapter_id TEXT, source_board TEXT, source_post_id TEXT,
  source_category TEXT NOT NULL DEFAULT '',
  content_lane TEXT, source_url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '', chapter_label TEXT NOT NULL DEFAULT '',
  chapter_kind TEXT NOT NULL DEFAULT '', access TEXT NOT NULL DEFAULT 'unknown',
  content_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, object_key TEXT NOT NULL,
  canonical_work_id TEXT, canonical_chapter_id TEXT, batch_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_archive_objects (
  sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_archive_batches (
  batch_id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_archive_conflicts (
  batch_id TEXT NOT NULL, identity TEXT NOT NULL, existing_sha256 TEXT NOT NULL,
  incoming_sha256 TEXT NOT NULL, reason TEXT NOT NULL, detected_at TEXT NOT NULL,
  PRIMARY KEY(batch_id, identity)
);
CREATE TABLE IF NOT EXISTS text_archive_publications (
  key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_novel_sources (
  site TEXT NOT NULL, source_work_id TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  title_key TEXT NOT NULL DEFAULT '', author_key TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL, PRIMARY KEY(site, source_work_id)
);
CREATE TABLE IF NOT EXISTS text_novel_chapters (
  site TEXT NOT NULL, source_work_id TEXT NOT NULL, source_chapter_id TEXT NOT NULL,
  chapter_label TEXT NOT NULL DEFAULT '', chapter_kind TEXT NOT NULL DEFAULT 'main',
  access TEXT NOT NULL DEFAULT 'unknown', content_sha256 TEXT, status TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(site, source_work_id, source_chapter_id)
);
CREATE TABLE IF NOT EXISTS text_novel_link_candidates (
  left_site TEXT NOT NULL, left_work_id TEXT NOT NULL,
  right_site TEXT NOT NULL, right_work_id TEXT NOT NULL,
  match_basis TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(left_site,left_work_id,right_site,right_work_id)
);
CREATE TABLE IF NOT EXISTS text_novel_work_groups (
  canonical_work_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_novel_work_group_sources (
  site TEXT NOT NULL, source_work_id TEXT NOT NULL,
  canonical_work_id TEXT NOT NULL REFERENCES text_novel_work_groups(canonical_work_id),
  PRIMARY KEY(site,source_work_id)
);
CREATE TABLE IF NOT EXISTS text_collector_state (
  source TEXT PRIMARY KEY, next_page INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0, page_size INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS text_collector_groups (
  group_id TEXT PRIMARY KEY, last_request_at INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0, last_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '', last_source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_text_items_lane ON text_archive_items(lane, imported_at);
CREATE INDEX IF NOT EXISTS idx_text_novel_sources_match
  ON text_novel_sources(title_key, author_key);
"""


class BatchNotReadyError(RuntimeError):
    pass


class BatchRejectedError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _text_key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def mark_cross_source_covered(db: sqlite3.Connection, site: str, work_id: str) -> int:
    """Skip only unique, same-labelled chapters of an explicitly linked work."""
    group = db.execute(
        "SELECT canonical_work_id FROM text_novel_work_group_sources "
        "WHERE site=? AND source_work_id=?",
        (site, work_id),
    ).fetchone()
    if group is None:
        return 0
    others = db.execute(
        """SELECT i.chapter_label,i.chapter_kind FROM text_archive_items i
           JOIN text_novel_work_group_sources g
             ON g.site=i.source_site AND g.source_work_id=i.source_work_id
           WHERE g.canonical_work_id=? AND i.source_site!=? AND i.lane='novel'""",
        (group[0], site),
    ).fetchall()
    available: dict[tuple[str, str], int] = {}
    for row in others:
        key = (_text_key(row["chapter_label"]), row["chapter_kind"])
        if key[0]:
            available[key] = available.get(key, 0) + 1
    db.execute(
        """UPDATE text_novel_chapters SET status='discovered'
           WHERE site=? AND source_work_id=? AND status='covered'""",
        (site, work_id),
    )
    has_queue = bool(
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_collector_queue'"
        ).fetchone()
    )
    if has_queue:
        db.execute(
            """UPDATE text_collector_queue SET status='pending'
               WHERE source=? AND kind='episode' AND parent_work_id=? AND status='covered'""",
            (site, work_id),
        )
    chapters = db.execute(
        """SELECT source_chapter_id,chapter_label,chapter_kind,access,status
           FROM text_novel_chapters WHERE site=? AND source_work_id=?""",
        (site, work_id),
    ).fetchall()
    local_counts: dict[tuple[str, str], int] = {}
    for row in chapters:
        key = (_text_key(row["chapter_label"]), row["chapter_kind"])
        local_counts[key] = local_counts.get(key, 0) + 1
    covered = 0
    for row in chapters:
        key = (_text_key(row["chapter_label"]), row["chapter_kind"])
        if (
            row["access"] == "free"
            and row["status"] not in {"complete", "held_conflict", "waiting"}
            and key[0]
            and available.get(key) == local_counts.get(key) == 1
        ):
            db.execute(
                """UPDATE text_novel_chapters SET status='covered'
                   WHERE site=? AND source_work_id=? AND source_chapter_id=?""",
                (site, work_id, row["source_chapter_id"]),
            )
            if has_queue:
                db.execute(
                    """UPDATE text_collector_queue SET status='covered'
                       WHERE source=? AND kind='episode' AND entity_id=?
                         AND status IN ('pending','retry')""",
                    (site, row["source_chapter_id"]),
                )
            covered += 1
    return covered


def _refresh_link_candidates(db: sqlite3.Connection, site: str, work_id: str) -> None:
    current = db.execute(
        "SELECT slug,title_key,author_key FROM text_novel_sources "
        "WHERE site=? AND source_work_id=?",
        (site, work_id),
    ).fetchone()
    if current is None:
        return
    db.execute(
        """DELETE FROM text_novel_link_candidates
           WHERE status='candidate' AND
                 ((left_site=? AND left_work_id=?) OR (right_site=? AND right_work_id=?))""",
        (site, work_id, site, work_id),
    )
    if not current["slug"] or not current["title_key"] or not current["author_key"]:
        return
    matches = db.execute(
        """SELECT site,source_work_id FROM text_novel_sources
           WHERE site<>? AND slug=? AND title_key=? AND author_key=? AND author_key<>''""",
        (site, current["slug"], current["title_key"], current["author_key"]),
    ).fetchall()
    for match in matches:
        left = sorted(((site, work_id), (str(match["site"]), str(match["source_work_id"]))))
        db.execute(
            """INSERT OR IGNORE INTO text_novel_link_candidates(
               left_site,left_work_id,right_site,right_work_id,match_basis,status,updated_at)
               VALUES(?,?,?,?,?,'candidate',?)""",
            (left[0][0], left[0][1], left[1][0], left[1][1], "slug_title_author", _now()),
        )


def _json_file(path: Path, limit: int) -> tuple[dict[str, Any], bytes]:
    if path.is_symlink() or not path.is_file():
        raise BatchRejectedError("batch_file_invalid")
    if path.stat().st_size > limit:
        raise BatchRejectedError("batch_file_too_large")
    raw = path.read_bytes()
    if len(raw) != path.stat().st_size:
        raise BatchRejectedError("batch_file_too_large")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise BatchRejectedError("batch_json_invalid")
    return value, raw


def _identity_matches(item: dict[str, Any]) -> tuple[bool, str, str, str | None, str | None]:
    kind = item.get("kind")
    if kind == "novel_chapter":
        site, work_id, chapter_id = (
            item.get("site"),
            item.get("source_work_id"),
            item.get("source_chapter_id"),
        )
        if (
            not isinstance(site, str)
            or site not in _SITE_HOSTS
            or not isinstance(work_id, str)
            or not work_id.isdigit()
            or not isinstance(chapter_id, str)
            or not chapter_id.isdigit()
        ):
            return False, "novel", "", None, None
        expected = f"novel_chapter:{site}:{work_id}:{chapter_id}"
        try:
            parsed = urlsplit(str(item.get("source_url") or ""))
            valid_host = (
                parsed.scheme == "https"
                and parsed.hostname is not None
                and _SITE_HOSTS[site].fullmatch(parsed.hostname.lower().removeprefix("www."))
                is not None
                and parsed.username is None
                and parsed.password is None
                and parsed.port in {None, 443}
            )
        except ValueError:
            valid_host = False
        if not valid_host:
            return False, "novel", site, work_id, chapter_id
        return item.get("identity") == expected, "novel", site, work_id, chapter_id
    if kind == "arcalive_post":
        board, post_id, lane = item.get("board"), item.get("post_id"), item.get("content_lane")
        if (
            not isinstance(board, str)
            or not _BOARD.fullmatch(board)
            or not isinstance(post_id, str)
            or not post_id.isdigit()
            or not isinstance(lane, str)
            or lane not in {"text", "both"}
        ):
            return False, "arcalive", "arcalive", None, None
        try:
            parsed = urlsplit(str(item.get("source_url") or ""))
            valid_host = (
                parsed.scheme == "https"
                and parsed.hostname == "arca.live"
                and parsed.username is None
                and parsed.password is None
                and parsed.port in {None, 443}
            )
        except ValueError:
            valid_host = False
        if not valid_host:
            return False, "arcalive", "arcalive", None, None
        expected = f"arcalive:{board}:{post_id}:{lane}"
        return item.get("identity") == expected, "arcalive", "arcalive", board, post_id
    return False, "", "", None, None


def _canonical_ids(
    item: dict[str, Any], lane: str, source_site: str, db: sqlite3.Connection | None = None
) -> tuple[str | None, str | None]:
    if lane == "novel":
        work_id = str(item["source_work_id"])
        chapter_id = str(item["source_chapter_id"])
        return (
            _canonical_work_id(db, source_site, work_id),
            f"novel:{source_site}:{work_id}:{chapter_id}",
        )
    return None, str(item["identity"])


def _canonical_work_id(db: sqlite3.Connection | None, site: str, work_id: str) -> str:
    if db is not None:
        row = db.execute(
            """SELECT canonical_work_id FROM text_novel_work_group_sources
               WHERE site=? AND source_work_id=?""",
            (site, work_id),
        ).fetchone()
        if row is not None:
            return str(row["canonical_work_id"])
    return f"novel:{site}:{work_id}"


def list_novel_link_candidates(db_path: Path) -> list[dict[str, str]]:
    db = _connect(db_path)
    try:
        return [
            dict(row)
            for row in db.execute(
                """SELECT c.left_site,c.left_work_id,c.right_site,c.right_work_id,
                          c.match_basis,c.status,c.updated_at,
                          l.title AS left_title,l.author AS left_author,
                          r.title AS right_title,r.author AS right_author
                   FROM text_novel_link_candidates c
                   JOIN text_novel_sources l
                     ON l.site=c.left_site AND l.source_work_id=c.left_work_id
                   JOIN text_novel_sources r
                     ON r.site=c.right_site AND r.source_work_id=c.right_work_id
                   WHERE c.status='candidate'
                   ORDER BY c.updated_at,c.left_site,c.left_work_id,c.right_site,c.right_work_id"""
            )
        ]
    finally:
        db.close()


def resolve_novel_link_candidate(
    db_path: Path,
    left_site: str,
    left_work_id: str,
    right_site: str,
    right_work_id: str,
    *,
    accept: bool,
    canary_verified: bool = False,
) -> dict[str, str]:
    """Apply an explicit operator decision; acceptance requires canary confirmation."""
    if accept and not canary_verified:
        raise ValueError("cross-source acceptance requires a verified 20-work canary")
    db = _connect(db_path)
    try:
        with db:
            candidate = db.execute(
                """SELECT * FROM text_novel_link_candidates
                   WHERE left_site=? AND left_work_id=? AND right_site=? AND right_work_id=?""",
                (left_site, left_work_id, right_site, right_work_id),
            ).fetchone()
            if candidate is None or candidate["status"] != "candidate":
                raise KeyError("novel link candidate is missing or already resolved")
            group_id = ""
            if accept:
                sources = db.execute(
                    """SELECT site,source_work_id,slug,title_key,author_key FROM text_novel_sources
                       WHERE (site=? AND source_work_id=?) OR (site=? AND source_work_id=?)""",
                    (left_site, left_work_id, right_site, right_work_id),
                ).fetchall()
                if len(sources) != 2:
                    raise ValueError("novel link sources changed after candidate discovery")
                left = next(
                    row
                    for row in sources
                    if (row["site"], row["source_work_id"]) == (left_site, left_work_id)
                )
                right = next(row for row in sources if row is not left)
                if (
                    not left["slug"]
                    or left["slug"] != right["slug"]
                    or not left["title_key"]
                    or left["title_key"] != right["title_key"]
                    or not left["author_key"]
                    or left["author_key"] != right["author_key"]
                ):
                    raise ValueError(
                        "novel link candidate no longer has matching slug, title, and author"
                    )
                mapped = db.execute(
                    """SELECT site,source_work_id,canonical_work_id
                       FROM text_novel_work_group_sources
                       WHERE (site=? AND source_work_id=?) OR (site=? AND source_work_id=?)""",
                    (left_site, left_work_id, right_site, right_work_id),
                ).fetchall()
                group_ids = {str(row["canonical_work_id"]) for row in mapped}
                if len(group_ids) > 1:
                    raise ValueError("sources already belong to different canonical work groups")
                if group_ids:
                    group_id = next(iter(group_ids))
                else:
                    members = sorted(((left_site, left_work_id), (right_site, right_work_id)))
                    seed = "\n".join(f"{site}:{work_id}" for site, work_id in members)
                    group_id = f"novel:linked:{hashlib.sha256(seed.encode()).hexdigest()}"
                    db.execute(
                        """INSERT INTO text_novel_work_groups(
                               canonical_work_id,created_at) VALUES(?,?)""",
                        (group_id, _now()),
                    )
                for site, work_id in ((left_site, left_work_id), (right_site, right_work_id)):
                    prior = db.execute(
                        """SELECT canonical_work_id FROM text_novel_work_group_sources
                           WHERE site=? AND source_work_id=?""",
                        (site, work_id),
                    ).fetchone()
                    if prior is None:
                        db.execute(
                            """INSERT INTO text_novel_work_group_sources(
                                   site,source_work_id,canonical_work_id) VALUES(?,?,?)""",
                            (site, work_id, group_id),
                        )
                    elif str(prior["canonical_work_id"]) != group_id:
                        raise ValueError(
                            "source work is already assigned to another canonical group"
                        )
                    db.execute(
                        """UPDATE text_archive_items SET canonical_work_id=?
                           WHERE lane='novel' AND source_site=? AND source_work_id=?""",
                        (group_id, site, work_id),
                    )
                for site, work_id in ((left_site, left_work_id), (right_site, right_work_id)):
                    mark_cross_source_covered(db, site, work_id)
            status = "accepted" if accept else "rejected"
            db.execute(
                """UPDATE text_novel_link_candidates SET status=?,updated_at=?
                   WHERE left_site=? AND left_work_id=? AND right_site=? AND right_work_id=?""",
                (status, _now(), left_site, left_work_id, right_site, right_work_id),
            )
        return {
            "left_site": left_site,
            "left_work_id": left_work_id,
            "right_site": right_site,
            "right_work_id": right_work_id,
            "status": status,
            "canonical_work_id": group_id,
        }
    finally:
        db.close()


def _object_key(sha256: str) -> str:
    return f"objects/sha256/{sha256[:2]}/{sha256}.md"


def _safe_batch(
    inbox_root: Path, batch_id: str
) -> tuple[dict[str, Any], bytes, Path, dict[str, Any]]:
    if not _BATCH_ID.fullmatch(batch_id):
        raise BatchRejectedError("batch_id_invalid")
    drop = inbox_root / "drop"
    batch_dir = drop / batch_id
    if any(path.is_symlink() for path in (inbox_root, drop, batch_dir)):
        raise BatchRejectedError("batch_path_symlink")
    if not batch_dir.is_dir():
        raise BatchNotReadyError("batch_not_found")
    ready_path = batch_dir / "ready.json"
    if not ready_path.exists():
        raise BatchNotReadyError("ready_marker_missing")
    ready, _ = _json_file(ready_path, 16 * 1024)
    if (
        type(ready.get("schema")) is not int
        or ready.get("schema") != 1
        or ready.get("batch_id") != batch_id
    ):
        raise BatchRejectedError("ready_marker_invalid")
    manifest, manifest_bytes = _json_file(batch_dir / "manifest.json", _MAX_MANIFEST_BYTES)
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if ready.get("manifest_sha256") != manifest_sha:
        raise BatchRejectedError("manifest_digest_mismatch")
    if (
        type(manifest.get("schema")) is not int
        or manifest.get("schema") != 1
        or manifest.get("batch_id") != batch_id
        or manifest.get("producer") != "newtomi-pc"
        or not isinstance(manifest.get("items"), list)
        or not 1 <= len(manifest["items"]) <= _MAX_ITEMS
    ):
        raise BatchRejectedError("manifest_invalid")
    files_dir = batch_dir / "files"
    if files_dir.is_symlink() or not files_dir.is_dir():
        raise BatchRejectedError("files_dir_invalid")
    actual_names: set[str] = set()
    for entry in files_dir.iterdir():
        if entry.is_symlink() or not entry.is_file():
            raise BatchRejectedError("batch_entry_invalid")
        actual_names.add(entry.name)
        if len(actual_names) > _MAX_ITEMS:
            raise BatchRejectedError("too_many_batch_files")
    candidates: list[dict[str, Any]] = []
    identities: set[str] = set()
    expected_names: set[str] = set()
    for raw_item in manifest["items"]:
        if not isinstance(raw_item, dict):
            raise BatchRejectedError("item_not_object")
        identity = raw_item.get("identity")
        if not isinstance(identity, str) or not identity.strip() or identity in identities:
            raise BatchRejectedError("item_identity_invalid_or_duplicate")
        identities.add(identity)
        item = dict(raw_item)
        if len(json.dumps(item, ensure_ascii=False).encode("utf-8")) > 16 * 1024:
            raise BatchRejectedError("item_metadata_too_large")
        relative = item.get("relative_path")
        body_path: Path | None = None
        reason = ""
        if not isinstance(relative, str) or not re.fullmatch(r"files/[0-9]{6}\.md", relative):
            reason = "relative_path_invalid"
        else:
            posix = PurePosixPath(relative)
            if posix.is_absolute() or ".." in posix.parts or str(posix) != relative:
                reason = "relative_path_invalid"
            else:
                expected_names.add(posix.name)
                body_path = files_dir / posix.name
        if not reason and set(item) - _ITEM_FIELDS:
            reason = "item_fields_unknown"
        if (
            not reason
            and "title" in item
            and (not isinstance(item["title"], str) or len(item["title"]) > 500)
        ):
            reason = "item_title_invalid"
        identity_ok, lane, source_site, source_work_id, source_chapter_id = _identity_matches(item)
        if not reason and not identity_ok:
            reason = "source_identity_invalid"
        size, digest = item.get("bytes"), item.get("sha256")
        if not reason and (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not 1 <= size <= _MAX_FILE_BYTES
            or not isinstance(digest, str)
            or not _SHA256.fullmatch(digest)
        ):
            reason = "content_metadata_invalid"
        body: bytes | None = None
        if not reason and body_path is not None:
            if body_path.is_symlink() or not body_path.is_file():
                reason = "content_missing"
            else:
                if body_path.stat().st_size != size:
                    reason = "size_mismatch"
                else:
                    try:
                        body = body_path.read_bytes()
                    except OSError:
                        reason = "content_unreadable"
                    if (
                        not reason
                        and body is not None
                        and hashlib.sha256(body).hexdigest() != digest
                    ):
                        reason = "sha256_mismatch"
                    if not reason and body is not None:
                        try:
                            text = body.decode("utf-8")
                        except UnicodeDecodeError:
                            reason = "body_not_utf8"
                        else:
                            if "\x00" in text:
                                reason = "body_contains_nul"
        candidates.append(
            {
                "item": item,
                "identity": identity,
                "lane": lane,
                "source_site": source_site,
                "source_work_id": source_work_id,
                "source_chapter_id": source_chapter_id,
                "body": body if not reason else None,
                "reason": reason,
            }
        )
    if actual_names - expected_names:
        raise BatchRejectedError("unlisted_batch_file")
    if len(expected_names) != sum(
        1
        for item in manifest["items"]
        if isinstance(item, dict)
        and isinstance(item.get("relative_path"), str)
        and re.fullmatch(r"files/[0-9]{6}\.md", item["relative_path"])
    ):
        raise BatchRejectedError("duplicate_batch_path")
    return (
        manifest,
        manifest_bytes,
        batch_dir,
        {"manifest_sha256": manifest_sha, "candidates": candidates},
    )


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(_SCHEMA)
    group_columns = {row[1] for row in db.execute("PRAGMA table_info(text_collector_groups)")}
    if "last_source" not in group_columns:
        db.execute(
            "ALTER TABLE text_collector_groups ADD COLUMN last_source TEXT NOT NULL DEFAULT ''"
        )
    source_columns = {row[1] for row in db.execute("PRAGMA table_info(text_novel_sources)")}
    if "source_url" not in source_columns:
        db.execute("ALTER TABLE text_novel_sources ADD COLUMN source_url TEXT NOT NULL DEFAULT ''")
    item_columns = {row[1] for row in db.execute("PRAGMA table_info(text_archive_items)")}
    if "source_category" not in item_columns:
        db.execute(
            "ALTER TABLE text_archive_items ADD COLUMN source_category TEXT NOT NULL DEFAULT ''"
        )
    with db:
        legacy_pc_sources = db.execute(
            """SELECT site,source_work_id FROM text_novel_sources
               WHERE site IN ('toki','newtoki','sbxh') AND slug=''"""
        ).fetchall()
        for source in legacy_pc_sources:
            db.execute(
                "UPDATE text_novel_sources SET slug=source_work_id "
                "WHERE site=? AND source_work_id=? AND slug=''",
                (source["site"], source["source_work_id"]),
            )
            _refresh_link_candidates(db, str(source["site"]), str(source["source_work_id"]))
    return db


def _store_object(root: Path, body: bytes, digest: str) -> str:
    key = _object_key(digest)
    target = root / key
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise OSError("object path is a symlink")
    if target.exists():
        current = target.read_bytes()
        if hashlib.sha256(current).hexdigest() != digest or len(current) != len(body):
            raise OSError("existing content object failed verification")
        return key
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".pending-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return key


def _write_receipt(receipts_root: Path, batch_id: str, receipt: dict[str, Any]) -> None:
    receipts_root.mkdir(parents=True, exist_ok=True)
    target = receipts_root / f"{batch_id}.json"
    encoded = (
        json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    if target.is_symlink():
        raise OSError("receipt path is a symlink")
    if target.exists():
        current_bytes = target.read_bytes()
        if current_bytes == encoded:
            return
        try:
            current = json.loads(current_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BatchRejectedError("receipt_invalid_existing") from exc
        if (
            not isinstance(current, dict)
            or current.get("batch_id") != batch_id
            or current.get("manifest_sha256") != receipt.get("manifest_sha256")
            or current.get("revision") not in {1, 2}
            or receipt.get("revision") not in {1, 2}
        ):
            raise BatchRejectedError("receipt_conflict")
        if current["revision"] > receipt["revision"]:
            return
        if current["revision"] == receipt["revision"]:
            raise BatchRejectedError("receipt_conflict")
    fd, name = tempfile.mkstemp(prefix=f".{batch_id}-", dir=receipts_root)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def import_batch(
    inbox_root: Path, batch_id: str, db_path: Path, object_root: Path, receipts_root: Path
) -> dict[str, Any] | None:
    """Import one ready batch; returns None when there is no committed ready marker."""
    try:
        manifest, _manifest_bytes, _batch_dir, validation = _safe_batch(inbox_root, batch_id)
    except BatchNotReadyError:
        return None
    db = _connect(db_path)
    try:
        old = db.execute(
            "SELECT * FROM text_archive_batches WHERE batch_id=?", (batch_id,)
        ).fetchone()
        if old is not None:
            if old["manifest_sha256"] != validation["manifest_sha256"]:
                raise BatchRejectedError("batch_id_reused_with_new_manifest")
            receipt = json.loads(old["receipt_json"])
            if not isinstance(receipt, dict):
                raise BatchRejectedError("receipt_invalid_existing")
            _write_receipt(receipts_root, batch_id, receipt)
            return receipt

        now = _now()
        results: list[dict[str, Any]] = []
        with db:
            for candidate in validation["candidates"]:
                item = candidate["item"]
                identity = candidate["identity"]
                reason = candidate["reason"]
                canonical_work_id, canonical_chapter_id = (
                    _canonical_ids(item, candidate["lane"], candidate["source_site"], db)
                    if not reason
                    else (None, None)
                )
                if reason:
                    results.append({"identity": identity, "status": "rejected", "reason": reason})
                    continue
                digest = str(item["sha256"])
                existing = db.execute(
                    """SELECT content_sha256,bytes,canonical_work_id,canonical_chapter_id
                       FROM text_archive_items WHERE identity=?""",
                    (identity,),
                ).fetchone()
                if existing is not None and existing["content_sha256"] != digest:
                    db.execute(
                        """INSERT OR IGNORE INTO text_archive_conflicts
                           (batch_id,identity,existing_sha256,incoming_sha256,reason,detected_at)
                           VALUES(?,?,?,?,?,?)""",
                        (
                            batch_id,
                            identity,
                            existing["content_sha256"],
                            digest,
                            "source_id_hash_changed",
                            now,
                        ),
                    )
                    results.append(
                        {
                            "identity": identity,
                            "status": "held_conflict",
                            "reason": "source_id_hash_changed",
                        }
                    )
                    continue
                if existing is not None:
                    canonical_work_id = existing["canonical_work_id"]
                    canonical_chapter_id = existing["canonical_chapter_id"]
                    status = "duplicate"
                else:
                    body = candidate["body"]
                    if not isinstance(body, bytes):
                        results.append(
                            {
                                "identity": identity,
                                "status": "rejected",
                                "reason": "content_missing",
                            }
                        )
                        continue
                    object_key = _store_object(object_root, body, digest)
                    db.execute(
                        """INSERT OR IGNORE INTO text_archive_objects(
                           sha256,bytes,object_key,first_seen_at) VALUES(?,?,?,?)""",
                        (digest, len(body), object_key, now),
                    )
                    data = item
                    board = data.get("board")
                    post_id = data.get("post_id")
                    lane = data.get("content_lane")
                    db.execute(
                        """INSERT INTO text_archive_items(
                           identity,lane,source_site,source_work_id,source_chapter_id,
                           source_board,source_post_id,source_category,content_lane,source_url,title,author,
                           chapter_label,chapter_kind,access,content_sha256,bytes,object_key,
                           canonical_work_id,canonical_chapter_id,batch_id,imported_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            identity,
                            candidate["lane"],
                            candidate["source_site"],
                            candidate["source_work_id"],
                            candidate["source_chapter_id"],
                            board,
                            post_id,
                            data.get("category", "") if candidate["lane"] == "arcalive" else "",
                            lane,
                            data["source_url"],
                            data.get("work_title", data.get("title") or data.get("category", "")),
                            data.get("author", ""),
                            data.get("chapter_label", ""),
                            data.get("chapter_kind", ""),
                            data.get("access", "unknown"),
                            digest,
                            len(body),
                            object_key,
                            canonical_work_id,
                            canonical_chapter_id,
                            batch_id,
                            now,
                        ),
                    )
                    if candidate["lane"] == "novel":
                        title = str(data.get("work_title", ""))
                        author = str(data.get("author", ""))
                        db.execute(
                            """INSERT INTO text_novel_sources(
                               site,source_work_id,source_url,slug,title,author,
                               title_key,author_key,last_seen_at)
                               VALUES(?,?,?,?,?,?,?,?,?)
                               ON CONFLICT(site,source_work_id) DO UPDATE SET
                               source_url=excluded.source_url,
                               slug=CASE WHEN text_novel_sources.slug=''
                                         THEN excluded.slug ELSE text_novel_sources.slug END,
                               title=excluded.title,author=excluded.author,title_key=excluded.title_key,
                               author_key=excluded.author_key,last_seen_at=excluded.last_seen_at""",
                            (
                                candidate["source_site"],
                                candidate["source_work_id"],
                                data["source_url"],
                                candidate["source_work_id"],
                                title,
                                author,
                                _text_key(title),
                                _text_key(author),
                                now,
                            ),
                        )
                        _refresh_link_candidates(
                            db, candidate["source_site"], candidate["source_work_id"]
                        )
                        db.execute(
                            """INSERT INTO text_novel_chapters(
                               site,source_work_id,source_chapter_id,
                               chapter_label,chapter_kind,access,content_sha256,status,last_seen_at)
                               VALUES(?,?,?,?,?,?,?,?,?)
                               ON CONFLICT(site,source_work_id,source_chapter_id)
                               DO UPDATE SET content_sha256=excluded.content_sha256,
                               status=excluded.status,
                               last_seen_at=excluded.last_seen_at""",
                            (
                                candidate["source_site"],
                                candidate["source_work_id"],
                                candidate["source_chapter_id"],
                                data.get("chapter_label", ""),
                                data.get("chapter_kind", "main"),
                                data.get("access", "unknown"),
                                digest,
                                "complete",
                                now,
                            ),
                        )
                    status = "accepted"
                results.append(
                    {
                        "identity": identity,
                        "status": status,
                        "canonical_work_id": canonical_work_id,
                        "canonical_chapter_id": canonical_chapter_id,
                        "content_sha256": digest,
                    }
                )
            for candidate, result in zip(validation["candidates"], results):
                if candidate["lane"] == "novel" and result["status"] in {"accepted", "duplicate"}:
                    source_site = candidate["source_site"]
                    source_work_id = candidate["source_work_id"]
                    if source_site and source_work_id:
                        for row in db.execute(
                            """SELECT site,source_work_id FROM text_novel_work_group_sources
                               WHERE canonical_work_id=(
                                 SELECT canonical_work_id FROM text_novel_work_group_sources
                                 WHERE site=? AND source_work_id=?)""",
                            (source_site, source_work_id),
                        ):
                            mark_cross_source_covered(db, row["site"], row["source_work_id"])
            receipt = {
                "schema": 1,
                "batch_id": batch_id,
                "manifest_sha256": validation["manifest_sha256"],
                "revision": 1,
                "imported_at": now,
                "items": results,
            }
            encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            db.execute(
                """INSERT INTO text_archive_batches(
                   batch_id,manifest_sha256,revision,receipt_json,imported_at)
                   VALUES(?,?,?,?,?)""",
                (batch_id, validation["manifest_sha256"], 1, encoded, now),
            )
        _write_receipt(receipts_root, batch_id, receipt)
        return receipt
    finally:
        db.close()


def _next_ready_batch(inbox_root: Path) -> str | None:
    drop = inbox_root / "drop"
    if drop.is_symlink() or not drop.is_dir():
        return None
    for directory in sorted(drop.iterdir(), key=lambda entry: entry.name):
        if _BATCH_ID.fullmatch(directory.name) and not directory.is_symlink():
            if (
                (directory / "ready.json").is_file()
                and not (directory / "ready.json").is_symlink()
                and not (inbox_root / "receipts" / f"{directory.name}.json").is_file()
            ):
                return directory.name
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Import one committed Newtomi text batch")
    parser.add_argument("--batch-id", help="import one batch; default is the oldest ready batch")
    args = parser.parse_args()
    inbox_root = Path("/srv/redstm-text-inbox")
    batch_id = args.batch_id or _next_ready_batch(inbox_root)
    if batch_id is None:
        print(json.dumps({"status": "idle", "reason": "no_ready_batch"}))
        return
    try:
        with operation_window():
            result = import_batch(
                inbox_root,
                batch_id,
                Path("/srv/redstm-text/text-archive.sqlite"),
                Path("/srv/redstm-text/objects"),
                inbox_root / "receipts",
            )
    except RuntimeWindowError as exc:
        parser.exit(75, f"text import deferred: {exc}\n")
    if result is None:
        parser.exit(0, "batch not ready; no receipt written\n")
    print(
        json.dumps(
            {
                "batch_id": batch_id,
                "revision": result["revision"],
                "items": len(result["items"]),
            }
        )
    )


if __name__ == "__main__":
    main()
