from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.text_archive.importer import _connect, _write_receipt
from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_INDEX_PAGE_SIZE = 500
_MAX_NOVEL_ITEMS = 1000
_MAX_ARCALIVE_ITEMS = 20000
_RCLONE_CONFIG = "/etc/redstm-text/rclone.conf"
_AVAILABILITY_PAGE_SIZE = 500


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def _write(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_immutable(path: Path, body: bytes) -> None:
    if path.is_symlink():
        raise OSError(f"immutable snapshot path is a symlink: {path}")
    if path.exists():
        if path.read_bytes() != body:
            raise OSError(f"immutable snapshot content mismatch: {path}")
        return
    _write(path, body)


def _indexed_file(root: Path, prefix: str, value: Any) -> tuple[str, bytes]:
    body = _json_bytes(value)
    digest = hashlib.sha256(body).hexdigest()
    key = f"published/indexes/{prefix}/{digest}.json"
    _write(root / key, body)
    return key, body


def build_publish_tree(
    db_path: Path, object_root: Path, output_root: Path, lane: str
) -> dict[str, Any]:
    """Build deterministic, content-addressed artifacts without touching remote storage."""
    if lane not in {"novel", "arcalive"}:
        raise ValueError("lane must be novel or arcalive")
    db = _connect(db_path)
    try:
        rows = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM text_archive_items WHERE lane=? ORDER BY imported_at,identity",
                (lane,),
            )
        ]
        if not rows:
            raise ValueError("no_publishable_items")
        if len(rows) > (_MAX_NOVEL_ITEMS if lane == "novel" else _MAX_ARCALIVE_ITEMS):
            raise ValueError("text_publish_canary_cap_exceeded")
        if lane == "novel":
            groups: dict[str, dict[str, Any]] = {}
            for row in rows:
                work_id = str(row["canonical_work_id"])
                work = groups.setdefault(
                    work_id,
                    {
                        "work_id": work_id,
                        "source_site": row["source_site"],
                        "source_work_id": row["source_work_id"],
                        "title": row["title"],
                        "author": row["author"],
                        "chapter_count": 0,
                        "latest_label": "",
                        "detail_key": "",
                    },
                )
                work["chapter_count"] += 1
                work["latest_label"] = row["chapter_label"]
            for work in groups.values():
                chapters = [row for row in rows if row["canonical_work_id"] == work["work_id"]]
                detail = {
                    "schema": 1,
                    "lane": "novel",
                    "work": {key: work[key] for key in ("work_id", "title", "author")},
                    "chapters": [
                        {
                            "chapter_id": row["canonical_chapter_id"],
                            "label": row["chapter_label"],
                            "kind": row["chapter_kind"],
                            "source_site": row["source_site"],
                            "source_chapter_id": row["source_chapter_id"],
                            "sha256": row["content_sha256"],
                        }
                        for row in chapters
                    ],
                }
                work["detail_key"], _ = _indexed_file(output_root, "novel", detail)
            catalog = sorted(
                groups.values(), key=lambda item: (item["title"].casefold(), item["work_id"])
            )
        else:
            catalog = [
                {
                    "identity": row["identity"],
                    "board": row["source_board"],
                    "post_id": row["source_post_id"],
                    "category": row["source_category"],
                    "title": row["title"],
                    "content_lane": row["content_lane"],
                    "sha256": row["content_sha256"],
                    "bytes": row["bytes"],
                }
                for row in rows
            ]
        catalog_refs: list[dict[str, str]] = []
        for page_number, offset in enumerate(range(0, len(catalog), _INDEX_PAGE_SIZE)):
            key, body = _indexed_file(
                output_root,
                lane,
                {
                    "schema": 1,
                    "lane": lane,
                    "page": page_number,
                    "items": catalog[offset : offset + _INDEX_PAGE_SIZE],
                },
            )
            catalog_refs.append({"key": key, "sha256": hashlib.sha256(body).hexdigest()})
        release_body = _json_bytes(
            {
                "schema": 1,
                "lane": lane,
                "generated_at": max(
                    (row["imported_at"] for row in rows), default="1970-01-01T00:00:00Z"
                ),
                "item_count": len(rows),
                "work_count": len(catalog) if lane == "novel" else 0,
                "catalog_pages": catalog_refs,
            }
        )
        release_sha = hashlib.sha256(release_body).hexdigest()
        release_key = f"published/releases/{lane}/{release_sha}.json"
        _write(output_root / release_key, release_body)
        pointer = _json_bytes(
            {"schema": 1, "lane": lane, "release_key": release_key, "sha256": release_sha}
        )
        pointer_path = output_root / f"published/{lane}/release.json"
        _write(pointer_path, pointer)
        object_rows = [
            dict(row)
            for row in db.execute(
                "SELECT DISTINCT content_sha256,bytes,object_key "
                "FROM text_archive_items WHERE lane=?",
                (lane,),
            )
        ]
        for row in object_rows:
            source = object_root / row["object_key"]
            target_key = (
                f"published/objects/sha256/{row['content_sha256'][:2]}/{row['content_sha256']}.md"
            )
            target = output_root / target_key
            body = source.read_bytes()
            if (
                len(body) != row["bytes"]
                or hashlib.sha256(body).hexdigest() != row["content_sha256"]
            ):
                raise ValueError(
                    f"local content object failed verification: {row['content_sha256']}"
                )
            _write(target, body)
        return {
            "lane": lane,
            "item_count": len(rows),
            "items": [(row["identity"], row["content_sha256"]) for row in rows],
            "release_key": release_key,
            "release_sha256": release_sha,
            "pointer_path": pointer_path,
            "object_keys": [
                f"published/objects/sha256/{row['content_sha256'][:2]}/{row['content_sha256']}.md"
                for row in object_rows
            ],
            "immutable_keys": [
                *[
                    f"published/objects/sha256/{row['content_sha256'][:2]}/{row['content_sha256']}.md"
                    for row in object_rows
                ],
                *[item["key"] for item in catalog_refs],
                *[str(work["detail_key"]) for work in (catalog if lane == "novel" else [])],
                release_key,
            ],
        }
    finally:
        db.close()


def _run(argv: list[str], runner: Any) -> bytes:
    result = runner(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = result.stdout
    return output if isinstance(output, bytes) else str(output).encode()


def _record_publication(db_path: Path, key: str, digest: str) -> None:
    verified_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS text_archive_publications "
            "(key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, verified_at TEXT NOT NULL)"
        )
        db.execute(
            "INSERT INTO text_archive_publications(key,sha256,verified_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256, "
            "verified_at=CASE WHEN text_archive_publications.sha256<>excluded.sha256 "
            "THEN excluded.verified_at ELSE text_archive_publications.verified_at END",
            (key, digest, verified_at),
        )


def _published_hash(db: sqlite3.Connection, key: str) -> str | None:
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_archive_publications'"
    ).fetchone()
    if not exists:
        return None
    row = db.execute("SELECT sha256 FROM text_archive_publications WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else None


def _backfill_arcalive_metadata(db_path: Path, object_root: Path) -> int:
    """Correct legacy catalog rows from their hash-verified Markdown headers."""
    db = _connect(db_path)
    try:
        rows = db.execute(
            """SELECT identity,content_sha256,bytes,object_key
               FROM text_archive_items WHERE lane='arcalive' AND source_category=''"""
        ).fetchall()
        changed = 0
        with db:
            for row in rows:
                body = (object_root / str(row["object_key"])).read_bytes()
                digest = hashlib.sha256(body).hexdigest()
                if len(body) != row["bytes"] or digest != row["content_sha256"]:
                    raise OSError(f"Arcalive object failed verification: {row['identity']}")
                lines = body.decode("utf-8-sig", errors="strict").splitlines()
                title = lines[0][2:].strip() if lines and lines[0].startswith("# ") else ""
                separator = next(
                    (index for index, line in enumerate(lines[:16]) if line == "---"),
                    -1,
                )
                category_line = (
                    next(
                        (line for line in lines[1:separator] if line.startswith("- category:")),
                        None,
                    )
                    if separator > 0
                    else None
                )
                if not title or category_line is None:
                    raise ValueError(f"Arcalive Markdown header is invalid: {row['identity']}")
                category = category_line.partition(":")[2].strip()
                if category in {"", "-"}:
                    category = "미분류"
                db.execute(
                    "UPDATE text_archive_items SET title=?,source_category=? WHERE identity=?",
                    (title[:500], category[:500], row["identity"]),
                )
                changed += 1
        return changed
    finally:
        db.close()


def _finalize_receipts(db_path: Path, receipts_root: Path) -> None:
    db = _connect(db_path)
    try:
        batches = db.execute(
            "SELECT batch_id,manifest_sha256,revision,receipt_json "
            "FROM text_archive_batches WHERE revision=1"
        ).fetchall()
        for batch in batches:
            receipt = json.loads(batch["receipt_json"])
            eligible = [
                item for item in receipt["items"] if item.get("status") in {"accepted", "duplicate"}
            ]
            if not eligible:
                continue
            publications = {
                str(row["key"]): row
                for row in db.execute(
                    "SELECT key,sha256,verified_at FROM text_archive_publications"
                )
            }
            if any(
                (record := publications.get(f"item:{item['identity']}")) is None
                or record["sha256"] != item.get("content_sha256")
                for item in eligible
            ):
                continue
            for item in eligible:
                item["published_at"] = publications[f"item:{item['identity']}"]["verified_at"]
            receipt["revision"] = 2
            encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            _write_receipt(receipts_root, str(batch["batch_id"]), receipt)
            with db:
                db.execute(
                    "UPDATE text_archive_batches SET revision=2,receipt_json=? "
                    "WHERE batch_id=? AND revision=1",
                    (encoded, batch["batch_id"]),
                )
    finally:
        db.close()


def build_availability_snapshot(db_path: Path, receipts_root: Path) -> dict[str, Any]:
    """Write a content-addressed, paged snapshot of novel items verified in R2."""
    db = _connect(db_path)
    try:
        group_sources: dict[str, list[str]] = {}
        for source in db.execute(
            "SELECT canonical_work_id,site,source_work_id FROM text_novel_work_group_sources"
        ):
            group_sources.setdefault(source["canonical_work_id"], []).append(
                f"{source['site']}:{source['source_work_id']}"
            )
        items = [
            {
                "identity": row["identity"],
                "source_site": row["source_site"],
                "source_work_id": str(row["source_work_id"]),
                "source_chapter_id": str(row["source_chapter_id"]),
                "canonical_work_id": row["canonical_work_id"],
                "canonical_chapter_id": row["canonical_chapter_id"],
                "source_url": row["source_url"],
                "title": row["title"],
                "author": row["author"],
                "chapter_label": row["chapter_label"],
                "chapter_kind": row["chapter_kind"],
                "access": row["access"],
                "sha256": row["content_sha256"],
                "bytes": row["bytes"],
                "published_at": row["verified_at"],
                "linked_sources": sorted(group_sources.get(row["canonical_work_id"], [])),
            }
            for row in db.execute(
                """SELECT i.*,p.verified_at FROM text_archive_items i
                   JOIN text_archive_publications p
                     ON p.key='item:'||i.identity AND p.sha256=i.content_sha256
                   WHERE i.lane='novel' ORDER BY i.identity"""
            )
        ]
    finally:
        db.close()
    if not items:
        return {"status": "idle", "item_count": 0}
    if len(items) > _MAX_NOVEL_ITEMS:
        raise ValueError("text_publish_canary_cap_exceeded")

    snapshot_id = hashlib.sha256(_json_bytes(items)).hexdigest()
    snapshot_rel = Path("availability") / "novel" / "snapshots" / snapshot_id
    page_refs: list[dict[str, Any]] = []
    for page_number, offset in enumerate(range(0, len(items), _AVAILABILITY_PAGE_SIZE)):
        page_items = items[offset : offset + _AVAILABILITY_PAGE_SIZE]
        body = _json_bytes(
            {
                "schema": 1,
                "lane": "novel",
                "snapshot_id": snapshot_id,
                "page": page_number,
                "items": page_items,
            }
        )
        filename = f"page-{page_number:06d}.json"
        key = f"receipts/{snapshot_rel.as_posix()}/{filename}"
        _write_immutable(receipts_root / snapshot_rel / filename, body)
        page_refs.append(
            {
                "page": page_number,
                "key": key,
                "sha256": hashlib.sha256(body).hexdigest(),
                "item_count": len(page_items),
            }
        )

    manifest = {
        "schema": 1,
        "lane": "novel",
        "snapshot_id": snapshot_id,
        "item_count": len(items),
        "page_size": _AVAILABILITY_PAGE_SIZE,
        "page_count": len(page_refs),
        "pages": page_refs,
    }
    manifest_body = _json_bytes(manifest)
    manifest_key = f"receipts/{snapshot_rel.as_posix()}/manifest.json"
    _write_immutable(receipts_root / snapshot_rel / "manifest.json", manifest_body)
    pointer = {
        "schema": 1,
        "lane": "novel",
        "snapshot_id": snapshot_id,
        "manifest_key": manifest_key,
        "manifest_sha256": hashlib.sha256(manifest_body).hexdigest(),
    }
    _write(receipts_root / "availability" / "novel" / "current.json", _json_bytes(pointer))
    return {"status": "published", "snapshot_id": snapshot_id, "item_count": len(items)}


def publish_lane(
    db_path: Path,
    object_root: Path,
    build_root: Path,
    receipts_root: Path,
    lane: str,
    *,
    remote: str = "r2text:redstm-text-archive",
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    """Publish immutable text artifacts, verify readback, then switch one pointer."""
    if remote != "r2text:redstm-text-archive":
        raise ValueError("text publisher remote is fixed to r2text:redstm-text-archive")
    with sqlite3.connect(db_path) as state_db:
        item_count = int(
            state_db.execute(
                "SELECT COUNT(*) FROM text_archive_items WHERE lane=?", (lane,)
            ).fetchone()[0]
        )
    if item_count == 0:
        return {"lane": lane, "item_count": 0, "status": "idle"}
    if item_count > (_MAX_NOVEL_ITEMS if lane == "novel" else _MAX_ARCALIVE_ITEMS):
        raise ValueError("text_publish_canary_cap_exceeded")
    metadata_updated = 0
    if lane == "arcalive":
        with operation_window():
            metadata_updated = _backfill_arcalive_metadata(db_path, object_root)
    with operation_window():
        pass
    if lane == "arcalive":
        with sqlite3.connect(db_path) as db:
            pending = db.execute(
                "SELECT 1 FROM text_archive_items i LEFT JOIN text_archive_publications p "
                "ON p.key='item:'||i.identity AND p.sha256=i.content_sha256 "
                "WHERE i.lane='arcalive' AND p.key IS NULL LIMIT 1"
            ).fetchone()
            pointer_hash = _published_hash(db, "published/arcalive/release.json")
        if pending is None and pointer_hash and not metadata_updated:
            with operation_window():
                pointer = _run(
                    [
                        "rclone",
                        "--config",
                        _RCLONE_CONFIG,
                        "cat",
                        f"{remote}/published/arcalive/release.json",
                    ],
                    runner,
                )
            if hashlib.sha256(pointer).hexdigest() == pointer_hash:
                _finalize_receipts(db_path, receipts_root)
                return {"lane": lane, "item_count": item_count, "status": "noop"}
    tree = build_publish_tree(db_path, object_root, build_root, lane)
    db = _connect(db_path)
    try:
        for key in tree["immutable_keys"]:
            local = build_root / key
            body = local.read_bytes()
            digest = hashlib.sha256(body).hexdigest()
            if _published_hash(db, key) == digest:
                continue
            with operation_window():
                _run(
                    ["rclone", "--config", _RCLONE_CONFIG, "copyto", str(local), f"{remote}/{key}"],
                    runner,
                )
            with operation_window():
                readback = _run(
                    ["rclone", "--config", _RCLONE_CONFIG, "cat", f"{remote}/{key}"],
                    runner,
                )
            if hashlib.sha256(readback).hexdigest() != digest:
                raise OSError(f"R2 readback mismatch: {key}")
            _record_publication(db_path, key, digest)
        pointer_path = Path(tree["pointer_path"])
        pointer_key = f"published/{lane}/release.json"
        pointer_body = pointer_path.read_bytes()
        pointer_hash = hashlib.sha256(pointer_body).hexdigest()
        with operation_window():
            _run(
                [
                    "rclone",
                    "--config",
                    _RCLONE_CONFIG,
                    "copyto",
                    str(pointer_path),
                    f"{remote}/{pointer_key}",
                ],
                runner,
            )
        with operation_window():
            pointer_readback = _run(
                ["rclone", "--config", _RCLONE_CONFIG, "cat", f"{remote}/{pointer_key}"],
                runner,
            )
        if hashlib.sha256(pointer_readback).hexdigest() != pointer_hash:
            raise OSError("release pointer readback mismatch")
        _record_publication(db_path, pointer_key, pointer_hash)
        with db:
            now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            for identity, content_sha256 in tree["items"]:
                db.execute(
                    "INSERT INTO text_archive_publications(key,sha256,verified_at) VALUES(?,?,?) "
                    "ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256, "
                    "verified_at=CASE WHEN text_archive_publications.sha256<>excluded.sha256 "
                    "THEN excluded.verified_at ELSE text_archive_publications.verified_at END",
                    (f"item:{identity}", content_sha256, now),
                )
    finally:
        db.close()
    _finalize_receipts(db_path, receipts_root)
    result = {
        "lane": lane,
        "item_count": tree["item_count"],
        "release_sha256": tree["release_sha256"],
    }
    if lane == "novel":
        result["availability"] = build_availability_snapshot(db_path, receipts_root)
    return result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Publish the independent text archive")
    parser.add_argument("lane", choices=("novel", "arcalive", "both"))
    args = parser.parse_args()
    lanes = ("novel", "arcalive") if args.lane == "both" else (args.lane,)
    results = []
    for lane in lanes:
        try:
            results.append(
                publish_lane(
                    Path("/srv/redstm-text/text-archive.sqlite"),
                    Path("/srv/redstm-text/objects"),
                    Path("/srv/redstm-text/build"),
                    Path("/srv/redstm-text-inbox/receipts"),
                    lane,
                )
            )
        except RuntimeWindowError as exc:
            parser.exit(75, f"text publish deferred: {exc}\n")
    print(json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    main()
