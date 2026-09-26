from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path
from typing import Any, TextIO

from crawler.collections import parse_title
from scripts.text_archive.importer import _chapter_key, _connect, _write_receipt, novel_text_sha256
from scripts.text_archive.recovery_metadata import metadata_fingerprint
from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_INDEX_PAGE_SIZE = 500
_RCLONE_CONFIG = "/etc/redstm-text/rclone.conf"
_RCLONE_TIMEOUT_S = 5 * 60
_AVAILABILITY_PAGE_SIZE = 500


def _chapter_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    """Same order as crawler.collections.parse_title, not import time."""
    parsed = parse_title(str(row.get("chapter_label") or ""))
    order = parsed.order_key or (9, 9, 9, 10**12, 10**12)
    identity = str(row.get("source_chapter_id") or row.get("canonical_chapter_id") or "")
    return (*order, parsed.base_key, identity)


def _latest_label(chapters: list[dict[str, Any]]) -> str:
    """Last numbered episode. A trailing prologue or epilogue is not the newest chapter."""
    for row in reversed(chapters):
        parsed = parse_title(str(row.get("chapter_label") or ""))
        if parsed.order_key is not None and parsed.order_key[2] == 1:
            return str(row.get("chapter_label") or "")
    return str(chapters[-1].get("chapter_label") or "") if chapters else ""


def _unique_novel_chapters(chapters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse only cross-source copies with the same label, kind, and exact body hash."""
    grouped: dict[tuple[tuple[str, str], str], list[dict[str, Any]]] = {}
    for row in chapters:
        key = (
            _chapter_key(str(row.get("chapter_label") or ""), str(row.get("chapter_kind") or "")),
            str(row.get("text_sha256") or row.get("content_sha256") or ""),
        )
        grouped.setdefault(key, []).append(row)

    result: list[dict[str, Any]] = []
    for rows in grouped.values():
        by_source: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_source.setdefault(str(row.get("source_site") or ""), []).append(row)
        if len(by_source) == 1:
            result.extend(rows)
            continue

        for source_rows in by_source.values():
            source_rows.sort(
                key=lambda row: (str(row.get("imported_at") or ""), str(row.get("identity") or ""))
            )
        for index in range(max(map(len, by_source.values()))):
            variants = [
                source_rows[index] for source_rows in by_source.values() if index < len(source_rows)
            ]
            representative = min(
                variants,
                key=lambda row: (
                    str(row.get("imported_at") or ""),
                    str(row.get("source_site") or ""),
                ),
            ).copy()
            representative["source_variants"] = [
                {
                    "source_site": str(row.get("source_site") or ""),
                    "source_chapter_id": str(row.get("source_chapter_id") or ""),
                    "source_url": str(row.get("source_url") or ""),
                }
                for row in variants
            ]
            result.append(representative)
    return result


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


def _share_availability(path: Path, receipts_root: Path) -> None:
    """Make snapshot paths readable to the inbox SFTP group, never writable by it."""
    if os.name != "posix":
        return
    read_group = receipts_root.stat().st_gid
    parent = path.parent
    while parent != receipts_root:
        if not parent.is_relative_to(receipts_root) or parent.is_symlink():
            raise OSError("availability path escaped receipts root")
        os.chown(parent, -1, read_group)  # type: ignore[attr-defined]  # POSIX-only branch
        parent.chmod(0o750)
        parent = parent.parent
    os.chown(path, -1, read_group)  # type: ignore[attr-defined]  # POSIX-only branch
    path.chmod(0o640)


def _indexed_file(root: Path, prefix: str, value: Any) -> tuple[str, bytes]:
    body = _json_bytes(value)
    digest = hashlib.sha256(body).hexdigest()
    key = f"published/indexes/{prefix}/{digest}.json"
    _write(root / key, body)
    return key, body


def _plan_rows(path: Path) -> Iterator[list[str]]:
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)


def _plan_write(stream: TextIO, *values: str) -> None:
    stream.write(json.dumps(values, ensure_ascii=False, separators=(",", ":")) + "\n")


def build_publish_tree(
    db_path: Path, object_root: Path, output_root: Path, lane: str
) -> dict[str, Any]:
    """Build deterministic, content-addressed artifacts without touching remote storage."""
    if lane not in {"novel", "arcalive"}:
        raise ValueError("lane must be novel or arcalive")
    output_root.mkdir(parents=True, exist_ok=True)
    plans = {
        kind: output_root / f".publish-{lane}-{kind}.jsonl"
        for kind in ("items", "objects", "indexes")
    }
    db = _connect(db_path)
    try:
        if lane == "novel":
            with db:
                for row in db.execute(
                    """SELECT identity,source_site,source_work_id,source_chapter_id,
                              content_sha256,object_key FROM text_archive_items
                       WHERE lane='novel' AND text_sha256 IS NULL"""
                ).fetchall():
                    body = (object_root / str(row["object_key"])).read_bytes()
                    if hashlib.sha256(body).hexdigest() != row["content_sha256"]:
                        raise ValueError(
                            f"local content object failed verification: {row['identity']}"
                        )
                    digest = novel_text_sha256(body)
                    db.execute(
                        "UPDATE text_archive_items SET text_sha256=? WHERE identity=?",
                        (digest, row["identity"]),
                    )
                    db.execute(
                        """UPDATE text_novel_chapters SET text_sha256=?
                           WHERE site=? AND source_work_id=? AND source_chapter_id=?""",
                        (
                            digest,
                            row["source_site"],
                            row["source_work_id"],
                            row["source_chapter_id"],
                        ),
                    )
        # Keep catalog, object and item passes on one imported snapshot in WAL mode.
        db.execute("BEGIN")
        item_count, generated_at = db.execute(
            "SELECT COUNT(*),COALESCE(MAX(imported_at),'1970-01-01T00:00:00Z') "
            "FROM text_archive_items WHERE lane=?",
            (lane,),
        ).fetchone()
        if not item_count:
            raise ValueError("no_publishable_items")
        with (
            plans["items"].open("w", encoding="utf-8", newline="\n") as item_plan,
            plans["objects"].open("w", encoding="utf-8", newline="\n") as object_plan,
            plans["indexes"].open("w", encoding="utf-8", newline="\n") as index_plan,
        ):
            catalog_refs: list[dict[str, str]] = []

            def page(items: list[dict[str, Any]]) -> None:
                key, body = _indexed_file(
                    output_root,
                    lane,
                    {"schema": 1, "lane": lane, "page": len(catalog_refs), "items": items},
                )
                digest = hashlib.sha256(body).hexdigest()
                catalog_refs.append({"key": key, "sha256": digest})
                _plan_write(index_plan, key, digest)

            if lane == "novel":
                catalog: list[dict[str, Any]] = []
                legacy_work_ids: dict[str, set[str]] = {}
                for source in db.execute(
                    "SELECT canonical_work_id,site,source_work_id "
                    "FROM text_novel_work_group_sources"
                ):
                    legacy_work_ids.setdefault(source["canonical_work_id"], set()).add(
                        f"novel:{source['site']}:{source['source_work_id']}"
                    )
                for alias in db.execute(
                    "SELECT canonical_work_id,alias_work_id FROM text_novel_work_aliases"
                ):
                    legacy_work_ids.setdefault(alias["canonical_work_id"], set()).add(
                        str(alias["alias_work_id"])
                    )
                rows = db.execute(
                    "SELECT * FROM text_archive_items WHERE lane=? "
                    "ORDER BY canonical_work_id,imported_at,identity",
                    (lane,),
                )
                for work_id, work_rows in groupby(
                    rows, key=lambda row: str(row["canonical_work_id"])
                ):
                    chapters = _unique_novel_chapters([dict(row) for row in work_rows])
                    first = chapters[0]
                    chapters.sort(key=_chapter_sort_key)
                    work = {
                        "work_id": work_id,
                        "source_site": first["source_site"],
                        "source_work_id": first["source_work_id"],
                        "title": first["title"],
                        "author": first["author"],
                        "chapter_count": len(chapters),
                        "latest_label": _latest_label(chapters),
                        "last_imported_at": max(str(row["imported_at"]) for row in chapters),
                        "legacy_work_ids": sorted(
                            alias
                            for alias in legacy_work_ids.get(work_id, set())
                            if alias != work_id
                        ),
                    }
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
                                "source_variants": row.get("source_variants", []),
                            }
                            for row in chapters
                        ],
                    }
                    work["detail_key"], body = _indexed_file(output_root, "novel", detail)
                    _plan_write(
                        index_plan, str(work["detail_key"]), hashlib.sha256(body).hexdigest()
                    )
                    catalog.append(work)
                catalog.sort(key=lambda item: (item["title"].casefold(), item["work_id"]))
                for offset in range(0, len(catalog), _INDEX_PAGE_SIZE):
                    page(catalog[offset : offset + _INDEX_PAGE_SIZE])
                work_count = len(catalog)
            else:
                page_items: list[dict[str, Any]] = []
                for row in db.execute(
                    "SELECT * FROM text_archive_items WHERE lane=? ORDER BY imported_at,identity",
                    (lane,),
                ):
                    page_items.append(
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
                    )
                    if len(page_items) == _INDEX_PAGE_SIZE:
                        page(page_items)
                        page_items = []
                if page_items:
                    page(page_items)
                work_count = 0

            release_body = _json_bytes(
                {
                    "schema": 1,
                    "lane": lane,
                    "generated_at": generated_at,
                    "item_count": item_count,
                    "work_count": work_count,
                    "catalog_pages": catalog_refs,
                }
            )
            release_sha = hashlib.sha256(release_body).hexdigest()
            release_key = f"published/releases/{lane}/{release_sha}.json"
            _write(output_root / release_key, release_body)
            _plan_write(index_plan, release_key, release_sha)
            pointer = _json_bytes(
                {"schema": 1, "lane": lane, "release_key": release_key, "sha256": release_sha}
            )
            pointer_path = output_root / f"published/{lane}/release.json"
            _write(pointer_path, pointer)

            for row in db.execute(
                "SELECT identity,content_sha256 FROM text_archive_items "
                "WHERE lane=? ORDER BY imported_at,identity",
                (lane,),
            ):
                _plan_write(item_plan, row["identity"], row["content_sha256"])
            for row in db.execute(
                "SELECT DISTINCT content_sha256,bytes,object_key "
                "FROM text_archive_items WHERE lane=?",
                (lane,),
            ):
                digest = row["content_sha256"]
                target_key = f"published/objects/sha256/{digest[:2]}/{digest}.md"
                _plan_write(object_plan, target_key, digest, row["object_key"], str(row["bytes"]))
            for stream in (item_plan, object_plan, index_plan):
                stream.flush()
                os.fsync(stream.fileno())
        db.execute("COMMIT")
        for target_key, digest, source_key, size in _plan_rows(plans["objects"]):
            target = output_root / target_key
            if target.is_file() and not target.is_symlink() and target.stat().st_size == int(size):
                if hashlib.sha256(target.read_bytes()).hexdigest() == digest:
                    continue
            body = (object_root / source_key).read_bytes()
            if len(body) != int(size) or hashlib.sha256(body).hexdigest() != digest:
                raise ValueError(f"local content object failed verification: {digest}")
            _write_immutable(output_root / target_key, body)
        return {
            "lane": lane,
            "item_count": item_count,
            "item_plan": plans["items"],
            "object_plan": plans["objects"],
            "index_plan": plans["indexes"],
            "release_key": release_key,
            "release_sha256": release_sha,
            "pointer_path": pointer_path,
        }
    finally:
        db.close()


def _run(argv: list[str], runner: Any) -> bytes:
    result = runner(
        argv,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=_RCLONE_TIMEOUT_S,
    )
    output = result.stdout
    return output if isinstance(output, bytes) else str(output).encode()


def _publish_object_batch(
    build_root: Path,
    remote: str,
    objects: list[tuple[str, str]],
    runner: Any,
) -> None:
    """Transfer a small immutable group, then SHA-256-check every R2 body."""
    source = build_root / "published/objects/sha256"
    names = [key.removeprefix("published/objects/sha256/") for key, _ in objects]
    selection = build_root / "pending-objects.txt"
    checksums = build_root / "pending-objects.sha256"
    _write(selection, ("\n".join(names) + "\n").encode())
    _write(
        checksums,
        ("".join(f"{digest}  {name}\n" for name, (_, digest) in zip(names, objects))).encode(),
    )
    destination = f"{remote}/published/objects/sha256"
    with operation_window(lock_wait_seconds=30):
        _run(
            [
                "rclone",
                "--config",
                _RCLONE_CONFIG,
                "copy",
                str(source),
                destination,
                "--files-from-raw",
                str(selection),
                "--ignore-times",
                "--transfers",
                "2",
                "--checkers",
                "2",
                "--contimeout", "10s", "--timeout", "60s",
                "--retries", "1", "--low-level-retries", "2",
            ],
            runner,
        )
    try:
        with operation_window(lock_wait_seconds=30):
            _run(
                [
                    "rclone",
                    "--config",
                    _RCLONE_CONFIG,
                    "hashsum",
                    "SHA256",
                    destination,
                    "--download",
                    "--checkfile",
                    str(checksums),
                    "--files-from-raw",
                    str(selection),
                    "--checkers",
                    "2",
                    "--contimeout", "10s", "--timeout", "60s",
                    "--retries", "1", "--low-level-retries", "2",
                ],
                runner,
            )
    except subprocess.CalledProcessError as exc:
        raise OSError("R2 readback mismatch for object batch") from exc


def _record_publication(db_path: Path, key: str, digest: str) -> None:
    verified_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    with closing(sqlite3.connect(db_path)) as db, db:
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
        last_id = ""
        while True:
            batches = db.execute(
                "SELECT batch_id,receipt_json FROM text_archive_batches "
                "WHERE revision=1 AND batch_id>? ORDER BY batch_id LIMIT 100",
                (last_id,),
            ).fetchall()
            if not batches:
                break
            for batch in batches:
                receipt = json.loads(batch["receipt_json"])
                eligible = [
                    item
                    for item in receipt["items"]
                    if item.get("status") in {"accepted", "duplicate"}
                ]
                if not eligible:
                    continue
                keys = [f"item:{item['identity']}" for item in eligible]
                placeholders = ",".join("?" for _ in keys)
                publications = {
                    str(row["key"]): row
                    for row in db.execute(
                        "SELECT key,sha256,verified_at FROM text_archive_publications "
                        f"WHERE key IN ({placeholders})",
                        keys,
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
                encoded = json.dumps(
                    receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                _write_receipt(receipts_root, str(batch["batch_id"]), receipt)
                with db:
                    db.execute(
                        "UPDATE text_archive_batches SET revision=2,receipt_json=? "
                        "WHERE batch_id=? AND revision=1",
                        (encoded, batch["batch_id"]),
                    )
            last_id = str(batches[-1]["batch_id"])
    finally:
        db.close()


def build_availability_snapshot(db_path: Path, receipts_root: Path) -> dict[str, Any]:
    """Write a content-addressed, paged snapshot of novel items verified in R2."""
    db = _connect(db_path)
    try:
        # Both passes must see the same rows while imports continue in WAL mode.
        db.execute("BEGIN")
        group_sources: dict[str, list[str]] = {}
        for source in db.execute(
            "SELECT canonical_work_id,site,source_work_id FROM text_novel_work_group_sources"
        ):
            group_sources.setdefault(source["canonical_work_id"], []).append(
                f"{source['site']}:{source['source_work_id']}"
            )

        def items() -> Iterator[dict[str, Any]]:
            for row in db.execute(
                """SELECT i.*,p.verified_at FROM text_archive_items i
                   JOIN text_archive_publications p
                     ON p.key='item:'||i.identity AND p.sha256=i.content_sha256
                   WHERE i.lane='novel' ORDER BY i.identity"""
            ):
                yield {
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

        digest = hashlib.sha256()
        digest.update(b"[")
        count = 0
        for item in items():
            if count:
                digest.update(b",")
            digest.update(_json_bytes(item).rstrip(b"\n"))
            count += 1
        if not count:
            return {"status": "idle", "item_count": 0}
        digest.update(b"]\n")
        snapshot_id = digest.hexdigest()
        snapshot_rel = Path("availability") / "novel" / "snapshots" / snapshot_id
        page_refs: list[dict[str, Any]] = []

        def write_page(page_items: list[dict[str, Any]]) -> None:
            page_number = len(page_refs)
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
            _share_availability(receipts_root / snapshot_rel / filename, receipts_root)
            page_refs.append(
                {
                    "page": page_number,
                    "key": key,
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "item_count": len(page_items),
                }
            )

        page_items: list[dict[str, Any]] = []
        for item in items():
            page_items.append(item)
            if len(page_items) == _AVAILABILITY_PAGE_SIZE:
                write_page(page_items)
                page_items = []
        if page_items:
            write_page(page_items)

        manifest = {
            "schema": 1,
            "lane": "novel",
            "snapshot_id": snapshot_id,
            "item_count": count,
            "page_size": _AVAILABILITY_PAGE_SIZE,
            "page_count": len(page_refs),
            "pages": page_refs,
        }
        manifest_body = _json_bytes(manifest)
        manifest_key = f"receipts/{snapshot_rel.as_posix()}/manifest.json"
        _write_immutable(receipts_root / snapshot_rel / "manifest.json", manifest_body)
        _share_availability(receipts_root / snapshot_rel / "manifest.json", receipts_root)
        pointer = {
            "schema": 1,
            "lane": "novel",
            "snapshot_id": snapshot_id,
            "manifest_key": manifest_key,
            "manifest_sha256": hashlib.sha256(manifest_body).hexdigest(),
        }
        _write(receipts_root / "availability" / "novel" / "current.json", _json_bytes(pointer))
        _share_availability(
            receipts_root / "availability" / "novel" / "current.json", receipts_root
        )
        return {"status": "published", "snapshot_id": snapshot_id, "item_count": count}
    finally:
        db.close()


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
    metadata_key = f"metadata:{lane}"
    metadata_updated = 0
    if lane == "arcalive":
        with operation_window(lock_wait_seconds=30):
            metadata_updated = _backfill_arcalive_metadata(db_path, object_root)
    metadata_digest = metadata_fingerprint(db_path, lane)
    with operation_window(lock_wait_seconds=30):
        pass
    if lane in {"arcalive", "novel"} and not (lane == "arcalive" and metadata_updated):
        with sqlite3.connect(db_path) as db:
            pending = db.execute(
                "SELECT 1 FROM text_archive_items i LEFT JOIN text_archive_publications p "
                "ON p.key='item:'||i.identity AND p.sha256=i.content_sha256 "
                "WHERE i.lane=? AND p.key IS NULL LIMIT 1",
                (lane,),
            ).fetchone()
            pointer_hash = _published_hash(db, f"published/{lane}/release.json")
            metadata_matches = _published_hash(db, metadata_key) == metadata_digest
        if pending is None and pointer_hash and not metadata_updated and metadata_matches:
            with operation_window(lock_wait_seconds=30):
                pointer = _run(
                    [
                        "rclone",
                        "--config",
                        _RCLONE_CONFIG,
                        "cat",
                        f"{remote}/published/{lane}/release.json",
                    ],
                    runner,
                )
            if hashlib.sha256(pointer).hexdigest() == pointer_hash:
                _finalize_receipts(db_path, receipts_root)
                result = {"lane": lane, "item_count": item_count, "status": "noop"}
                if lane == "novel":
                    result["availability"] = build_availability_snapshot(db_path, receipts_root)
                return result
    tree = build_publish_tree(db_path, object_root, build_root, lane)
    db = _connect(db_path)
    try:
        pending_objects: list[tuple[str, str]] = []

        def publish_batch() -> None:
            if pending_objects:
                batch = pending_objects[:]
                _publish_object_batch(build_root, remote, batch, runner)
                for key, digest in batch:
                    _record_publication(db_path, key, digest)
                pending_objects.clear()

        for key, digest, *_ in _plan_rows(Path(tree["object_plan"])):
            if _published_hash(db, key) != digest:
                pending_objects.append((key, digest))
                if len(pending_objects) == 8:
                    publish_batch()
        if len(pending_objects) > 1:
            publish_batch()

        for plan in ("object_plan", "index_plan"):
            for row in _plan_rows(Path(tree[plan])):
                key, digest = row[:2]
                if _published_hash(db, key) == digest:
                    continue
                local = build_root / key
                body = local.read_bytes()
                if hashlib.sha256(body).hexdigest() != digest:
                    raise ValueError(f"local publish file failed verification: {key}")
                with operation_window(lock_wait_seconds=30):
                    _run(
                        [
                            "rclone",
                            "--config",
                            _RCLONE_CONFIG,
                            "copyto",
                            str(local),
                            f"{remote}/{key}",
                        ],
                        runner,
                    )
                with operation_window(lock_wait_seconds=30):
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
        with operation_window(lock_wait_seconds=30):
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
        with operation_window(lock_wait_seconds=30):
            pointer_readback = _run(
                ["rclone", "--config", _RCLONE_CONFIG, "cat", f"{remote}/{pointer_key}"],
                runner,
            )
        if hashlib.sha256(pointer_readback).hexdigest() != pointer_hash:
            raise OSError("release pointer readback mismatch")
        _record_publication(db_path, pointer_key, pointer_hash)
        _record_publication(db_path, metadata_key, metadata_digest)
        with db:
            now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            for identity, content_sha256 in _plan_rows(Path(tree["item_plan"])):
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
