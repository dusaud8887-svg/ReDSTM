"""Hash public index inputs, not all stored chapter bodies."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path


def metadata_fingerprint(db_path: Path, lane: str) -> str:
    digest = hashlib.sha256(b"text-index-input-v1\n")
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
    return digest.hexdigest()
