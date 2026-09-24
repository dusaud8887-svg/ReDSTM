from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import UTC
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import requests

from scripts.text_archive.importer import (
    _MAX_FILE_BYTES,
    BatchRejectedError,
    _canonical_work_id,
    _connect,
    _now,
    _refresh_link_candidates,
    _store_object,
    _text_key,
    mark_cross_source_covered,
)
from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_PAGE_SIZE = 96
_REQUEST_GAP = 5
_SHARED_GROUP = "blacktoon-marumaru-novel"
_HOSTS = {
    "blacktoon": re.compile(r"blacktoon\d+\.com\Z", re.I),
    "marumaru": re.compile(r"marumaru\d+\.com\Z", re.I),
}
_SCHEMA = """
CREATE TABLE IF NOT EXISTS text_collector_queue (
  source TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  parent_work_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  next_check_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY(source,kind,entity_id)
);
CREATE INDEX IF NOT EXISTS idx_text_collector_queue_due
  ON text_collector_queue(status,next_check_at,updated_at);
"""


@dataclass(frozen=True)
class Source:
    name: str
    host: str

    @property
    def base_url(self) -> str:
        return f"https://{self.host}"


@dataclass(frozen=True)
class RequestUnit:
    source: Source
    kind: str
    entity_id: str
    url: str


class CollectorError(ValueError):
    pass


def configured_sources(env: dict[str, str] | None = None) -> tuple[Source, Source]:
    values = os.environ if env is None else env
    sources: list[Source] = []
    for name, default in (("blacktoon", "blacktoon452.com"), ("marumaru", "marumaru102.com")):
        host = values.get(f"REDSTM_TEXT_{name.upper()}_HOST", default).strip().lower()
        if not _HOSTS[name].fullmatch(host):
            raise CollectorError(f"invalid configured host for {name}")
        sources.append(Source(name, host))
    return sources[0], sources[1]


def configured_body_source(env: dict[str, str] | None = None) -> str | None:
    values = os.environ if env is None else env
    name = values.get("REDSTM_TEXT_BODY_SOURCE", "").strip().lower()
    if not name:
        return None
    if name not in _HOSTS:
        raise CollectorError("body_source_invalid")
    return name


def _payload(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value:
        data = value["data"]
        if isinstance(data, (dict, list)):
            return data
    return value


def parse_catalog_page(value: Any) -> tuple[list[dict[str, Any]], int, int]:
    root = value if isinstance(value, dict) else {}
    data = _payload(value)
    rows: Any = None
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        for key in ("works", "content", "items", "results"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
    if rows is None:
        for key in ("works", "content", "items", "results"):
            if isinstance(root.get(key), list):
                rows = root[key]
                break
    if not isinstance(rows, list):
        raise CollectorError("catalog_shape_unknown")
    meta = data if isinstance(data, dict) else root
    total = meta.get("total", meta.get("totalElements", root.get("total", 0)))
    size = meta.get("size", meta.get("pageSize", root.get("size", _PAGE_SIZE)))
    if type(total) is not int or total < 0 or type(size) is not int or size < 1:
        raise CollectorError("catalog_paging_invalid")
    valid: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), (str, int)):
            continue
        work_id = str(row["id"])
        if not work_id.isdigit():
            continue
        valid.append(
            {
                "id": work_id,
                "slug": str(row.get("slug") or "")[:300],
                "title": str(row.get("title") or "")[:500],
                "author": str(row.get("authorName") or row.get("author") or "")[:300],
            }
        )
    if rows and not valid:
        raise CollectorError("catalog_ids_invalid")
    return valid, total, size


def parse_work_detail(value: Any) -> tuple[str, str, str, list[dict[str, Any]]]:
    data = _payload(value)
    if isinstance(data, dict) and isinstance(data.get("work"), dict):
        data = data["work"]
    if not isinstance(data, dict):
        raise CollectorError("work_shape_unknown")
    work_id = str(data.get("id") or "")
    if not work_id.isdigit():
        raise CollectorError("work_id_invalid")
    title = str(data.get("title") or "")[:500]
    author = str(data.get("authorName") or data.get("author") or "")[:300]
    episodes = data.get("episodes", data.get("chapters"))
    if not isinstance(episodes, list):
        raise CollectorError("work_episodes_unknown")
    normalized: list[dict[str, Any]] = []
    for row in episodes:
        if not isinstance(row, dict):
            continue
        chapter_id = str(row.get("id") or "")
        if not chapter_id.isdigit():
            continue
        price = row.get("price", row.get("points"))
        is_free = row.get("isFree")
        access_value = str(row.get("access") or row.get("status") or "").casefold()
        free = (
            is_free is True
            or (type(price) is int and price == 0)
            or access_value in {"free", "public"}
        )
        point = (
            is_free is False
            or (type(price) is int and price > 0)
            or access_value in {"point", "paid", "locked", "restricted"}
        )
        access = "unknown" if free == point else "free" if free else "point"
        label = str(row.get("episodeNumber") or row.get("number") or row.get("title") or "")[:300]
        kind = str(row.get("chapterKind") or row.get("kind") or "main")[:40]
        normalized.append({"id": chapter_id, "label": label, "kind": kind, "access": access})
    return work_id, title, author, normalized


def _plain_text(body_json: Any) -> str:
    text: str
    if isinstance(body_json, str):
        try:
            body_json = json.loads(body_json)
        except json.JSONDecodeError:
            text = body_json
        else:
            return _plain_text(body_json)
    elif isinstance(body_json, list):
        parts: list[str] = []
        for block in body_json:
            if not isinstance(block, dict) or block.get("type") not in {"text", "paragraph"}:
                raise CollectorError("body_block_requires_review")
            text_value = block.get("text", block.get("content"))
            if not isinstance(text_value, str):
                raise CollectorError("body_block_requires_review")
            parts.append(text_value)
        text = "\n\n".join(parts)
    elif isinstance(body_json, dict) and body_json.get("type") in {"text", "paragraph"}:
        text_value = body_json.get("text", body_json.get("content"))
        if not isinstance(text_value, str):
            raise CollectorError("body_block_requires_review")
        text = text_value
    else:
        raise CollectorError("body_shape_requires_review")
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text or "\x00" in text:
        raise CollectorError("body_empty_or_invalid")
    return text


def _episode_detail(value: Any) -> tuple[str, str, Any]:
    data = _payload(value)
    if isinstance(data, dict) and isinstance(data.get("episode"), dict):
        data = data["episode"]
    if not isinstance(data, dict):
        raise CollectorError("episode_shape_unknown")
    chapter_id = str(data.get("id") or "")
    if not chapter_id.isdigit():
        raise CollectorError("episode_id_invalid")
    body_json = data.get("bodyJson")
    if body_json is None:
        raise CollectorError("episode_body_missing")
    return chapter_id, str(data.get("title") or "")[:300], body_json


def _state(db: sqlite3.Connection, source: str) -> sqlite3.Row | None:
    row = db.execute("SELECT * FROM text_collector_state WHERE source=?", (source,)).fetchone()
    return row if isinstance(row, sqlite3.Row) else None


def _next_unit(
    db: sqlite3.Connection,
    sources: tuple[Source, Source],
    now: int,
    body_source: str | None,
) -> RequestUnit:
    group = db.execute(
        "SELECT last_source FROM text_collector_groups WHERE group_id=?", (_SHARED_GROUP,)
    ).fetchone()
    last_source = str(group[0]) if group else ""
    work_requests = db.execute(
        "SELECT COALESCE(SUM(attempts),0) FROM text_collector_queue WHERE kind='work'"
    ).fetchone()[0]
    oracle_chapters = db.execute(
        "SELECT COUNT(*) FROM text_archive_items WHERE batch_id LIKE 'oracle:%'"
    ).fetchone()[0]
    candidates: list[tuple[int, str, str, RequestUnit]] = []
    for source in sources:
        queued = db.execute(
            """SELECT kind,entity_id FROM text_collector_queue
               WHERE source=? AND status IN ('pending','retry') AND next_check_at<=?
                 AND NOT (kind='work' AND ?>=100)
                 AND NOT (kind='episode' AND ?>=1000)
                 AND (kind!='episode' OR ?=source)
               ORDER BY updated_at,kind,entity_id LIMIT 1""",
            (source.name, now, work_requests, oracle_chapters, body_source),
        ).fetchone()
        if queued is not None:
            kind, entity_id = str(queued["kind"]), str(queued["entity_id"])
            path = f"/api/works/{entity_id}" if kind == "work" else f"/api/episodes/{entity_id}"
            candidates.append(
                (0, source.name, kind, RequestUnit(source, kind, entity_id, source.base_url + path))
            )
            continue
        state = _state(db, f"{source.name}:list")
        page = int(state["next_page"]) if state else 0
        next_check = int(state["next_check_at"]) if state else 0
        if next_check <= now:
            url = f"{source.base_url}/api/works?mediaType=NOVEL&page={page}&size={_PAGE_SIZE}"
            candidates.append((1, source.name, "list", RequestUnit(source, "list", str(page), url)))
    if not candidates:
        raise CollectorError("no_due_collector_work")
    other_source = [row for row in candidates if row[1] != last_source]
    selected = min(other_source or candidates, key=lambda row: (row[0], row[1], row[2]))
    return selected[3]


def _retry_after(value: str | None, now: int, default: int) -> int:
    if value:
        try:
            seconds = int(value.strip())
            return now + min(max(seconds, default), 7 * 24 * 3600)
        except ValueError:
            try:
                when = parsedate_to_datetime(value)
                if when is None:
                    return now + default
                if when.tzinfo is None:
                    when = when.replace(tzinfo=UTC)
                return min(max(now + default, int(when.timestamp())), now + 7 * 24 * 3600)
            except TypeError, ValueError, OverflowError:
                pass
    return now + default


def _response_body(response: requests.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > _MAX_RESPONSE_BYTES:
            raise CollectorError("response_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def _get(
    session: requests.Session, unit: RequestUnit, db_path: Path
) -> tuple[int, bytes, dict[str, str]]:
    while True:
        db = _connect(db_path)
        try:
            group = db.execute(
                "SELECT * FROM text_collector_groups WHERE group_id=?", (_SHARED_GROUP,)
            ).fetchone()
            now = int(time.time())
            if group is not None and int(group["cooldown_until"]) > now:
                raise CollectorError("source_group_cooldown")
            last_request = int(group["last_request_at"]) if group else 0
            delay = max(0, _REQUEST_GAP - (now - last_request))
        finally:
            db.close()
        if delay:
            time.sleep(delay)

        retry_delay = 0
        response_data: tuple[int, bytes, dict[str, str]] | None = None
        with operation_window():
            db = _connect(db_path)
            try:
                group = db.execute(
                    "SELECT * FROM text_collector_groups WHERE group_id=?", (_SHARED_GROUP,)
                ).fetchone()
                now = int(time.time())
                if group is not None and int(group["cooldown_until"]) > now:
                    raise CollectorError("source_group_cooldown")
                last_request = int(group["last_request_at"]) if group else 0
                retry_delay = max(0, _REQUEST_GAP - (now - last_request))
                if retry_delay == 0:
                    with db:
                        db.execute(
                            """INSERT INTO text_collector_groups(
                               group_id,last_request_at,last_source) VALUES(?,?,?)
                               ON CONFLICT(group_id) DO UPDATE SET
                               last_request_at=excluded.last_request_at,
                               last_source=excluded.last_source""",
                            (_SHARED_GROUP, now, unit.source.name),
                        )
            finally:
                db.close()
            if not retry_delay:
                with session.get(
                    unit.url,
                    timeout=(5, 15),
                    allow_redirects=False,
                    stream=True,
                    headers={
                        "Accept": "application/json",
                        "User-Agent": "ReDSTM-text-archive/1.0",
                    },
                ) as response:
                    response_data = (
                        response.status_code,
                        _response_body(response),
                        dict(response.headers),
                    )
        if retry_delay:
            time.sleep(retry_delay)
            continue
        if response_data is None:
            raise CollectorError("request_not_sent")
        return response_data


def _enqueue(
    db: sqlite3.Connection,
    source: str,
    kind: str,
    entity_id: str,
    parent: str = "",
    *,
    refresh_done: bool = False,
) -> None:
    on_conflict = (
        "DO UPDATE SET status='pending',next_check_at=0,updated_at=excluded.updated_at "
        "WHERE text_collector_queue.status='done'"
        if refresh_done
        else "DO NOTHING"
    )
    db.execute(
        """INSERT INTO text_collector_queue(
           source,kind,entity_id,parent_work_id,updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(source,kind,entity_id) """
        + on_conflict,
        (source, kind, entity_id, parent, _now()),
    )


def _apply_list(db: sqlite3.Connection, unit: RequestUnit, value: Any) -> dict[str, Any]:
    works, total, page_size = parse_catalog_page(value)
    now = int(time.time())
    page = int(unit.entity_id)
    if not works and page * page_size < total:
        raise CollectorError("catalog_empty_before_end")
    with db:
        for work in works:
            db.execute(
                """INSERT INTO text_novel_sources(
                   site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(site,source_work_id) DO UPDATE SET
                   source_url=excluded.source_url,
                   slug=excluded.slug,title=excluded.title,author=excluded.author,
                   title_key=excluded.title_key,author_key=excluded.author_key,
                   last_seen_at=excluded.last_seen_at""",
                (
                    unit.source.name,
                    work["id"],
                    f"{unit.source.base_url}/novel/{work['id']}",
                    work["slug"],
                    work["title"],
                    work["author"],
                    _text_key(work["title"]),
                    _text_key(work["author"]),
                    _now(),
                ),
            )
            _refresh_link_candidates(db, unit.source.name, work["id"])
            _enqueue(db, unit.source.name, "work", work["id"], refresh_done=True)
        done = not works or (page + 1) * page_size >= total
        next_page = 0 if done else page + 1
        next_check = now + 7 * 24 * 3600 if done else now
        db.execute(
            """INSERT INTO text_collector_state(
               source,next_page,total_count,page_size,next_check_at,last_error,updated_at)
               VALUES(?,?,?,?,?,'',?) ON CONFLICT(source) DO UPDATE SET
               next_page=excluded.next_page,total_count=excluded.total_count,
               page_size=excluded.page_size,next_check_at=excluded.next_check_at,
               last_error='',updated_at=excluded.updated_at""",
            (f"{unit.source.name}:list", next_page, total, page_size, next_check, _now()),
        )
    return {
        "status": "listed",
        "source": unit.source.name,
        "page": page,
        "works": len(works),
        "total": total,
    }


def _apply_work(
    db: sqlite3.Connection, unit: RequestUnit, value: Any, body_source: str | None
) -> dict[str, Any]:
    work_id, title, author, episodes = parse_work_detail(value)
    now = _now()
    with db:
        source_row = db.execute(
            "SELECT slug FROM text_novel_sources WHERE site=? AND source_work_id=?",
            (unit.source.name, work_id),
        ).fetchone()
        slug = str(source_row["slug"]) if source_row else ""
        db.execute(
            """INSERT INTO text_novel_sources(
               site,source_work_id,source_url,slug,title,author,title_key,author_key,last_seen_at)
               VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(site,source_work_id) DO UPDATE SET
               source_url=excluded.source_url,
               title=excluded.title,author=excluded.author,title_key=excluded.title_key,
               author_key=excluded.author_key,last_seen_at=excluded.last_seen_at""",
            (
                unit.source.name,
                work_id,
                f"{unit.source.base_url}/novel/{work_id}",
                slug,
                title,
                author,
                _text_key(title),
                _text_key(author),
                now,
            ),
        )
        _refresh_link_candidates(db, unit.source.name, work_id)
        for episode in episodes:
            status = (
                "discovered"
                if episode["access"] == "free"
                else ("waiting" if episode["access"] == "point" else "unknown_access")
            )
            db.execute(
                """INSERT INTO text_novel_chapters(
                   site,source_work_id,source_chapter_id,chapter_label,chapter_kind,
                   access,status,last_seen_at)
                   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(site,source_work_id,source_chapter_id)
                   DO UPDATE SET chapter_label=excluded.chapter_label,
                   chapter_kind=excluded.chapter_kind,access=excluded.access,
                   status=CASE WHEN text_novel_chapters.status='complete' THEN 'complete'
                               ELSE excluded.status END,last_seen_at=excluded.last_seen_at""",
                (
                    unit.source.name,
                    work_id,
                    episode["id"],
                    episode["label"],
                    episode["kind"],
                    episode["access"],
                    status,
                    now,
                ),
            )
            if episode["access"] == "free" and unit.source.name == body_source:
                _enqueue(db, unit.source.name, "episode", episode["id"], work_id)
        mark_cross_source_covered(db, unit.source.name, work_id)
        db.execute(
            "UPDATE text_collector_queue SET status='done',attempts=attempts+1,"
            "last_error='',updated_at=? "
            "WHERE source=? AND kind='work' AND entity_id=?",
            (now, unit.source.name, work_id),
        )
    return {
        "status": "work_indexed",
        "source": unit.source.name,
        "work_id": work_id,
        "chapters": len(episodes),
    }


def _apply_episode(
    db: sqlite3.Connection,
    object_root: Path,
    unit: RequestUnit,
    value: Any,
    body_host: str,
) -> dict[str, Any]:
    chapter_id, title, body_json = _episode_detail(value)
    body = (_plain_text(body_json) + "\n").encode("utf-8")
    if len(body) > _MAX_FILE_BYTES:
        raise CollectorError("chapter_body_too_large")
    queue_row = db.execute(
        "SELECT parent_work_id FROM text_collector_queue "
        "WHERE source=? AND kind='episode' AND entity_id=?",
        (unit.source.name, chapter_id),
    ).fetchone()
    if queue_row is None:
        raise CollectorError("episode_queue_entry_missing")
    parent_id = str(queue_row[0])
    source_row = db.execute(
        "SELECT title,author FROM text_novel_sources WHERE site=? AND source_work_id=?",
        (unit.source.name, parent_id),
    ).fetchone()
    label_row = db.execute(
        """SELECT chapter_label,chapter_kind FROM text_novel_chapters
           WHERE site=? AND source_work_id=? AND source_chapter_id=?""",
        (unit.source.name, parent_id, chapter_id),
    ).fetchone()
    title_work = str(source_row["title"]) if source_row else ""
    author = str(source_row["author"]) if source_row else ""
    label = str(label_row["chapter_label"]) if label_row else title
    chapter_kind = str(label_row["chapter_kind"]) if label_row else "main"
    identity = f"novel_chapter:{unit.source.name}:{parent_id}:{chapter_id}"
    digest = hashlib.sha256(body).hexdigest()
    url = f"https://{body_host}/novel/{parent_id}/{chapter_id}"
    old = db.execute(
        "SELECT content_sha256 FROM text_archive_items WHERE identity=?", (identity,)
    ).fetchone()
    now = _now()
    if old is not None and old["content_sha256"] != digest:
        with db:
            db.execute(
                """INSERT OR IGNORE INTO text_archive_conflicts(
                   batch_id,identity,existing_sha256,incoming_sha256,reason,detected_at)
                   VALUES(?,?,?,?,?,?)""",
                (
                    f"oracle:{unit.source.name}",
                    identity,
                    old["content_sha256"],
                    digest,
                    "source_id_hash_changed",
                    now,
                ),
            )
            db.execute(
                """UPDATE text_novel_chapters SET status='held_conflict',last_seen_at=?
                   WHERE site=? AND source_work_id=? AND source_chapter_id=?""",
                (now, unit.source.name, parent_id, chapter_id),
            )
        raise BatchRejectedError("source_id_hash_changed")
    key = _store_object(object_root, body, digest)
    with db:
        if old is None:
            db.execute(
                "INSERT OR IGNORE INTO text_archive_objects"
                "(sha256,bytes,object_key,first_seen_at) VALUES(?,?,?,?)",
                (digest, len(body), key, now),
            )
            db.execute(
                """INSERT INTO text_archive_items(
                   identity,lane,source_site,source_work_id,source_chapter_id,source_url,
                   title,author,chapter_label,chapter_kind,access,content_sha256,bytes,object_key,
                   canonical_work_id,canonical_chapter_id,batch_id,imported_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?, 'free',?,?,?,?,?,?,?)""",
                (
                    identity,
                    "novel",
                    unit.source.name,
                    parent_id,
                    chapter_id,
                    url,
                    title_work,
                    author,
                    label,
                    chapter_kind,
                    digest,
                    len(body),
                    key,
                    _canonical_work_id(db, unit.source.name, parent_id),
                    identity,
                    f"oracle:{unit.source.name}",
                    now,
                ),
            )
        db.execute(
            """UPDATE text_novel_chapters SET content_sha256=?,status='complete',last_seen_at=?
               WHERE site=? AND source_work_id=? AND source_chapter_id=?""",
            (digest, now, unit.source.name, parent_id, chapter_id),
        )
        db.execute(
            "UPDATE text_collector_queue SET status='done',last_error='',updated_at=? "
            "WHERE source=? AND kind='episode' AND entity_id=?",
            (now, unit.source.name, chapter_id),
        )
    return {
        "status": "chapter_saved",
        "source": unit.source.name,
        "work_id": parent_id,
        "chapter_id": chapter_id,
        "sha256": digest,
        "bytes": len(body),
    }


def _note_failure(db_path: Path, unit: RequestUnit, error: str, retry_at: int) -> None:
    db = _connect(db_path)
    try:
        with db:
            if unit.kind == "list":
                db.execute(
                    """INSERT INTO text_collector_state(
                       source,next_page,last_error,next_check_at,updated_at)
                       VALUES(?,?,?, ?,?) ON CONFLICT(source) DO UPDATE SET
                       last_error=excluded.last_error,next_check_at=excluded.next_check_at,
                       updated_at=excluded.updated_at""",
                    (
                        f"{unit.source.name}:list",
                        int(unit.entity_id),
                        error[:300],
                        retry_at,
                        _now(),
                    ),
                )
            else:
                review = any(
                    token in error
                    for token in ("requires_review", "unknown", "invalid", "missing", "too_large")
                )
                conflict = "source_id_hash_changed" in error
                queue_status = "review" if review or conflict else "retry"
                db.execute(
                    """UPDATE text_collector_queue SET status=?,attempts=attempts+1,
                       last_error=?,next_check_at=?,updated_at=?
                       WHERE source=? AND kind=? AND entity_id=?""",
                    (
                        queue_status,
                        error[:300],
                        retry_at,
                        _now(),
                        unit.source.name,
                        unit.kind,
                        unit.entity_id,
                    ),
                )
                if unit.kind == "episode" and (review or conflict):
                    chapter_status = "parse_review" if review else "held_conflict"
                    db.execute(
                        """UPDATE text_novel_chapters SET status=?,last_seen_at=?
                           WHERE site=? AND source_work_id=(SELECT parent_work_id
                             FROM text_collector_queue
                             WHERE source=? AND kind='episode' AND entity_id=?)
                             AND source_chapter_id=?""",
                        (
                            chapter_status,
                            _now(),
                            unit.source.name,
                            unit.source.name,
                            unit.entity_id,
                            unit.entity_id,
                        ),
                    )
    finally:
        db.close()


def run_one(
    db_path: Path,
    object_root: Path,
    sources: tuple[Source, Source],
    *,
    body_source: str | None = None,
    session: requests.Session | None = None,
    clock: Any = time.time,
) -> dict[str, Any]:
    db = _connect(db_path)
    try:
        db.executescript(_SCHEMA)
        if body_source is not None and body_source not in _HOSTS:
            raise CollectorError("body_source_invalid")
        unit = _next_unit(db, sources, int(clock()), body_source)
    finally:
        db.close()
    http = session or requests.Session()
    owns_session = session is None
    http.trust_env = False
    try:
        status_code, raw, headers = _get(http, unit, db_path)
        now = int(clock())
        if status_code in {403, 429, 509}:
            default = 6 * 3600 if status_code in {403, 509} else 3600
            retry_header = next(
                (value for key, value in headers.items() if key.lower() == "retry-after"), None
            )
            cooldown = _retry_after(retry_header, now, default)
            db = _connect(db_path)
            try:
                with db:
                    db.execute(
                        """INSERT INTO text_collector_groups(
                           group_id,last_request_at,cooldown_until,last_status,last_error)
                           VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET
                           cooldown_until=excluded.cooldown_until,last_status=excluded.last_status,
                           last_error=excluded.last_error""",
                        (_SHARED_GROUP, now, cooldown, status_code, f"http_{status_code}"),
                    )
            finally:
                db.close()
            _note_failure(db_path, unit, f"http_{status_code}", cooldown)
            return {
                "status": "cooldown",
                "source": unit.source.name,
                "until": cooldown,
                "http_status": status_code,
            }
        if status_code < 200 or status_code >= 300:
            raise CollectorError(f"http_{status_code}")
        value = json.loads(raw)
        db = _connect(db_path)
        try:
            if unit.kind == "list":
                result = _apply_list(db, unit, value)
            elif unit.kind == "work":
                result = _apply_work(db, unit, value, body_source)
            else:
                result = _apply_episode(db, object_root, unit, value, unit.source.host)
            db.execute(
                """INSERT INTO text_collector_groups(
                   group_id,last_request_at,cooldown_until,last_status,last_error)
                   VALUES(?,?,0,?,'') ON CONFLICT(group_id) DO UPDATE SET
                   last_status=excluded.last_status,last_error=''""",
                (_SHARED_GROUP, now, status_code),
            )
            return result
        finally:
            db.close()
    except (
        requests.RequestException,
        CollectorError,
        json.JSONDecodeError,
        BatchRejectedError,
    ) as exc:
        error = str(exc)[:300]
        if error == "source_group_cooldown":
            return {"status": "deferred", "reason": error}
        retry_at = int(clock()) + (
            3600 if "requires_review" in error or "unknown" in error else 900
        )
        _note_failure(db_path, unit, error, retry_at)
        return {
            "status": "held",
            "source": unit.source.name,
            "kind": unit.kind,
            "reason": error,
            "next_check_at": retry_at,
        }
    finally:
        if owns_session:
            http.close()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run one conservative novel JSON collector step")
    parser.parse_args()
    try:
        result = run_one(
            Path("/srv/redstm-text/text-archive.sqlite"),
            Path("/srv/redstm-text/objects"),
            configured_sources(),
            body_source=configured_body_source(),
        )
    except RuntimeWindowError as exc:
        parser.exit(75, f"text collection deferred: {exc}\n")
    except CollectorError as exc:
        parser.exit(75, f"text collection deferred: {exc}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
