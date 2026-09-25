"""Explicit server-side recovery of legacy rejected/semantic-duplicate batches.

Run without --apply first. No original body, DB item, or immutable receipt is changed.
Stop importer/publisher services while using --apply. Native receipts remain authoritative;
this creates a separate authenticated proof/status sidecar.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from scripts.text_archive import importer
from scripts.text_archive.recovery_status import write_rejection_status


def atomic_status(receipts: Path, batch_id: str, payload: dict) -> None:
    if receipts.is_symlink():
        raise ValueError("symlink receipts root")
    receipts.mkdir(parents=True, exist_ok=True)
    path = receipts / f"{batch_id}.status.json"
    if path.is_symlink():
        raise ValueError("symlink status")
    if path.exists():
        existing = json.loads(path.read_bytes())
        if existing != payload:
            raise ValueError("existing terminal status must be inspected manually")
        return
    fd, name = tempfile.mkstemp(prefix=".repair-", dir=receipts)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write((json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode())
            out.flush()
            os.fsync(out.fileno())
        if os.name == "posix":
            os.chown(temp, -1, receipts.stat().st_gid)  # type: ignore[attr-defined]
        os.chmod(temp, 0o640)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def repair(inbox: Path, db_path: Path, objects: Path, apply: bool) -> dict[str, int]:
    counts = {"rejection_status": 0, "receipt_proof": 0, "manual_review": 0}
    if any(p.is_symlink() for p in (inbox, inbox / "drop", inbox / "receipts", objects)):
        raise ValueError("symlink archive root")
    with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        for batch_dir in sorted((inbox / "drop").iterdir()):
            bid = batch_dir.name
            if (
                not importer._BATCH_ID.fullmatch(bid)
                or batch_dir.is_symlink()
                or not batch_dir.is_dir()
            ):
                continue
            try:
                rejection = batch_dir / "rejected.json"
                if rejection.is_file() and not rejection.is_symlink():
                    if rejection.stat().st_size > 16384:
                        raise ValueError("rejection too large")
                    rejected = json.loads(rejection.read_bytes())
                    if not isinstance(rejected, dict):
                        raise ValueError("invalid legacy rejection")
                    reason = str(rejected.get("reason", "legacy_batch_rejection"))
                    if not write_rejection_status(inbox, bid, reason, dry_run=not apply):
                        raise ValueError(
                            "rejection cannot be bound to a manifest; manual review required"
                        )
                    counts["rejection_status"] += 1
                    continue
                old = db.execute(
                    "SELECT manifest_sha256,receipt_json FROM text_archive_batches "
                    "WHERE batch_id=?",
                    (bid,),
                ).fetchone()
                if old is None:
                    continue
                _, _, _, validation = importer._safe_batch(inbox, bid)
                if validation["manifest_sha256"] != old["manifest_sha256"]:
                    raise ValueError("manifest changed after import")
                receipt = json.loads(old["receipt_json"])
                if not isinstance(receipt, dict) or not isinstance(receipt.get("items"), list):
                    raise ValueError("invalid legacy receipt")
                repaired = copy.deepcopy(receipt)
                candidates = {c["identity"]: c for c in validation["candidates"]}
                changed = False
                for item in repaired["items"]:
                    if not isinstance(item, dict):
                        raise ValueError("invalid legacy receipt item")
                    c = candidates.get(item["identity"])
                    if (
                        c is None
                        or c["reason"]
                        or c["lane"] != "novel"
                        or item.get("status") != "duplicate"
                    ):
                        continue
                    submitted = c["item"]["sha256"]
                    if submitted == item.get("content_sha256"):
                        continue
                    stored = db.execute(
                        "SELECT content_sha256,object_key FROM text_archive_items WHERE identity=?",
                        (item["identity"],),
                    ).fetchone()
                    if stored is None or stored["content_sha256"] != item["content_sha256"]:
                        raise ValueError("receipt no longer matches stored item")
                    if not importer._equivalent_novel_text(
                        objects, stored["object_key"], c["body"]
                    ):
                        raise ValueError("canonical text equivalence not proven")
                    canonical = importer.canonical_novel_bytes(c["body"])
                    if canonical is None:
                        raise ValueError("unknown canonical layout")
                    item.update(
                        submitted_raw_sha256=submitted,
                        stored_object_sha256=stored["content_sha256"],
                        text_sha256=hashlib.sha256(canonical).hexdigest(),
                        equivalence_version=1,
                    )
                    changed = True
                if changed:
                    if apply:
                        atomic_status(
                            inbox / "receipts",
                            bid,
                            {"schema": 1, "batch_status": "receipt_repair", "receipt": repaired},
                        )
                    counts["receipt_proof"] += 1
            except (
                ValueError,
                OSError,
                KeyError,
                sqlite3.Error,
                importer.BatchNotReadyError,
            ) as exc:
                counts["manual_review"] += 1
                print(json.dumps({"batch_id": bid, "manual_review": str(exc)}, ensure_ascii=False))
    return counts


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--inbox", type=Path, default=Path("/srv/redstm-text-inbox"))
    p.add_argument("--db", type=Path, default=Path("/srv/redstm-text/text-archive.sqlite"))
    p.add_argument("--objects", type=Path, default=Path("/srv/redstm-text/objects"))
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    print(
        json.dumps(
            {
                "mode": "apply" if a.apply else "dry-run",
                "results": repair(a.inbox, a.db, a.objects, a.apply),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
