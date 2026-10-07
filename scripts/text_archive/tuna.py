"""Tunaground (참치 인터넷 어장) anchor board collector for the text archive (docs/34).

One paced step per call: a list page while a list sweep is due or in progress, otherwise the
next thread whose response count grew. Responses keep their TOM markup in SQLite; each
100-response segment of a thread is a lane `tuna` item whose plain-text body the publisher
serves like any other text object. Only the open last segment of a thread ever changes.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from scripts.text_archive.importer import _connect, _now, _store_object
from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_BASE = "https://bbs2.tunaground.net"
_BOARD = "anchor"
_REQUEST_GAP = 2
_PAGE_LIMIT = 50
_RANGE = 200
SEGMENT = 100
# A running thread gains a response every few minutes; refetch it at most this often.
_REFRESH_SECONDS = 20 * 60
# Each list sweep stops at the previous sweep's start; start one per timer run.
_LIST_INTERVAL = 4 * 60
_RETRY_BASE = 15 * 60
_RETRY_MAX = 6 * 3600
_SITE_FAILURES = 5
_SITE_COOLDOWN = 30 * 60
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_MAX_SEGMENT_BYTES = 8 * 1024 * 1024
_KST = timezone(timedelta(hours=9))
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS text_tuna_threads (
  board TEXT NOT NULL, thread_id INTEGER NOT NULL,
  title TEXT NOT NULL, username TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  response_count INTEGER NOT NULL, ended INTEGER NOT NULL,
  series_key TEXT NOT NULL, series_title TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  next_seq INTEGER NOT NULL DEFAULT 0,
  fetched_at REAL, retry_at REAL, failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (board, thread_id)
);
CREATE TABLE IF NOT EXISTS text_tuna_responses (
  board TEXT NOT NULL, thread_id INTEGER NOT NULL, seq INTEGER NOT NULL,
  username TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL,
  attachment TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (board, thread_id, seq)
);
CREATE TABLE IF NOT EXISTS text_tuna_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS text_tuna_superseded (
  sha256 TEXT PRIMARY KEY, object_key TEXT NOT NULL, superseded_at TEXT NOT NULL
);
"""


class TunaError(ValueError):
    """The source answered with something this collector does not accept."""


# --- source records: only these fields are kept; the API also returns password hashes ---


def _text(value: Any, limit: int, *, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise TunaError("field_invalid")
    return value


def _count(value: Any, upper: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= upper:
        raise TunaError("field_invalid")
    return value


def _timestamp(value: Any) -> str:
    text = _text(value, 40)
    try:
        if datetime.fromisoformat(text.replace("Z", "+00:00")).utcoffset() is None:
            raise TunaError("timestamp_invalid")
    except ValueError as exc:
        raise TunaError("timestamp_invalid") from exc
    return text


def thread_record(raw: Any) -> dict[str, Any] | None:
    """The listed thread, or None for a deleted or unpublished one."""
    if not isinstance(raw, dict):
        raise TunaError("thread_invalid")
    if raw.get("deleted") is True or raw.get("published") is False:
        return None
    thread_id = _count(raw.get("id"), 10**9)
    if thread_id == 0 or not isinstance(raw.get("ended"), bool):
        raise TunaError("thread_invalid")
    title = _text(raw.get("title"), 500)
    username = _text(raw.get("username"), 200)
    key, stem, tags = series_of(title, username)
    return {
        "thread_id": thread_id,
        "title": title,
        "username": username,
        "created_at": _timestamp(raw.get("createdAt")),
        "updated_at": _timestamp(raw.get("updatedAt")),
        "response_count": _count(raw.get("responseCount"), 100_000),
        "ended": raw["ended"],
        "top": raw.get("top") is True,
        "series_key": key,
        "series_title": stem,
        "tags": tags,
    }


def response_record(raw: Any, thread_id: int) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("threadId", thread_id) != thread_id:
        raise TunaError("response_invalid")
    attachment = raw.get("attachment")
    if attachment is not None:
        attachment = _text(attachment, 2000, empty=True) or None
    return {
        "seq": _count(raw.get("seq"), 100_000),
        "username": _text(raw.get("username"), 200, empty=True),
        "author_id": _text(raw.get("authorId") or "", 64, empty=True),
        "content": _text(raw.get("content"), 200_000, empty=True),
        "attachment": attachment,
        "created_at": _timestamp(raw.get("createdAt")),
    }


# --- work grouping (docs/34 §5) ---

_TAG_PREFIX = re.compile(r"^\s*(?:[\[【][^\]】]*[\]】]\s*)+")
_THREAD_NUMBER = re.compile(
    r"[\s\-–—:~.]*[(\[【<〈《]?\s*[-–—:~]*\s*\d+\s*(?:어장|편|기|화|부|차)?"
    r"\s*[-–—:~]*\s*[)\]】>〉》]?[\s\-–—:~.]*\Z"
)


def series_of(title: str, username: str) -> tuple[str, str, str]:
    """(series key, series title, leading tags): same trip and same title stem."""
    normalized = unicodedata.normalize("NFKC", title).strip()
    tags_match = _TAG_PREFIX.match(normalized)
    tags = tags_match.group(0).strip() if tags_match else ""
    rest = normalized[tags_match.end() :] if tags_match else normalized
    stem = " ".join(_THREAD_NUMBER.sub("", rest).split()) or " ".join(rest.split()) or normalized
    trip = username.split("◆", 1)[1].strip() if "◆" in username else username.strip()
    key = hashlib.sha256(f"{trip}\n{stem.casefold()}".encode()).hexdigest()[:16]
    return key, stem, tags


# --- TOM (Tunaground Object Markup) to plain text; same tokens as OpenChamchiJS lib/tom ---

_TAGS = frozenset(
    {"clr", "ruby", "dice", "spo", "sub", "youtube", "calc", "calcn", "aa", "hr", "bld"}
    | {"itl", "img"}
)
# Stored (read-time) form: dice keeps its result as a child, so it is not self-closing.
_SELF_CLOSING = frozenset({"youtube", "hr", "img"})
_TOKEN = re.compile(r"[\[\]() ]|[^\[\]() ]+")


def _tag_name(name: str) -> str:
    if re.fullmatch(r"clr[a-z0-9-]+", name):
        return "clr"
    if re.fullmatch(r"/clr[a-z0-9-]+", name):
        return "/clr"
    return name


def _append(nodes: list[Any], text: str) -> None:
    if nodes and isinstance(nodes[-1], str):
        nodes[-1] += text
    else:
        nodes.append(text)


def _source(nodes: list[Any], sep: str = "") -> str:
    parts: list[str] = []
    for node in nodes:
        if isinstance(node, str):
            parts.append(node)
        elif node["type"] == "nested":
            parts.append("(" + _source(node["children"], " ") + ")")
        else:
            attrs = _source(node["attributes"], " ")
            opening = f"[{node['name']} {attrs}]" if attrs else f"[{node['name']}]"
            if node["name"] in _SELF_CLOSING:
                parts.append(opening)
            else:
                parts.append(f"{opening}{_source(node['children'])}[/{node['name']}]")
    return sep.join(parts)


def parse_tom(text: str) -> list[Any]:
    """Text nodes are str; elements are dicts with name, attributes and children."""
    root: list[Any] = []
    # (context, tag name, nodes, self-closing)
    stack: list[tuple[str, str, list[Any], bool]] = [("children", "root", root, False)]
    tokens = _TOKEN.findall(text)
    expecting = False
    just_closed = False
    index = 0
    while index < len(tokens):
        token = tokens[index]
        context, tag, nodes, _ = stack[-1]
        if expecting:
            expecting = False
            if token not in "[]() ":
                name = _tag_name(token)
                if name.startswith("/") and tag == name[1:]:
                    stack.pop()
                    just_closed = True
                    index += 1
                    continue
                if name in _TAGS and len(stack) < 198:
                    element: dict[str, Any] = {
                        "type": "element",
                        "name": name,
                        "attributes": [],
                        "children": [],
                    }
                    nodes.append(element)
                    closing = name in _SELF_CLOSING
                    stack.append(("children", name, element["children"], closing))
                    stack.append(("attribute", name, element["attributes"], closing))
                    index += 1
                    continue
                _append(nodes, "[" + token)
                index += 1
                if index < len(tokens) and tokens[index] == "]":
                    _append(nodes, "]")
                    index += 1
                continue
            _append(nodes, "[")
            if token == "[":
                expecting = True
                index += 1
            continue
        if token == "[":
            expecting = True
        elif token == "]":
            if just_closed:
                just_closed = False
            elif context == "attribute":
                closing = stack.pop()[3]
                if closing:
                    stack.pop()
            else:
                _append(nodes, "]")
        elif token == "(" and context in {"attribute", "nested"}:
            nested: dict[str, Any] = {"type": "nested", "children": []}
            nodes.append(nested)
            stack.append(("nested", "nested", nested["children"], False))
        elif token == ")" and context == "nested":
            stack.pop()
        elif token == " " and context in {"attribute", "nested"}:
            pass
        elif context in {"attribute", "nested"}:
            nodes.append(token)
        else:
            _append(nodes, token)
        index += 1
    if expecting:
        _append(stack[-1][2], "[")
    while len(stack) > 1:
        context, tag, nodes, _ = stack.pop()
        parent = stack[-1][2]
        if context == "nested":
            if parent and isinstance(parent[-1], dict) and parent[-1]["type"] == "nested":
                parent.pop()
            _append(parent, "(" + _source(nodes, " "))
        elif context == "attribute":
            stack.pop()
            owner = stack[-1][2]
            if owner and isinstance(owner[-1], dict) and owner[-1].get("name") == tag:
                owner.pop()
                attrs = _source(nodes, " ")
                _append(owner, f"[{tag} {attrs}" if attrs else f"[{tag}")
    return root


def _own_line(parts: list[str], line: str) -> None:
    if parts and not "".join(parts).endswith("\n"):
        parts.append("\n")
    parts.append(line + "\n")


def _flatten(nodes: list[Any], parts: list[str]) -> None:
    for node in nodes:
        if isinstance(node, str):
            parts.append(node)
            continue
        if node["type"] == "nested":
            parts.append("(" + _source(node["children"], " ") + ")")
            continue
        name, attrs, children = node["name"], node["attributes"], node["children"]
        if name in {"aa", "bld", "itl", "sub", "clr", "spo"}:
            _flatten(children, parts)
        elif name == "ruby":
            _flatten(children, parts)
            parts.append("(" + _source(attrs, " ") + ")")
        elif name == "dice" and (
            len(attrs) == 2
            and all(isinstance(value, str) and re.fullmatch(r"-?\d+", value) for value in attrs)
            and len(children) == 1
            and isinstance(children[0], str)
        ):
            parts.append(f"【{attrs[0]}~{attrs[1]}: {children[0].strip()}】")
        elif name in {"calc", "calcn"}:
            parts.append("【" + _source(attrs, " ") + "】")
        elif name == "hr":
            _own_line(parts, "────────")
        elif name in {"img", "youtube"} and attrs and isinstance(attrs[0], str):
            url = attrs[0]
            if re.match(r"https?://", url):
                _own_line(parts, f"[{'image' if name == 'img' else 'video'}] {url}")
            else:
                parts.append(_source([node]))
        else:
            parts.append(_source([node]))


def tom_to_text(content: str) -> str:
    parts: list[str] = []
    _flatten(parse_tom(content), parts)
    return "".join(parts)


def render_segment(rows: Sequence[Any]) -> bytes:
    lines: list[str] = []
    for row in rows:
        moment = datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))
        stamp = moment.astimezone(_KST).strftime("%Y-%m-%d %H:%M")
        if lines:
            lines.append("")
        lines.append(f"──── #{row['seq']} {row['username']} · {stamp}")
        body = tom_to_text(str(row["content"]))
        lines.append(body[:-1] if body.endswith("\n") else body)
        attachment = row["attachment"]
        if attachment and re.match(r"https?://", str(attachment)):
            lines.append(f"[image] {attachment}")
    return ("\n".join(lines) + "\n").encode("utf-8")


# --- storage ---


def _state(db: sqlite3.Connection, key: str, default: str = "") -> str:
    row = db.execute("SELECT value FROM text_tuna_state WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row else default


def _set_state(db: sqlite3.Connection, key: str, value: str) -> None:
    db.execute(
        "INSERT INTO text_tuna_state(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def apply_threads(db: sqlite3.Connection, threads: list[dict[str, Any]]) -> int:
    """Upsert listed threads; returns how many need a response fetch."""
    with db:
        for thread in threads:
            previous = db.execute(
                "SELECT series_key FROM text_tuna_threads WHERE board=? AND thread_id=?",
                (_BOARD, thread["thread_id"]),
            ).fetchone()
            db.execute(
                """INSERT INTO text_tuna_threads(board,thread_id,title,username,created_at,
                   updated_at,response_count,ended,series_key,series_title,tags)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(board,thread_id) DO UPDATE SET title=excluded.title,
                   username=excluded.username,updated_at=excluded.updated_at,
                   response_count=MAX(response_count,excluded.response_count),
                   ended=excluded.ended,series_key=excluded.series_key,
                   series_title=excluded.series_title,tags=excluded.tags,
                   status=CASE WHEN status='gone' THEN 'active' ELSE status END""",
                (
                    _BOARD,
                    thread["thread_id"],
                    thread["title"],
                    thread["username"],
                    thread["created_at"],
                    thread["updated_at"],
                    thread["response_count"],
                    int(thread["ended"]),
                    thread["series_key"],
                    thread["series_title"],
                    thread["tags"],
                ),
            )
            if previous is not None and previous[0] != thread["series_key"]:
                db.execute(
                    "UPDATE text_archive_items SET source_work_id=?,canonical_work_id=? "
                    "WHERE lane='tuna' AND source_board=? AND source_post_id=?",
                    (
                        thread["series_key"],
                        f"tuna:{thread['series_key']}",
                        _BOARD,
                        str(thread["thread_id"]),
                    ),
                )
            db.execute(
                "UPDATE text_tuna_threads SET status='active' WHERE board=? AND thread_id=? "
                "AND status='complete' AND next_seq<response_count",
                (_BOARD, thread["thread_id"]),
            )
    return int(
        db.execute(
            "SELECT COUNT(*) FROM text_tuna_threads WHERE status='active' "
            "AND next_seq<response_count"
        ).fetchone()[0]
    )


def _segment_item(
    db: sqlite3.Connection, object_root: Path, thread: sqlite3.Row, segment: int, now: str
) -> str:
    rows = db.execute(
        "SELECT seq,username,content,attachment,created_at FROM text_tuna_responses "
        "WHERE board=? AND thread_id=? AND seq BETWEEN ? AND ? ORDER BY seq",
        (_BOARD, thread["thread_id"], segment * SEGMENT, segment * SEGMENT + SEGMENT - 1),
    ).fetchall()
    if not rows:
        return "empty"
    body = render_segment(rows)
    if len(body) > _MAX_SEGMENT_BYTES:
        raise TunaError("segment_too_large")
    digest = hashlib.sha256(body).hexdigest()
    identity = f"tuna:{_BOARD}:{thread['thread_id']}:{segment}"
    old = db.execute(
        "SELECT content_sha256,object_key FROM text_archive_items WHERE identity=?", (identity,)
    ).fetchone()
    if old is not None and old["content_sha256"] == digest:
        return "unchanged"
    key = _store_object(object_root, body, digest)
    first, last = rows[0]["seq"], rows[-1]["seq"]
    start = segment * SEGMENT
    values = {
        "identity": identity,
        "source_work_id": thread["series_key"],
        "source_chapter_id": f"{thread['thread_id']}:{segment}",
        "source_post_id": str(thread["thread_id"]),
        "source_url": f"{_BASE}/trace/{_BOARD}/{thread['thread_id']}/{start}/{start + SEGMENT - 1}",
        "title": thread["title"],
        "author": thread["username"],
        "chapter_label": f"#{first}–{last}",
        "content_sha256": digest,
        "bytes": len(body),
        "object_key": key,
        "canonical_work_id": f"tuna:{thread['series_key']}",
        "imported_at": now,
    }
    db.execute(
        "INSERT OR IGNORE INTO text_archive_objects(sha256,bytes,object_key,first_seen_at) "
        "VALUES(?,?,?,?)",
        (digest, len(body), key, now),
    )
    if old is None:
        db.execute(
            """INSERT INTO text_archive_items(identity,lane,source_site,source_work_id,
               source_chapter_id,source_board,source_post_id,source_url,title,author,
               chapter_label,chapter_kind,access,content_sha256,bytes,object_key,
               canonical_work_id,canonical_chapter_id,batch_id,imported_at)
               VALUES(:identity,'tuna','tunaground',:source_work_id,:source_chapter_id,
               'anchor',:source_post_id,:source_url,:title,:author,:chapter_label,'main',
               'free',:content_sha256,:bytes,:object_key,:canonical_work_id,:identity,
               'oracle:tuna',:imported_at)""",
            values,
        )
        return "created"
    # Only this lane changes an item's body: the open last segment of a running thread.
    db.execute(
        """UPDATE text_archive_items SET title=:title,author=:author,
           chapter_label=:chapter_label,content_sha256=:content_sha256,bytes=:bytes,
           object_key=:object_key,source_work_id=:source_work_id,
           canonical_work_id=:canonical_work_id,imported_at=:imported_at
           WHERE identity=:identity""",
        values,
    )
    db.execute(
        "INSERT OR IGNORE INTO text_tuna_superseded(sha256,object_key,superseded_at) VALUES(?,?,?)",
        (old["content_sha256"], old["object_key"], now),
    )
    return "updated"


def apply_responses(
    db: sqlite3.Connection,
    object_root: Path,
    thread_id: int,
    responses: list[dict[str, Any]],
    end_seq: int,
    clock: float,
) -> dict[str, Any]:
    now = _now()
    with db:
        thread = db.execute(
            "SELECT * FROM text_tuna_threads WHERE board=? AND thread_id=?", (_BOARD, thread_id)
        ).fetchone()
        if thread is None:
            raise TunaError("thread_unknown")
        segments: set[int] = set()
        inserted = 0
        for response in responses:
            cursor = db.execute(
                """INSERT OR IGNORE INTO text_tuna_responses(board,thread_id,seq,username,
                   author_id,content,attachment,created_at) VALUES(?,?,?,?,?,?,?,?)""",
                (
                    _BOARD,
                    thread_id,
                    response["seq"],
                    response["username"],
                    response["author_id"],
                    response["content"],
                    response["attachment"],
                    response["created_at"],
                ),
            )
            if cursor.rowcount:
                inserted += 1
                segments.add(response["seq"] // SEGMENT)
        # Deleted and hidden responses never come back, so the range itself is done.
        next_seq = max(int(thread["next_seq"]), min(end_seq + 1, int(thread["response_count"])))
        done = bool(thread["ended"]) and next_seq >= int(thread["response_count"])
        db.execute(
            "UPDATE text_tuna_threads SET next_seq=?,fetched_at=?,retry_at=NULL,failures=0,"
            "status=? WHERE board=? AND thread_id=?",
            (next_seq, clock, "complete" if done else "active", _BOARD, thread_id),
        )
        outcomes = [_segment_item(db, object_root, thread, segment, now) for segment in segments]
        _set_state(db, "site_failures", "0")
    return {
        "status": "thread_saved",
        "thread_id": thread_id,
        "new_responses": inserted,
        "next_seq": next_seq,
        "segments": sorted(segments),
        "items": {name: outcomes.count(name) for name in sorted(set(outcomes))},
    }


def _next_thread(db: sqlite3.Connection, clock: float) -> sqlite3.Row | None:
    return db.execute(
        """SELECT thread_id,next_seq,response_count FROM text_tuna_threads
           WHERE board=? AND status='active' AND next_seq<response_count
             AND (retry_at IS NULL OR retry_at<=?)
             AND (fetched_at IS NULL OR ended=1 OR fetched_at<=?)
           ORDER BY updated_at DESC, thread_id DESC LIMIT 1""",
        (_BOARD, clock, clock - _REFRESH_SECONDS),
    ).fetchone()


# --- requests ---


def _get_json(session: requests.Session, path: str, params: dict[str, Any]) -> tuple[int, Any]:
    response = session.get(
        f"{_BASE}{path}",
        params=params,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
        timeout=(10, 30),
        stream=True,
        allow_redirects=False,
    )
    try:
        if response.status_code != 200:
            return response.status_code, None
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(64 * 1024):
            total += len(chunk)
            if total > _MAX_RESPONSE_BYTES:
                raise TunaError("response_too_large")
            chunks.append(chunk)
    finally:
        response.close()
    try:
        return 200, json.loads(b"".join(chunks))
    except ValueError as exc:
        raise TunaError("response_not_json") from exc


def _site_failure(db: sqlite3.Connection, clock: float, reason: str) -> dict[str, Any]:
    with db:
        failures = int(_state(db, "site_failures", "0")) + 1
        _set_state(db, "site_failures", str(failures))
        if failures >= _SITE_FAILURES:
            _set_state(db, "cooldown_until", str(clock + _SITE_COOLDOWN))
            _set_state(db, "site_failures", "0")
            return {"status": "cooldown", "reason": reason}
    return {"status": "failed", "reason": reason}


def _list_step(db: sqlite3.Connection, session: requests.Session, clock: float) -> dict[str, Any]:
    page = int(_state(db, "list_page", "0")) or 1
    status, value = _get_json(
        session, f"/api/boards/{_BOARD}/threads", {"page": page, "limit": _PAGE_LIMIT}
    )
    if status != 200:
        return _site_failure(db, clock, f"list_http_{status}")
    if not isinstance(value, dict) or not isinstance(value.get("data"), list):
        raise TunaError("list_invalid")
    total_pages = value.get("pagination", {}).get("totalPages")
    threads = [record for raw in value["data"] if (record := thread_record(raw))]
    pending = apply_threads(db, threads)
    listed = [t["updated_at"] for t in threads if not t["top"]]
    # The site's own clock: a sweep stops at the newest update the previous sweep saw first.
    high_water = _state(db, "list_high_water")
    oldest = min(listed, key=_instant, default="")
    finished = (
        not value["data"]
        or not isinstance(total_pages, int)
        or page >= total_pages
        or (bool(high_water) and bool(oldest) and _instant(oldest) < _instant(high_water))
    )
    with db:
        if page == 1 and listed:
            _set_state(db, "list_newest", max(listed, key=_instant))
        if finished:
            _set_state(db, "list_high_water", _state(db, "list_newest", high_water))
            _set_state(db, "list_page", "0")
            _set_state(db, "list_due_at", str(clock + _LIST_INTERVAL))
        else:
            _set_state(db, "list_page", str(page + 1))
        _set_state(db, "site_failures", "0")
    return {
        "status": "list_page",
        "page": page,
        "threads": len(threads),
        "pending_threads": pending,
        "sweep_done": finished,
    }


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _thread_step(
    db: sqlite3.Connection,
    object_root: Path,
    session: requests.Session,
    thread: sqlite3.Row,
    clock: float,
) -> dict[str, Any]:
    thread_id = int(thread["thread_id"])
    start = int(thread["next_seq"])
    end = min(start + _RANGE - 1, int(thread["response_count"]) - 1)
    status, value = _get_json(
        session,
        f"/api/boards/{_BOARD}/threads/{thread_id}/responses",
        {"startSeq": start, "endSeq": end},
    )
    if status == 404:
        with db:
            db.execute(
                "UPDATE text_tuna_threads SET status='gone',fetched_at=? "
                "WHERE board=? AND thread_id=?",
                (clock, _BOARD, thread_id),
            )
        return {"status": "gone", "thread_id": thread_id}
    if status != 200:
        _thread_backoff(db, thread_id, clock)
        return {**_site_failure(db, clock, f"thread_http_{status}"), "thread_id": thread_id}
    if not isinstance(value, list):
        raise TunaError("responses_invalid")
    # seq 0 always comes along with any range; keep only the requested one.
    records = [response_record(raw, thread_id) for raw in value]
    responses = [record for record in records if start <= record["seq"] <= end]
    return apply_responses(db, object_root, thread_id, responses, end, clock)


def _thread_backoff(db: sqlite3.Connection, thread_id: int, clock: float) -> None:
    with db:
        failures = int(
            db.execute(
                "SELECT failures FROM text_tuna_threads WHERE board=? AND thread_id=?",
                (_BOARD, thread_id),
            ).fetchone()[0]
        )
        db.execute(
            "UPDATE text_tuna_threads SET failures=failures+1,retry_at=? "
            "WHERE board=? AND thread_id=?",
            (clock + min(_RETRY_MAX, _RETRY_BASE * 2**failures), _BOARD, thread_id),
        )


def run_one(
    db_path: Path,
    object_root: Path,
    *,
    session: requests.Session,
    clock: Any = time.time,
) -> dict[str, Any]:
    now = float(clock())
    with operation_window(need_bytes=60 * 1024 * 1024):
        db = _connect(db_path)
        try:
            db.executescript(_SCHEMA)
            if float(_state(db, "cooldown_until", "0")) > now:
                return {"status": "cooldown", "reason": "site_cooldown"}
            if int(_state(db, "list_page", "0")) or float(_state(db, "list_due_at", "0")) <= now:
                return _list_step(db, session, now)
            thread = _next_thread(db, now)
            if thread is None:
                return {"status": "idle"}
            try:
                return _thread_step(db, object_root, session, thread, now)
            except TunaError as exc:
                # One malformed thread backs off alone instead of stopping every run on it.
                _thread_backoff(db, int(thread["thread_id"]), now)
                return {"status": "failed", "reason": str(exc), "thread_id": thread["thread_id"]}
        except requests.RequestException as exc:
            return _site_failure(db, now, f"network_{type(exc).__name__}")
        finally:
            db.close()


_RUN_SECONDS = 270


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Collect the Tunaground anchor board")
    parser.add_argument("--seconds", type=int, default=_RUN_SECONDS, help="stop after this long")
    args = parser.parse_args()
    deadline = time.monotonic() + max(1, args.seconds)
    db_path = Path("/srv/redstm-text/text-archive.sqlite")
    object_root = Path("/srv/redstm-text/objects")
    session = requests.Session()
    session.trust_env = False
    statuses: dict[str, int] = {}
    stop_reason = "time_budget"
    try:
        while time.monotonic() + _REQUEST_GAP + 35 < deadline or not statuses:
            try:
                result = run_one(db_path, object_root, session=session)
            except (RuntimeWindowError, TunaError) as exc:
                if not statuses:
                    parser.exit(75, f"tuna collection deferred: {exc}\n")
                stop_reason = str(exc)
                break
            status = str(result.get("status"))
            statuses[status] = statuses.get(status, 0) + 1
            if status in {"cooldown", "idle"}:
                stop_reason = status
                break
            time.sleep(_REQUEST_GAP)
    finally:
        session.close()
    print(json.dumps({"steps": statuses, "stop_reason": stop_reason}, sort_keys=True))


if __name__ == "__main__":
    main()
