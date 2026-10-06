from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import closing
from datetime import UTC, datetime
from decimal import Decimal
from itertools import groupby
from pathlib import Path
from typing import Any, TextIO

from crawler.collections import (
    PostTitle,
    display_collection_title,
    parse_title,
    preview_collections,
)
from scripts.text_archive.importer import (
    _chapter_key,
    _connect,
    _write_receipt,
    arcalive_header,
    normalize_chapter_kind,
    novel_text_sha256,
)
from scripts.text_archive.recovery_metadata import metadata_fingerprint
from scripts.text_archive.runtime import RuntimeWindowError, operation_window
from scripts.text_archive.status import publish_status, write_pc_state

_INDEX_PAGE_SIZE = 500
_RCLONE_CONFIG = "/etc/redstm-text/rclone.conf"
_RCLONE_TIMEOUT_S = 5 * 60
_AVAILABILITY_PAGE_SIZE = 500
# Release manifests kept per lane besides the active one; older unreferenced indexes are pruned.
_RELEASE_RETENTION = 5
# Remote keys deleted per publish so a backlog never holds the run past its rclone timeout.
_PRUNE_BATCH_LIMIT = 500
# A pruned key's ledger row carries this until R2 confirms the delete, so it is never
# mistaken for a verified upload and is retried by the next prune.
_PRUNING = "pruning"
_PRUNABLE_KEY = r"published/(?:releases|indexes)/{lane}/[a-f0-9]{{64}}\.json"


def _window() -> Any:
    """One exclusive heavy text step (runtime.operation_window); publishing needs ~150 MiB."""
    return operation_window(lock_wait_seconds=30, exclusive=True, need_bytes=150 * 1024 * 1024)


def _network_window() -> Any:
    """Remote I/O must not hold the importer/collector's local mutation lock."""
    return operation_window(lock_wait_seconds=30, need_bytes=150 * 1024 * 1024)


def _check_headroom(headroom: Callable[[], None] | None) -> None:
    if headroom is not None:
        headroom()


def _chapter_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    """Source episode numbers outrank labels and import time."""
    parsed = parse_title(str(row.get("chapter_label") or ""))
    order = parsed.order_key or (9, 9, 9, 10**12, 10**12)
    if row.get("source_episode_number_normalized") is not None:
        number = Decimal(str(row["source_episode_number_normalized"]))
        order = (
            order[0] if parsed.order_key else 0,
            order[1] if parsed.order_key else 0,
            order[2] if parsed.order_key else 1,
            number,
            number,
        )
    identity = str(row.get("source_chapter_id") or row.get("canonical_chapter_id") or "")
    return (*order, parsed.base_key, identity)


def _latest_label(chapters: list[dict[str, Any]]) -> str:
    """Last numbered episode. A trailing prologue or epilogue is not the newest chapter."""
    for row in reversed(chapters):
        parsed = parse_title(str(row.get("chapter_label") or ""))
        if (
            row.get("source_episode_number_normalized") is not None
            and row.get("chapter_kind") == "main"
            and (parsed.order_key is None or parsed.order_key[2] == 1)
        ):
            return str(row.get("chapter_label") or "")
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
                    "source_work_id": str(row.get("source_work_id") or ""),
                    "source_chapter_id": str(row.get("source_chapter_id") or ""),
                    "source_url": str(row.get("source_url") or ""),
                }
                for row in variants
            ]
            result.append(representative)
    return result


def _chapter_aliases(row: dict[str, Any]) -> list[str]:
    variants = [row, *row.get("source_variants", [])]
    aliases = {str(row.get("identity") or ""), str(row.get("canonical_chapter_id") or "")}
    for variant in variants:
        site = str(variant.get("source_site") or "")
        work = str(variant.get("source_work_id") or "")
        chapter = str(variant.get("source_chapter_id") or "")
        if site and work and chapter:
            aliases.update(
                (f"novel:{site}:{work}:{chapter}", f"novel_chapter:{site}:{work}:{chapter}")
            )
    aliases.discard("")
    return sorted(aliases)


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


def _write_content_addressed(path: Path, body: bytes) -> None:
    """Reuse verified artifacts; rebuild a damaged derived index from the current body."""
    if path.is_file() and not path.is_symlink() and path.stat().st_size == len(body):
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").digest() == hashlib.sha256(body).digest():
                return
    _write(path, body)


def _indexed_file(root: Path, prefix: str, value: Any) -> tuple[str, bytes]:
    body = _json_bytes(value)
    digest = hashlib.sha256(body).hexdigest()
    key = f"published/indexes/{prefix}/{digest}.json"
    _write_content_addressed(root / key, body)
    return key, body


def _plan_rows(path: Path) -> Iterator[list[str]]:
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)


def _plan_write(stream: TextIO, *values: str) -> None:
    stream.write(json.dumps(values, ensure_ascii=False, separators=(",", ":")) + "\n")


def _arcalive_works(rows: list[dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    by_post = {
        (str(row["source_board"]), str(row["source_category"]), int(row["source_post_id"])): row
        for row in rows
        if row["content_lane"] == "text"
    }
    preview = preview_collections(
        PostTitle(
            json.dumps([row["source_board"], row["source_category"]], ensure_ascii=False),
            int(row["source_post_id"]),
            str(row["title"]),
            str(row["author"]),
            str(row["imported_at"]),
        )
        for row in by_post.values()
    )
    works = []
    for group in preview.groups:
        if any(not post.author or not post.author.strip() for post in group.posts):
            continue
        board, category = json.loads(group.board_id)
        chapters = [by_post[board, category, post.external_post_id] for post in group.posts]
        author = str(chapters[0]["author"])
        work_id = (
            "arcalive:"
            + hashlib.sha256(
                _json_bytes([board, category, group.base_key, author.casefold()])
            ).hexdigest()[:24]
        )
        work = {
            "work_id": work_id,
            "title": display_collection_title(group),
            "author": author,
            "board": board,
            "category": category,
            "chapter_count": len(chapters),
            "last_imported_at": max(str(row["imported_at"]) for row in chapters),
            # Reading order; the Reader counts read chapters per work from these
            # (identity = arcalive:<board>:<post_id>:text) without loading every detail.
            "post_ids": [int(row["source_post_id"]) for row in chapters],
        }
        detail = {
            "schema": 1,
            "lane": "arcalive",
            "work": {"work_id": work_id, "title": work["title"], "author": author},
            "chapters": [
                {
                    "identity": row["identity"],
                    "title": row["title"],
                    "label": row["title"],
                    "board": board,
                    "category": category,
                    "post_id": row["source_post_id"],
                    "sha256": row["content_sha256"],
                    "author": row["author"],
                    "content_lane": row["content_lane"],
                    "reading_order": position,
                }
                for position, row in enumerate(chapters)
            ],
        }
        works.append((work, detail))
    return sorted(works, key=lambda pair: (pair[0]["title"], pair[0]["work_id"]))


def build_publish_tree(
    db_path: Path,
    object_root: Path,
    output_root: Path,
    lane: str,
    *,
    headroom: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Build deterministic, content-addressed artifacts without touching remote storage."""
    if lane not in {"novel", "arcalive", "manual"}:
        raise ValueError("lane must be novel, arcalive or manual")
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
        # Headroom is rechecked around this read so a TypeMoon unit that became active
        # after the preflight stops the local build without holding the publish lock.
        _check_headroom(headroom)
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
            work_catalog_refs: list[dict[str, str]] = []

            def page(items: list[dict[str, Any]]) -> None:
                _check_headroom(headroom)
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
                    """SELECT i.*,c.chapter_label AS current_chapter_label,
                              c.chapter_kind AS current_chapter_kind,c.source_episode_number_raw,
                              c.source_episode_number_normalized,c.source_toc_position,
                              c.source_published_at
                       FROM text_archive_items i LEFT JOIN text_novel_chapters c
                         ON c.site=i.source_site AND c.source_work_id=i.source_work_id
                         AND c.source_chapter_id=i.source_chapter_id
                       WHERE i.lane=? ORDER BY i.canonical_work_id,i.imported_at,i.identity""",
                    (lane,),
                )
                seen_works = 0
                for work_id, work_rows in groupby(
                    rows, key=lambda row: str(row["canonical_work_id"])
                ):
                    seen_works += 1
                    if seen_works % 50 == 0:
                        _check_headroom(headroom)
                    chapters = _unique_novel_chapters(
                        [
                            {
                                **dict(row),
                                "chapter_label": row["current_chapter_label"]
                                or row["chapter_label"],
                                "chapter_kind": row["current_chapter_kind"] or row["chapter_kind"],
                            }
                            for row in work_rows
                        ]
                    )
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
                                "legacy_chapter_ids": _chapter_aliases(row),
                                "reading_order": position,
                                "label": row["chapter_label"],
                                "kind": row["chapter_kind"],
                                "source_episode_number_raw": row["source_episode_number_raw"],
                                "source_episode_number": row["source_episode_number_normalized"],
                                "source_toc_position": row["source_toc_position"],
                                "source_published_at": row["source_published_at"],
                                "source_site": row["source_site"],
                                "source_chapter_id": row["source_chapter_id"],
                                "source_url": row["source_url"],
                                "sha256": row["content_sha256"],
                                "source_variants": row.get("source_variants", []),
                            }
                            for position, row in enumerate(chapters)
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
            elif lane == "manual":
                page_items: list[dict[str, Any]] = []
                for row in db.execute(
                    """SELECT i.identity,i.title,i.content_sha256,i.bytes,m.created_at,m.folder
                       FROM text_archive_items i JOIN text_manual_documents m USING(identity)
                       WHERE i.lane='manual' ORDER BY m.folder,i.title,i.identity"""
                ):
                    page_items.append(
                        {
                            "identity": row["identity"],
                            "title": row["title"],
                            "sha256": row["content_sha256"],
                            "bytes": row["bytes"],
                            "created_at": row["created_at"],
                            "category": row["folder"],
                            "board": "수동 문서",
                        }
                    )
                    if len(page_items) == _INDEX_PAGE_SIZE:
                        page(page_items)
                        page_items = []
                if page_items:
                    page(page_items)
                work_count = 0
            else:
                page_items = []
                source_rows: list[dict[str, Any]] = []
                # Only the columns the pages and works use: the whole lane (25k+ rows) is held
                # at once inside the unit's 150 MiB cgroup.
                for row in db.execute(
                    """SELECT identity,source_board,source_post_id,source_category,title,author,
                              content_lane,content_sha256,bytes,imported_at
                       FROM text_archive_items WHERE lane=? ORDER BY imported_at,identity""",
                    (lane,),
                ):
                    source_rows.append(dict(row))
                    page_items.append(
                        {
                            "identity": row["identity"],
                            "board": row["source_board"],
                            "post_id": row["source_post_id"],
                            "category": row["source_category"],
                            "title": row["title"],
                            "author": row["author"],
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
                works = _arcalive_works(source_rows)
                for work, detail in works:
                    work["detail_key"], body = _indexed_file(output_root, lane, detail)
                    _plan_write(index_plan, work["detail_key"], hashlib.sha256(body).hexdigest())
                for offset in range(0, len(works), _INDEX_PAGE_SIZE):
                    key, body = _indexed_file(
                        output_root,
                        lane,
                        {
                            "schema": 1,
                            "lane": lane,
                            "view": "works",
                            "page": len(work_catalog_refs),
                            "items": [
                                work for work, _ in works[offset : offset + _INDEX_PAGE_SIZE]
                            ],
                        },
                    )
                    digest = hashlib.sha256(body).hexdigest()
                    work_catalog_refs.append({"key": key, "sha256": digest})
                    _plan_write(index_plan, key, digest)
                work_count = len(works)

            release_body = _json_bytes(
                {
                    "schema": 1,
                    "lane": lane,
                    "generated_at": generated_at,
                    "item_count": item_count,
                    "work_count": work_count,
                    "catalog_pages": catalog_refs,
                    **({"work_catalog_pages": work_catalog_refs} if lane == "arcalive" else {}),
                }
            )
            release_sha = hashlib.sha256(release_body).hexdigest()
            release_key = f"published/releases/{lane}/{release_sha}.json"
            _write_content_addressed(output_root / release_key, release_body)
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
        _check_headroom(headroom)
        # Objects upload straight from the content-addressed store, which already has the
        # published layout under objects/sha256/. Only objects not yet verified in R2 are read.
        for target_key, digest, source_key, size in _plan_rows(plans["objects"]):
            if source_key != target_key.removeprefix("published/"):
                raise ValueError(f"local content object is not content-addressed: {digest}")
            if _published_hash(db, target_key) == digest:
                continue
            body = (object_root / source_key).read_bytes()
            if len(body) != int(size) or hashlib.sha256(body).hexdigest() != digest:
                raise ValueError(f"local content object failed verification: {digest}")
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
    object_root: Path,
    remote: str,
    objects: list[tuple[str, str]],
    runner: Any,
) -> None:
    """Transfer a small immutable group, then SHA-256-check every R2 body."""
    source = object_root / "objects/sha256"
    names = [key.removeprefix("published/objects/sha256/") for key, _ in objects]
    selection = build_root / "pending-objects.txt"
    checksums = build_root / "pending-objects.sha256"
    _write(selection, ("\n".join(names) + "\n").encode())
    _write(
        checksums,
        ("".join(f"{digest}  {name}\n" for name, (_, digest) in zip(names, objects))).encode(),
    )
    destination = f"{remote}/published/objects/sha256"
    with _network_window():
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
                # Upload the listed keys without listing the bucket (a Class A op per page).
                "--no-traverse",
                "--transfers",
                "2",
                "--checkers",
                "2",
                "--contimeout",
                "10s",
                "--timeout",
                "60s",
                "--retries",
                "1",
                "--low-level-retries",
                "2",
            ],
            runner,
        )
    try:
        with _network_window():
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
                    "--contimeout",
                    "10s",
                    "--timeout",
                    "60s",
                    "--retries",
                    "1",
                    "--low-level-retries",
                    "2",
                ],
                runner,
            )
    except subprocess.CalledProcessError as exc:
        raise OSError("R2 readback mismatch for object batch") from exc


def _record_publication(db_path: Path, key: str, digest: str) -> None:
    verified_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    with closing(sqlite3.connect(db_path, timeout=30)) as db, db:
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


def _retained_keys(db_path: Path, build_root: Path, lane: str, active_release: str) -> set[str]:
    """Active release, the newest verified releases, and every index they reference."""
    with closing(sqlite3.connect(db_path, timeout=30)) as db:
        recent = [
            str(row[0])
            for row in db.execute(
                "SELECT key FROM text_archive_publications WHERE key LIKE ? AND sha256<>? "
                "ORDER BY verified_at DESC, rowid DESC LIMIT ?",
                (f"published/releases/{lane}/%", _PRUNING, _RELEASE_RETENTION),
            )
        ]
    keep: set[str] = set()
    for release_key in dict.fromkeys([active_release, *recent]):
        # A kept release whose local copy is gone cannot be walked; the caller then skips pruning.
        release = json.loads((build_root / release_key).read_bytes())
        keep.add(release_key)
        for ref in [*release["catalog_pages"], *release.get("work_catalog_pages", [])]:
            page_key = str(ref["key"])
            if page_key in keep:
                continue
            keep.add(page_key)
            page = json.loads((build_root / page_key).read_bytes())
            keep.update(str(item["detail_key"]) for item in page["items"] if "detail_key" in item)
    return keep


def _prune_lane(
    db_path: Path, build_root: Path, lane: str, active_release: str, remote: str, runner: Any
) -> dict[str, Any]:
    """Drop superseded releases and indexes locally and in R2. Content objects are never pruned."""
    pattern = re.compile(_PRUNABLE_KEY.format(lane=lane))
    keep = _retained_keys(db_path, build_root, lane, active_release)
    local_removed = 0
    for directory in ("releases", "indexes"):
        for path in (build_root / "published" / directory / lane).glob("*.json"):
            key = path.relative_to(build_root).as_posix()
            if pattern.fullmatch(key) and key not in keep:
                path.unlink(missing_ok=True)
                local_removed += 1
    with closing(sqlite3.connect(db_path, timeout=30)) as db, db:
        candidates = [
            str(row[0])
            for row in db.execute(
                "SELECT key FROM text_archive_publications "
                "WHERE key LIKE 'published/releases/' || ? || '/%' "
                "OR key LIKE 'published/indexes/' || ? || '/%' ORDER BY rowid",
                (lane, lane),
            )
            if pattern.fullmatch(str(row[0])) and str(row[0]) not in keep
        ]
        batch = candidates[:_PRUNE_BATCH_LIMIT]
        # Unclaim first: if the delete dies halfway, a later release re-uploads the key.
        db.executemany(
            "UPDATE text_archive_publications SET sha256=? WHERE key=?",
            [(_PRUNING, key) for key in batch],
        )
    result: dict[str, Any] = {
        "status": "pruned",
        "kept_keys": len(keep),
        "local_removed": local_removed,
        "remote_removed": 0,
        "remote_pending": len(candidates) - len(batch),
    }
    if not batch:
        return result
    selection = build_root / f"pending-prune-{lane}.txt"
    _write(selection, ("\n".join(key.removeprefix("published/") for key in batch) + "\n").encode())
    try:
        with _network_window():
            _run(
                [
                    "rclone",
                    "--config",
                    _RCLONE_CONFIG,
                    "delete",
                    f"{remote}/published",
                    "--files-from-raw",
                    str(selection),
                    "--checkers",
                    "2",
                    "--contimeout",
                    "10s",
                    "--timeout",
                    "60s",
                    "--retries",
                    "1",
                    "--low-level-retries",
                    "2",
                ],
                runner,
            )
    finally:
        selection.unlink(missing_ok=True)
    with closing(sqlite3.connect(db_path, timeout=30)) as db, db:
        db.executemany(
            "DELETE FROM text_archive_publications WHERE key=? AND sha256=?",
            [(key, _PRUNING) for key in batch],
        )
    result["remote_removed"] = len(batch)
    return result


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
                title, category, author = arcalive_header(body)
                # category is optional in the import manifest and headers are not checked at
                # import, so a header without one files the post as 미분류 instead of stopping
                # every later Arcalive publish.
                if category is None or category in {"", "-"}:
                    category = "미분류"
                db.execute(
                    """UPDATE text_archive_items SET
                       title=CASE WHEN ?='' THEN title ELSE ? END,source_category=?,
                       author=CASE WHEN author='' THEN ? ELSE author END WHERE identity=?""",
                    (title[:500], title[:500], category[:500], author[:500], row["identity"]),
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
                # A batch whose every item was rejected or held has nothing to publish: its
                # receipt is already final. Skipping it left it at revision 1 forever, so the PC
                # waited on it (Newtomi feedback 2026-10-04). Items keep their own statuses.
                # ("" only keeps the IN list valid when there is no eligible item.)
                keys = [f"item:{item['identity']}" for item in eligible] or [""]
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


# Every publish with changed novels writes a new paged snapshot; the PC only needs the current
# one (and may still be reading the previous one), so older snapshots go after a day.
_SNAPSHOT_KEEP = 3
_SNAPSHOT_MIN_AGE_SECONDS = 24 * 60 * 60
# Receipts of batches the PC already removed from the drop are no longer read.
_RECEIPT_KEEP_SECONDS = 60 * 24 * 60 * 60


def prune_availability_snapshots(
    receipts_root: Path, *, keep_id: str, now: float | None = None
) -> int:
    root = receipts_root / "availability" / "novel" / "snapshots"
    if not root.is_dir():
        return 0
    current = time.time() if now is None else now
    snapshots = sorted(
        (path for path in root.iterdir() if path.is_dir() and not path.is_symlink()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    removed = 0
    for index, path in enumerate(snapshots):
        if path.name == keep_id or index < _SNAPSHOT_KEEP:
            continue
        if current - path.stat().st_mtime < _SNAPSHOT_MIN_AGE_SECONDS:
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed += 1
    return removed


def prune_receipts(receipts_root: Path, drop_root: Path, *, now: float | None = None) -> int:
    """Remove old batch receipts whose batch is gone from the drop."""
    if not receipts_root.is_dir():
        return 0
    current = time.time() if now is None else now
    removed = 0
    for path in receipts_root.glob("*.json"):
        batch = path.name.removesuffix(".status.json").removesuffix(".json")
        try:
            old = current - path.stat().st_mtime > _RECEIPT_KEEP_SECONDS
        except OSError:
            continue
        if old and not (drop_root / batch).exists():
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def build_availability_snapshot(
    db_path: Path,
    receipts_root: Path,
    *,
    headroom: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Write a content-addressed, paged snapshot of novel items verified in R2."""
    _check_headroom(headroom)
    db = _connect(db_path, read_only=True)
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
                   WHERE i.lane='novel' AND i.access='free' ORDER BY i.identity"""
            ):
                # Newtomi rejects a whole snapshot on an item outside its contract
                # (access "free", kind "main"/"side"), so older rows are normalized here.
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
                    "chapter_kind": normalize_chapter_kind(
                        row["chapter_kind"], str(row["chapter_label"] or "")
                    ),
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
            _check_headroom(headroom)
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
        pruned = prune_availability_snapshots(receipts_root, keep_id=snapshot_id)
        return {
            "status": "published",
            "snapshot_id": snapshot_id,
            "item_count": count,
            "pruned_snapshots": pruned,
        }
    finally:
        db.close()


def _availability_or_defer(
    db_path: Path,
    receipts_root: Path,
    headroom: Callable[[], None],
) -> dict[str, Any]:
    """A TypeMoon window during the snapshot defers that document only."""
    try:
        return build_availability_snapshot(db_path, receipts_root, headroom=headroom)
    except RuntimeWindowError as exc:
        return {"status": "deferred", "error": f"{type(exc).__name__}: {exc}"[:300]}


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

    def headroom() -> None:
        with _window():
            pass

    with closing(sqlite3.connect(db_path, timeout=30)) as state_db, state_db:
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
        with _window():
            metadata_updated = _backfill_arcalive_metadata(db_path, object_root)
    metadata_digest = metadata_fingerprint(db_path, lane)
    if lane == "arcalive":
        metadata_digest = hashlib.sha256(
            f"arcalive-works-v1:{metadata_digest}".encode()
        ).hexdigest()
    # Pre-flight, then the catalog build rechecks between pages without holding the lock
    # while it writes local files. A TypeMoon unit that starts mid-build stops the step.
    with _window():
        pass
    if lane in {"arcalive", "novel", "manual"} and not (lane == "arcalive" and metadata_updated):
        with closing(sqlite3.connect(db_path, timeout=30)) as db, db:
            pending = db.execute(
                "SELECT 1 FROM text_archive_items i LEFT JOIN text_archive_publications p "
                "ON p.key='item:'||i.identity AND p.sha256=i.content_sha256 "
                "WHERE i.lane=? AND p.key IS NULL LIMIT 1",
                (lane,),
            ).fetchone()
            pointer_hash = _published_hash(db, f"published/{lane}/release.json")
            metadata_matches = _published_hash(db, metadata_key) == metadata_digest
        if pending is None and pointer_hash and not metadata_updated and metadata_matches:
            with _network_window():
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
                    result["availability"] = _availability_or_defer(
                        db_path, receipts_root, headroom
                    )
                return result
    tree = build_publish_tree(db_path, object_root, build_root, lane, headroom=headroom)
    db = _connect(db_path)
    try:
        pending_objects: list[tuple[str, str]] = []

        def publish_batch() -> None:
            if pending_objects:
                batch = pending_objects[:]
                _publish_object_batch(build_root, object_root, remote, batch, runner)
                with _window():
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
                local = object_root / row[2] if plan == "object_plan" else build_root / key
                body = local.read_bytes()
                if hashlib.sha256(body).hexdigest() != digest:
                    raise ValueError(f"local publish file failed verification: {key}")
                with _network_window():
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
                with _network_window():
                    readback = _run(
                        ["rclone", "--config", _RCLONE_CONFIG, "cat", f"{remote}/{key}"],
                        runner,
                    )
                if hashlib.sha256(readback).hexdigest() != digest:
                    raise OSError(f"R2 readback mismatch: {key}")
                with _window():
                    _record_publication(db_path, key, digest)
        pointer_path = Path(tree["pointer_path"])
        pointer_key = f"published/{lane}/release.json"
        pointer_body = pointer_path.read_bytes()
        pointer_hash = hashlib.sha256(pointer_body).hexdigest()
        with _network_window():
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
        with _network_window():
            pointer_readback = _run(
                ["rclone", "--config", _RCLONE_CONFIG, "cat", f"{remote}/{pointer_key}"],
                runner,
            )
        if hashlib.sha256(pointer_readback).hexdigest() != pointer_hash:
            raise OSError("release pointer readback mismatch")
        with _window():
            _record_publication(db_path, pointer_key, pointer_hash)
            _record_publication(db_path, metadata_key, metadata_digest)
            with db:
                now = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
                for identity, content_sha256 in _plan_rows(Path(tree["item_plan"])):
                    db.execute(
                        "INSERT INTO text_archive_publications"
                        "(key,sha256,verified_at) VALUES(?,?,?) "
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
    # The new pointer is verified; retention is cleanup and never fails the publish.
    try:
        result["prune"] = _prune_lane(
            db_path, build_root, lane, str(tree["release_key"]), remote, runner
        )
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        sqlite3.Error,
        RuntimeWindowError,
        subprocess.SubprocessError,
    ) as exc:
        result["prune"] = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:300]}
    if lane == "novel":
        result["availability"] = _availability_or_defer(db_path, receipts_root, headroom)
    return result


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Publish the independent text archive")
    parser.add_argument("lane", choices=("novel", "arcalive", "manual", "both"))
    args = parser.parse_args()
    lanes = ("novel", "arcalive", "manual") if args.lane == "both" else (args.lane,)
    db_path = Path("/srv/redstm-text/text-archive.sqlite")
    receipts_root = Path("/srv/redstm-text-inbox/receipts")

    def tell_pc(outcome: str, reason: str = "") -> None:
        # Newtomi reads receipts/publish-status.json to tell "waiting" from "lost" (its
        # 2026-10-04 feedback). Best-effort: it never changes the publish outcome.
        try:
            write_pc_state(db_path, receipts_root, outcome=outcome, reason=reason)
        except OSError, sqlite3.Error:
            pass

    results = []
    outcome, reason, exit_code = "published", "", 0
    for lane in lanes:
        try:
            results.append(
                publish_lane(
                    db_path,
                    Path("/srv/redstm-text/objects"),
                    Path("/srv/redstm-text/build"),
                    receipts_root,
                    lane,
                )
            )
        except RuntimeWindowError as exc:
            results.append({"lane": lane, "status": "deferred", "reason": str(exc)})
            if exit_code != 1:
                outcome, reason, exit_code = "deferred", str(exc), 75
        except Exception as exc:
            results.append({"lane": lane, "status": "failed", "reason": type(exc).__name__})
            outcome, reason, exit_code = "failed", type(exc).__name__, 1
    tell_pc(outcome, reason)
    # Operational status (docs/18 §5.2 "운영 상태"). It never fails the publish.
    try:
        results.append(
            {
                "status_document": publish_status(
                    Path("/srv/redstm-text/text-archive.sqlite"),
                    Path("/srv/redstm-text-inbox"),
                    Path("/srv/redstm-text/build"),
                )
            }
        )
    except (OSError, RuntimeWindowError, sqlite3.Error, subprocess.SubprocessError) as exc:
        results.append({"status_document": f"failed: {type(exc).__name__}: {exc}"[:300]})
    try:
        results.append(
            {
                "pruned_receipts": prune_receipts(
                    Path("/srv/redstm-text-inbox/receipts"), Path("/srv/redstm-text-inbox/drop")
                )
            }
        )
    except OSError as exc:
        results.append({"pruned_receipts": f"failed: {type(exc).__name__}"})
    print(json.dumps(results, sort_keys=True))
    if exit_code:
        parser.exit(exit_code)


if __name__ == "__main__":
    main()
