"""Recover missing Arcalive authors from verified local Markdown objects."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from scripts.text_archive.importer import _connect, _object_key, arcalive_header
from scripts.text_archive.runtime import RuntimeWindowError, operation_window


def repair_authors(db_path: Path, object_root: Path) -> dict[str, int]:
    scanned = updated = missing = 0
    last_identity = ""
    with operation_window(lock_wait_seconds=30):
        db = _connect(db_path)
        try:
            while rows := db.execute(
                """SELECT identity,content_sha256,bytes,object_key FROM text_archive_items
                   WHERE lane='arcalive' AND author='' AND identity>?
                   ORDER BY identity LIMIT 100""",
                (last_identity,),
            ).fetchall():
                with db:
                    for row in rows:
                        identity = str(row["identity"])
                        digest = str(row["content_sha256"])
                        if row["object_key"] != _object_key(digest):
                            raise ValueError("Arcalive object key does not match its digest")
                        body = (object_root / str(row["object_key"])).read_bytes()
                        if len(body) != row["bytes"] or hashlib.sha256(body).hexdigest() != digest:
                            raise ValueError("Arcalive object failed verification")
                        author = arcalive_header(body)[2][:500]
                        if author:
                            result = db.execute(
                                """UPDATE text_archive_items SET author=?
                                   WHERE identity=? AND author='' AND content_sha256=?""",
                                (author, identity, digest),
                            )
                            updated += result.rowcount
                        else:
                            missing += 1
                        scanned += 1
                        last_identity = identity
            return {"scanned": scanned, "updated": updated, "missing": missing}
        finally:
            db.close()


def main() -> None:
    try:
        report = repair_authors(
            Path("/srv/redstm-text/text-archive.sqlite"), Path("/srv/redstm-text/objects")
        )
    except RuntimeWindowError as error:
        raise SystemExit(f"author repair deferred: {error}") from error
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
