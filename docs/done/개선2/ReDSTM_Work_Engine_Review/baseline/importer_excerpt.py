"""Selected upstream functions; imports/support definitions supplied for isolated tests.
Source: scripts/text_archive/importer.py at 4edfb1bbceaa4427e6a6a0a40dbb857f51b08804.
Do not import this as application code or run it against a real database.
"""
import re
import sqlite3
import unicodedata
import uuid
from datetime import UTC, datetime

def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

def _text_key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())

def _new_work_id() -> str:
    return f"novel:{uuid.uuid4()}"

def _chapter_key(label: str, kind: str) -> tuple[str, str]:
    normalized = unicodedata.normalize("NFKC", label).casefold()
    return re.sub(r"\s+", "", normalized), _text_key(kind)

def _auto_link_basis(
    db: sqlite3.Connection,
    left_site: str,
    left_work_id: str,
    right_site: str,
    right_work_id: str,
) -> str | None:
    rows = db.execute(
        """SELECT site,source_work_id,slug,title_key,author_key FROM text_novel_sources
           WHERE (site=? AND source_work_id=?) OR (site=? AND source_work_id=?)""",
        (left_site, left_work_id, right_site, right_work_id),
    ).fetchall()
    if len(rows) != 2:
        return None
    left = next(
        (row for row in rows if row["site"] == left_site and row["source_work_id"] == left_work_id),
        None,
    )
    right = next(
        (
            row
            for row in rows
            if row["site"] == right_site and row["source_work_id"] == right_work_id
        ),
        None,
    )
    if (
        left is None
        or right is None
        or left["site"] == right["site"]
        or not left["title_key"]
        or left["title_key"] != right["title_key"]
        or not left["author_key"]
        or left["author_key"] != right["author_key"]
    ):
        return None
    for site in (left_site, right_site):
        matches = db.execute(
            """SELECT COUNT(*) FROM text_novel_sources
               WHERE site=? AND title_key=? AND author_key=?""",
            (site, left["title_key"], left["author_key"]),
        ).fetchone()[0]
        if matches != 1:
            return None
    signatures: list[set[tuple[tuple[str, str], str]]] = []
    for site, work_id in ((left_site, left_work_id), (right_site, right_work_id)):
        signatures.append(
            {
                (
                    _chapter_key(str(row["chapter_label"]), str(row["chapter_kind"])),
                    str(row["text_sha256"]),
                )
                for row in db.execute(
                    """SELECT chapter_label,chapter_kind,text_sha256 FROM text_novel_chapters
                   WHERE site=? AND source_work_id=? AND status='complete'
                     AND text_sha256 IS NOT NULL""",
                    (site, work_id),
                )
            }
        )
    hashes = len(signatures[0] & signatures[1])
    left_slug = str(left["slug"] or "").casefold()
    right_slug = str(right["slug"] or "").casefold()
    external_id_match = (
        left_slug == right_work_id.casefold() or right_slug == left_work_id.casefold()
    )
    if hashes >= 2:
        return "normalized_title_author+body_sha256"
    if hashes >= 1 and external_id_match:
        return "normalized_title_author+source_alias+body_sha256"
    return None

def _migrate_weak_novel_links(db: sqlite3.Connection) -> None:
    if db.execute("SELECT 1 FROM text_novel_identity_migrations WHERE version=3").fetchone():
        return
    for row in db.execute(
        """SELECT left_site,left_work_id,right_site,right_work_id
           FROM text_novel_link_candidates
           WHERE status='auto_accepted'
             AND match_basis='normalized_title_author+chapter_sequence'"""
    ).fetchall():
        left = db.execute(
            """SELECT canonical_work_id FROM text_novel_work_group_sources
               WHERE site=? AND source_work_id=?""",
            (row["left_site"], row["left_work_id"]),
        ).fetchone()
        right = db.execute(
            """SELECT canonical_work_id FROM text_novel_work_group_sources
               WHERE site=? AND source_work_id=?""",
            (row["right_site"], row["right_work_id"]),
        ).fetchone()
        if left is not None and right is not None and left[0] == right[0]:
            members = db.execute(
                "SELECT COUNT(*) FROM text_novel_work_group_sources WHERE canonical_work_id=?",
                (left[0],),
            ).fetchone()[0]
            if members == 2:
                new_id = _new_work_id()
                db.execute(
                    "INSERT INTO text_novel_work_groups(canonical_work_id,created_at) VALUES(?,?)",
                    (new_id, _now()),
                )
                db.execute(
                    """UPDATE text_novel_work_group_sources SET canonical_work_id=?
                       WHERE site=? AND source_work_id=?""",
                    (new_id, row["right_site"], row["right_work_id"]),
                )
                db.execute(
                    """UPDATE text_archive_items SET canonical_work_id=?
                       WHERE lane='novel' AND source_site=? AND source_work_id=?""",
                    (new_id, row["right_site"], row["right_work_id"]),
                )
                db.execute(
                    """UPDATE text_novel_work_aliases SET canonical_work_id=?
                       WHERE alias_work_id=?""",
                    (new_id, f"novel:{row['right_site']}:{row['right_work_id']}"),
                )
        db.execute(
            """UPDATE text_novel_link_candidates SET status='candidate',
               match_basis='normalized_title_author',updated_at=?
               WHERE left_site=? AND left_work_id=? AND right_site=? AND right_work_id=?""",
            (
                _now(),
                row["left_site"],
                row["left_work_id"],
                row["right_site"],
                row["right_work_id"],
            ),
        )
    db.execute("UPDATE text_novel_chapters SET status='discovered' WHERE status='covered'")
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_collector_queue'"
    ).fetchone():
        db.execute("UPDATE text_collector_queue SET status='pending' WHERE status='covered'")
    db.execute(
        "INSERT INTO text_novel_identity_migrations(version,completed_at) VALUES(3,?)", (_now(),)
    )
