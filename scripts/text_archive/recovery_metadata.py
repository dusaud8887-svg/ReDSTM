"""Hash public index inputs, not all stored chapter bodies."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path


def metadata_fingerprint(db_path: Path, lane: str) -> str:
    digest = hashlib.sha256(b"text-index-input-v2\n")
    with closing(sqlite3.connect(db_path)) as db:
        db.execute("BEGIN")
        for row in db.execute(
            """SELECT identity,canonical_work_id,canonical_chapter_id,
            source_site,source_work_id,source_chapter_id,title,author,chapter_label,
            chapter_kind,content_sha256,source_board,source_post_id,source_category,
            content_lane,imported_at FROM text_archive_items WHERE lane=? ORDER BY identity""",
            (lane,),
        ):
            digest.update(json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode())
            digest.update(b"\n")
        if lane == "novel":
            for row in db.execute(
                """SELECT i.identity,i.text_sha256,c.chapter_label,c.chapter_kind,
                   c.source_episode_number_raw,c.source_episode_number_normalized,
                   c.source_toc_position,c.source_published_at
                   FROM text_archive_items i LEFT JOIN text_novel_chapters c
                     ON c.site=i.source_site AND c.source_work_id=i.source_work_id
                     AND c.source_chapter_id=i.source_chapter_id
                   WHERE i.lane='novel' ORDER BY i.identity"""
            ):
                digest.update(json.dumps(list(row), ensure_ascii=False).encode())
                digest.update(b"\n")
            for query in (
                """SELECT s.canonical_work_id,s.site,s.source_work_id
                   FROM text_novel_work_group_sources s WHERE s.canonical_work_id IN (
                     SELECT i.canonical_work_id FROM text_archive_items i WHERE i.lane='novel')
                   ORDER BY s.canonical_work_id,s.site,s.source_work_id""",
                """SELECT a.canonical_work_id,a.alias_work_id
                   FROM text_novel_work_aliases a WHERE a.canonical_work_id IN (
                     SELECT i.canonical_work_id FROM text_archive_items i WHERE i.lane='novel')
                   ORDER BY a.canonical_work_id,a.alias_work_id""",
            ):
                for row in db.execute(query):
                    digest.update(json.dumps(list(row), ensure_ascii=False).encode())
                    digest.update(b"\n")
        if lane == "manual":
            for row in db.execute(
                "SELECT identity,created_at,folder FROM text_manual_documents ORDER BY identity"
            ):
                digest.update(json.dumps(list(row), ensure_ascii=False).encode())
                digest.update(b"\n")
    return digest.hexdigest()
