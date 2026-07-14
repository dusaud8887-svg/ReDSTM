from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator
from compression import zstd
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast

from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    SCHEMA_VERSION,
    connect_archive,
    decompress_body,
)
from crawler.pipelines import NormalizedComment, NormalizedPost
from crawler.settings import REDSTM_EXPORT_MAX_CHANGED_POSTS
from crawler.static_archive import (
    StaticPostSummary,
    build_static_post_payload,
    compress_static_payload,
    summary_dict,
)

_SEARCH_FIELDS = [
    "board_id",
    "external_post_id",
    "title",
    "author",
    "category",
    "created_at_raw",
    "payload_sha256",
]
_SEARCH_FIELDS_WITH_AA = [*_SEARCH_FIELDS, "is_aa"]
_COMPRESSION_LEVEL = 15
_AGGREGATE_COMPRESSION_LEVEL = 6
_COLLECTION_DETAIL_SHARDS = 64
_EXPORT_STATE_SCHEMA_VERSION = 1
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
_SOURCE_PROJECTION_VERSION = "source-projection-v1"


class IncrementalExportError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _safe_key(key: object) -> str:
    if not isinstance(key, str) or not key or "\\" in key:
        raise ValueError("invalid object key")
    path = PurePosixPath(key)
    if path.is_absolute() or ".." in path.parts or str(path) != key:
        raise ValueError(f"invalid object key: {key!r}")
    return key


def _atomic_replace(target: Path, body: bytes, *, durable: bool = False) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".partial"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
            if durable:
                stream.flush()
                os.fsync(stream.fileno())
        os.replace(temporary, target)
        if durable and os.name != "nt":
            directory = os.open(target.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(slots=True)
class _ObjectWriter:
    root: Path
    written: int = 0
    reused: int = 0

    def write(self, key: str, body: bytes) -> None:
        target = self.root / _safe_key(key)
        if target.exists():
            if target.read_bytes() != body:
                raise RuntimeError(f"immutable object differs: {key}")
            self.reused += 1
            return
        _atomic_replace(target, body)
        self.written += 1


@dataclass(frozen=True, slots=True)
class _PostTask:
    output: Path
    post_id: int
    created_at_source: str
    post: NormalizedPost
    capture_origin: Literal["live", "legacy_import", "reparse"]


@dataclass(frozen=True, slots=True)
class _PreparedPost:
    post_id: int
    created_at_source: str
    source_projection_sha256: str
    summary: StaticPostSummary
    payload: bytes
    body: bytes
    reused: bool


@dataclass(frozen=True, slots=True)
class _BaseRelease:
    key: str
    manifest: dict[str, Any]
    post_refs: dict[str, dict[int, _StoredPostRef]]


@dataclass(slots=True)
class _StoredPostRef:
    summary: StaticPostSummary
    object_sha256: str
    object_bytes: int
    source_projection_sha256: str

    def as_dict(self) -> dict[str, object]:
        return {
            **summary_dict(self.summary),
            "object_sha256": self.object_sha256,
            "object_bytes": self.object_bytes,
            "source_projection_sha256": self.source_projection_sha256,
        }


@dataclass(frozen=True, slots=True)
class _StagedObject:
    path: Path
    key: str
    payload_sha256: str
    payload_bytes: int


def _state_path(output: Path) -> Path:
    return output / ".export-state.json"


def _source_identity(source: Path, connection: sqlite3.Connection) -> dict[str, object]:
    return {
        "path": str(source),
        "application_id": int(connection.execute("PRAGMA application_id").fetchone()[0]),
        "schema_version": int(connection.execute("PRAGMA user_version").fetchone()[0]),
    }


def _projection_compatible_schema_versions() -> set[int]:
    known = {migration.version: migration for migration in MIGRATIONS}
    versions = {SCHEMA_VERSION}
    version = SCHEMA_VERSION
    while version > 1 and known[version].static_projection_compatible:
        version -= 1
        versions.add(version)
    return versions


def _database_projection_schema_versions(connection: sqlite3.Connection) -> set[int]:
    current = int(connection.execute("PRAGMA user_version").fetchone()[0])
    known = {migration.version: migration for migration in MIGRATIONS}
    applied = {
        int(row["version"]): str(row["sha256"])
        for row in connection.execute("SELECT version, sha256 FROM schema_migrations")
    }
    required = set(range(1, current + 1))
    if (
        current != SCHEMA_VERSION
        or set(applied) != required
        or any(
            known.get(version) is None or known[version].sha256 != sha256
            for version, sha256 in applied.items()
        )
    ):
        raise ValueError("canonical migration ledger does not match this exporter")
    return _projection_compatible_schema_versions()


def _source_identity_matches(
    stored: object,
    current: dict[str, object],
    compatible_schema_versions: set[int],
) -> bool:
    return (
        isinstance(stored, dict)
        and set(stored) == {"path", "application_id", "schema_version"}
        and stored.get("path") == current["path"]
        and stored.get("application_id") == current["application_id"]
        and type(stored.get("schema_version")) is int
        and stored["schema_version"] in compatible_schema_versions
    )


def _valid_snapshot(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    release_key = value.get("release_key")
    fingerprint = value.get("fingerprint")
    return (
        isinstance(release_key, str)
        and re.fullmatch(r"releases/[0-9a-f]{64}\.json", release_key) is not None
        and type(value.get("capture_high_water")) is int
        and value["capture_high_water"] >= 0
        and isinstance(fingerprint, dict)
        and set(fingerprint)
        == {
            "projection_sha256",
            "topology_sha256",
            "board_count",
            "post_count",
            "unavailable_post_count",
            "unavailable_comment_count",
            "collection_count",
            "collection_entry_count",
        }
        and all(
            isinstance(fingerprint.get(key), str)
            and _SHA256_PATTERN.fullmatch(cast(str, fingerprint[key])) is not None
            for key in ("projection_sha256", "topology_sha256")
        )
        and all(
            type(fingerprint.get(key)) is int and fingerprint[key] >= 0
            for key in (
                "board_count",
                "post_count",
                "unavailable_post_count",
                "unavailable_comment_count",
                "collection_count",
                "collection_entry_count",
            )
        )
    )


def _read_state(
    path: Path,
    identity: dict[str, object],
    compatible_schema_versions: set[int] | None = None,
) -> dict[str, Any] | None:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeDecodeError, json.JSONDecodeError:
        return None
    if (
        not isinstance(state, dict)
        or set(state) != {"schema_version", "source", "base", "pending"}
        or state.get("schema_version") != _EXPORT_STATE_SCHEMA_VERSION
        or not _source_identity_matches(
            state.get("source"),
            identity,
            compatible_schema_versions or {cast(int, identity["schema_version"])},
        )
        or (state.get("base") is not None and not _valid_snapshot(state["base"]))
        or (state.get("pending") is not None and not _valid_snapshot(state["pending"]))
        or (state.get("base") is None and state.get("pending") is None)
    ):
        return None
    return state


def _write_state(path: Path, state: dict[str, Any]) -> None:
    _atomic_replace(path, _json_bytes(state), durable=True)


def _pointer_key(root: Path) -> str | None:
    pointer = root / "release.json"
    if not pointer.is_file():
        return None
    body = pointer.read_bytes()
    key = f"releases/{_sha256(body)}.json"
    versioned = root / key
    if not versioned.is_file() or versioned.read_bytes() != body:
        raise IncrementalExportError(
            "incremental_base_invalid", "release pointer is not backed by a versioned release"
        )
    return key


def _recover_state(
    root: Path,
    path: Path,
    identity: dict[str, object],
    compatible_schema_versions: set[int] | None = None,
) -> dict[str, Any] | None:
    state = _read_state(path, identity, compatible_schema_versions)
    if state is None:
        return None
    pointer_key = _pointer_key(root)
    base = state["base"]
    pending = state["pending"]
    if pending is not None:
        if pointer_key == pending["release_key"]:
            state = {**state, "base": pending, "pending": None}
            _write_state(path, state)
            base = pending
        elif (base is None and pointer_key is None) or (
            base is not None and pointer_key == base["release_key"]
        ):
            state = {**state, "pending": None}
            _write_state(path, state)
        else:
            return None
    if base is None or pointer_key != base["release_key"]:
        return None
    return state


def _prepare_static_post(task: _PostTask) -> _PreparedPost:
    payload = build_static_post_payload(task.post, capture_origin=task.capture_origin)
    target = task.output / _safe_key(payload.summary.object_key)
    reused = target.is_file()
    body = target.read_bytes() if reused else compress_static_payload(payload.payload)
    if reused:
        try:
            existing_payload = zstd.decompress(body)
        except zstd.ZstdError as error:
            raise RuntimeError(f"invalid existing object: {payload.summary.object_key}") from error
        if existing_payload != payload.payload:
            raise RuntimeError(f"immutable object differs: {payload.summary.object_key}")
    return _PreparedPost(
        task.post_id,
        task.created_at_source,
        _source_projection_sha256(
            task.post.board_id,
            task.post.external_post_id,
            task.post.canonical_url,
            task.post.title,
            task.post.author,
            task.post.category,
            task.created_at_source,
            task.post.created_at_raw,
            task.post.is_aa,
            len(task.post.comments),
            task.post.content_sha256,
            task.post.comments_sha256,
            task.capture_origin,
            task.post.warc_record_id,
        ),
        payload.summary,
        payload.payload,
        body,
        reused,
    )


def _source_projection_sha256(*values: object) -> str:
    return _sha256(_json_bytes((_SOURCE_PROJECTION_VERSION, *values)))


def _row_source_projection_sha256(row: sqlite3.Row) -> str:
    return _source_projection_sha256(
        str(row["board_id"]),
        int(row["external_post_id"]),
        str(row["canonical_url"]),
        str(row["title"]),
        row["author"],
        row["category"],
        str(row["created_at_source"] or ""),
        row["created_at_raw"],
        bool(row["is_aa"]),
        int(row["comment_count"]),
        str(row["content_sha256"]),
        str(row["comments_sha256"]),
        str(row["capture_origin"]),
        row["warc_record_id"],
    )


def _object_ref(key: str, payload: bytes, body: bytes) -> dict[str, object]:
    return {
        "object_key": key,
        "payload_sha256": _sha256(payload),
        "object_sha256": _sha256(body),
        "object_bytes": len(body),
    }


def _write_zstd_object(
    writer: _ObjectWriter,
    prefix: str,
    payload: bytes,
    *,
    level: int = _COMPRESSION_LEVEL,
) -> dict[str, object]:
    payload_sha256 = _sha256(payload)
    key = f"{prefix}-{payload_sha256}.json.zst"
    body = zstd.compress(payload, level=level)
    writer.write(key, body)
    return _object_ref(key, payload, body)


def _search_row_bytes(
    connection: sqlite3.Connection,
    post_refs: dict[str, dict[int, _StoredPostRef]],
) -> Iterator[bytes]:
    for row in connection.execute(
        """
        SELECT p.id AS post_id, p.board_id, p.external_post_id, p.canonical_url,
               p.title, p.author, p.category, p.created_at_source, p.created_at_raw,
               p.views, p.is_aa, p.comment_count, p.latest_version_id,
               v.content_sha256, v.comments_sha256, v.capture_origin, v.warc_record_id
        FROM posts AS p
        JOIN post_versions AS v ON v.id = p.latest_version_id
        ORDER BY p.created_at_source DESC, p.external_post_id DESC, p.board_id DESC
        """
    ):
        board_id = str(row["board_id"])
        external_post_id = int(row["external_post_id"])
        stored = _base_post_ref(post_refs, board_id, external_post_id)
        if stored is None or not _post_row_matches_ref(row, stored):
            raise ValueError(f"search projection is stale: {board_id}/{external_post_id}")
        summary = stored.summary
        yield _json_bytes(
            (
                summary.board_id,
                summary.external_post_id,
                summary.title,
                summary.author,
                summary.category,
                summary.created_at_raw,
                summary.payload_sha256,
                summary.is_aa,
            )
        )[:-1]


def _stage_zstd_object(
    writer: _ObjectWriter,
    prefix: str,
    chunks: Iterable[bytes],
) -> _StagedObject:
    writer.root.mkdir(parents=True, exist_ok=True)
    payload_descriptor, payload_name = tempfile.mkstemp(
        dir=writer.root, prefix=".payload.", suffix=".partial"
    )
    payload_path = Path(payload_name)
    payload_digest = hashlib.sha256()
    payload_bytes = 0
    try:
        with os.fdopen(payload_descriptor, "wb") as payload_stream:
            for chunk in chunks:
                payload_stream.write(chunk)
                payload_digest.update(chunk)
                payload_bytes += len(chunk)
    except Exception:
        payload_path.unlink(missing_ok=True)
        raise
    payload_sha256 = payload_digest.hexdigest()
    return _StagedObject(
        payload_path,
        f"{prefix}-{payload_sha256}.json.zst",
        payload_sha256,
        payload_bytes,
    )


def _write_staged_zstd_object(writer: _ObjectWriter, staged: _StagedObject) -> dict[str, object]:
    target = writer.root / _safe_key(staged.key)
    target.parent.mkdir(parents=True, exist_ok=True)
    object_descriptor, object_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".partial"
    )
    object_path = Path(object_name)
    object_digest = hashlib.sha256()
    object_bytes = 0
    compressor = zstd.ZstdCompressor(level=_AGGREGATE_COMPRESSION_LEVEL)
    compressor.set_pledged_input_size(staged.payload_bytes)
    try:
        with (
            staged.path.open("rb") as payload_stream,
            os.fdopen(object_descriptor, "wb") as object_stream,
        ):
            for chunk in iter(lambda: payload_stream.read(1024 * 1024), b""):
                compressed = compressor.compress(chunk)
                object_stream.write(compressed)
                object_digest.update(compressed)
                object_bytes += len(compressed)
            compressed = compressor.flush()
            object_stream.write(compressed)
            object_digest.update(compressed)
            object_bytes += len(compressed)
        object_sha256 = object_digest.hexdigest()
        if target.exists():
            existing = hashlib.sha256()
            with target.open("rb") as existing_stream:
                for chunk in iter(lambda: existing_stream.read(1024 * 1024), b""):
                    existing.update(chunk)
            if target.stat().st_size != object_bytes or existing.hexdigest() != object_sha256:
                raise RuntimeError(f"immutable object differs: {staged.key}")
            writer.reused += 1
        else:
            os.replace(object_path, target)
            writer.written += 1
    finally:
        object_path.unlink(missing_ok=True)
        staged.path.unlink(missing_ok=True)
    return {
        "object_key": staged.key,
        "payload_sha256": staged.payload_sha256,
        "object_sha256": object_sha256,
        "object_bytes": object_bytes,
    }


def _stage_search_object(
    connection: sqlite3.Connection,
    writer: _ObjectWriter,
    post_refs: dict[str, dict[int, _StoredPostRef]],
) -> tuple[_StagedObject, int]:
    post_count = 0

    def chunks() -> Iterator[bytes]:
        nonlocal post_count
        yield b'{"fields":' + _json_bytes(_SEARCH_FIELDS_WITH_AA)[:-1] + b',"posts":['
        for row in _search_row_bytes(connection, post_refs):
            if post_count:
                yield b","
            yield row
            post_count += 1
        yield b'],"schema_version":1}\n'

    staged = _stage_zstd_object(writer, "search/title-author-v2", chunks())
    return staged, post_count


def _comment(row: sqlite3.Row) -> NormalizedComment:
    return NormalizedComment(
        position=int(row["position"]),
        source_comment_id=row["source_comment_id"],
        parent_position=(
            int(row["parent_position"]) if row["parent_position"] is not None else None
        ),
        depth=int(row["depth"]),
        author=row["author"],
        content_html=str(row["content_html"]),
        content_text=str(row["content_text"]),
        created_at_raw=row["created_at_raw"],
    )


def _grouped_comments(
    connection: sqlite3.Connection,
) -> Iterator[tuple[int, tuple[NormalizedComment, ...]]]:
    rows = connection.execute(
        """
        SELECT c.post_id, c.position, c.source_comment_id, c.parent_position, c.depth,
               c.author, c.content_html, c.content_text, c.created_at_raw
        FROM comments AS c
        JOIN posts AS p ON p.id = c.post_id
        WHERE p.latest_version_id IS NOT NULL
        ORDER BY c.post_id, c.position
        """
    )
    for post_id, grouped in groupby(rows, key=lambda row: int(row["post_id"])):
        yield post_id, tuple(_comment(row) for row in grouped)


def _post_from_row(row: sqlite3.Row, comments: tuple[NormalizedComment, ...]) -> NormalizedPost:
    body_html = decompress_body(row["body_html_zstd"])
    content_sha256 = str(row["content_sha256"])
    if _sha256(body_html.encode()) != content_sha256:
        raise ValueError(
            f"canonical content hash mismatch: {row['board_id']}/{row['external_post_id']}"
        )
    return NormalizedPost(
        board_id=str(row["board_id"]),
        external_post_id=int(row["external_post_id"]),
        canonical_url=str(row["canonical_url"]),
        title=str(row["title"]),
        author=row["author"],
        category=row["category"],
        created_at_raw=row["created_at_raw"],
        views=int(row["views"]),
        body_html=body_html,
        body_text=decompress_body(row["body_text_zstd"]),
        is_aa=bool(row["is_aa"]),
        comments=comments,
        content_sha256=content_sha256,
        comments_sha256=str(row["comments_sha256"]),
        warc_record_id=row["warc_record_id"],
    )


def _release_key(value: str) -> str:
    key = value if value.startswith("releases/") else f"releases/{value}.json"
    match = re.fullmatch(r"releases/([0-9a-f]{64})\.json", key)
    if match is None:
        raise ValueError(f"invalid release key: {value!r}")
    return key


def _read_ref(root: Path, ref: object) -> tuple[dict[str, Any], bytes]:
    if not isinstance(ref, dict):
        raise ValueError("object reference must be an object")
    key = _safe_key(ref.get("object_key"))
    target = root / key
    if not target.is_file():
        raise ValueError(f"referenced object is missing: {key}")
    body = target.read_bytes()
    if ref.get("object_bytes") != len(body):
        raise ValueError(f"object size mismatch: {key}")
    if ref.get("object_sha256") != _sha256(body):
        raise ValueError(f"object hash mismatch: {key}")
    try:
        payload = zstd.decompress(body)
    except zstd.ZstdError as error:
        raise ValueError(f"invalid Zstandard object: {key}") from error
    if ref.get("payload_sha256") != _sha256(payload):
        raise ValueError(f"payload hash mismatch: {key}")
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid JSON object: {key}") from error
    if not isinstance(decoded, dict):
        raise ValueError(f"JSON object must be a mapping: {key}")
    return decoded, body


def _verify_ref_object(root: Path, ref: object) -> None:
    if not isinstance(ref, dict):
        raise ValueError("object reference must be an object")
    key = _safe_key(ref.get("object_key"))
    expected_bytes = ref.get("object_bytes")
    expected_sha256 = ref.get("object_sha256")
    if (
        type(expected_bytes) is not int
        or expected_bytes < 0
        or not isinstance(expected_sha256, str)
        or _SHA256_PATTERN.fullmatch(expected_sha256) is None
    ):
        raise ValueError(f"invalid object reference: {key}")
    target = root / key
    try:
        if target.stat().st_size != expected_bytes:
            raise ValueError(f"object size mismatch: {key}")
        digest = hashlib.sha256()
        with target.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise ValueError(f"referenced object is missing: {key}") from error
    if digest.hexdigest() != expected_sha256:
        raise ValueError(f"object hash mismatch: {key}")


def _collection_nested_refs(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("schema_version") == 1 and isinstance(payload.get("collections"), list):
        return []
    details = payload.get("detail_shards")
    memberships = payload.get("memberships")
    if (
        payload.get("schema_version") != 2
        or payload.get("shard_count") != _COLLECTION_DETAIL_SHARDS
        or not isinstance(payload.get("collections"), list)
        or not isinstance(details, list)
        or not isinstance(memberships, list)
        or any(not isinstance(ref, dict) for ref in [*details, *memberships])
    ):
        raise ValueError("invalid collection index")
    return cast(list[dict[str, Any]], [*details, *memberships])


def _hash_query(digest: Any, connection: sqlite3.Connection, label: str, query: str) -> int:
    digest.update(label.encode())
    count = 0
    for row in connection.execute(query):
        digest.update(_json_bytes(tuple(row)))
        count += 1
    return count


def _snapshot_fingerprint(connection: sqlite3.Connection) -> dict[str, int | str]:
    projection = hashlib.sha256()
    topology = hashlib.sha256()
    post_count = _hash_query(
        projection,
        connection,
        "posts-v1",
        """
        SELECT p.id, p.board_id, p.external_post_id, p.canonical_url, p.title, p.author,
               p.category, p.created_at_source, p.created_at_raw, p.is_aa,
               p.comment_count, p.latest_version_id, v.content_sha256, v.comments_sha256,
               v.capture_origin, v.warc_record_id
        FROM posts AS p
        JOIN post_versions AS v ON v.id = p.latest_version_id
        ORDER BY p.id
        """,
    )
    board_count = _hash_query(
        topology,
        connection,
        "boards-v1",
        """
        SELECT board_id, name, group_name, canonical_url
        FROM boards ORDER BY board_id
        """,
    )
    _hash_query(
        topology,
        connection,
        "post-topology-v1",
        """
        SELECT id, board_id, external_post_id, availability, latest_version_id IS NOT NULL
        FROM posts ORDER BY id
        """,
    )
    collection_count = _hash_query(
        topology,
        connection,
        "collections-v1",
        """
        SELECT id, board_id, kind, title
        FROM collections ORDER BY id
        """,
    )
    collection_entry_count = _hash_query(
        topology,
        connection,
        "collection-entries-v1",
        """
        SELECT collection_id, position, post_id, source_external_post_id, title
        FROM collection_entries ORDER BY collection_id, position
        """,
    )
    unavailable = connection.execute(
        """
        SELECT COUNT(DISTINCT p.id), COUNT(c.position)
        FROM posts AS p
        LEFT JOIN comments AS c ON c.post_id = p.id
        WHERE p.latest_version_id IS NULL
        """
    ).fetchone()
    assert unavailable is not None
    return {
        "projection_sha256": projection.hexdigest(),
        "topology_sha256": topology.hexdigest(),
        "board_count": board_count,
        "post_count": post_count,
        "unavailable_post_count": int(unavailable[0]),
        "unavailable_comment_count": int(unavailable[1]),
        "collection_count": collection_count,
        "collection_entry_count": collection_entry_count,
    }


def _snapshot(
    release_key: str, capture_high_water: int, fingerprint: dict[str, int | str]
) -> dict[str, object]:
    return {
        "release_key": release_key,
        "capture_high_water": capture_high_water,
        "fingerprint": fingerprint,
    }


def _summary_from_ref(ref: object) -> StaticPostSummary:
    if not isinstance(ref, dict):
        raise ValueError("post summary must be an object")
    board_id = ref.get("board_id")
    external_post_id = ref.get("external_post_id")
    object_key = ref.get("object_key")
    payload_sha256 = ref.get("payload_sha256")
    if (
        not isinstance(board_id, str)
        or not board_id
        or type(external_post_id) is not int
        or external_post_id <= 0
        or not isinstance(object_key, str)
        or not isinstance(payload_sha256, str)
        or _SHA256_PATTERN.fullmatch(payload_sha256) is None
        or object_key != f"posts/{board_id}/{external_post_id}-{payload_sha256}.json.zst"
        or not isinstance(ref.get("title"), str)
        or (ref.get("author") is not None and not isinstance(ref.get("author"), str))
        or (ref.get("category") is not None and not isinstance(ref.get("category"), str))
        or (
            ref.get("created_at_raw") is not None and not isinstance(ref.get("created_at_raw"), str)
        )
        or type(ref.get("views")) is not int
        or ref["views"] < 0
        or type(ref.get("is_aa")) is not bool
        or type(ref.get("comment_count")) is not int
        or ref["comment_count"] < 0
        or type(ref.get("object_bytes")) is not int
        or ref["object_bytes"] < 0
        or not isinstance(ref.get("object_sha256"), str)
        or _SHA256_PATTERN.fullmatch(cast(str, ref["object_sha256"])) is None
    ):
        raise ValueError("invalid post summary")
    return StaticPostSummary(
        board_id=board_id,
        external_post_id=external_post_id,
        object_key=object_key,
        title=cast(str, ref["title"]),
        author=cast(str | None, ref.get("author")),
        category=cast(str | None, ref.get("category")),
        created_at_raw=cast(str | None, ref.get("created_at_raw")),
        views=cast(int, ref["views"]),
        is_aa=cast(bool, ref["is_aa"]),
        comment_count=cast(int, ref["comment_count"]),
        payload_sha256=payload_sha256,
    )


def _stored_post_ref(ref: object) -> _StoredPostRef:
    summary = _summary_from_ref(ref)
    assert isinstance(ref, dict)
    source_projection_sha256 = ref.get("source_projection_sha256")
    if (
        not isinstance(source_projection_sha256, str)
        or _SHA256_PATTERN.fullmatch(source_projection_sha256) is None
    ):
        raise ValueError("post summary is missing its source projection")
    return _StoredPostRef(
        summary,
        cast(str, ref["object_sha256"]),
        cast(int, ref["object_bytes"]),
        source_projection_sha256,
    )


def _base_post_ref(
    refs: dict[str, dict[int, _StoredPostRef]], board_id: str, external_post_id: int
) -> _StoredPostRef | None:
    board = refs.get(board_id)
    return board.get(external_post_id) if board is not None else None


def _load_base_release(root: Path, release_key: str) -> _BaseRelease:
    release_path = root / _release_key(release_key)
    body = release_path.read_bytes()
    if _sha256(body) != PurePosixPath(release_key).stem:
        raise ValueError("base release hash mismatch")
    try:
        manifest = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid base release JSON") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != 1
        or manifest.get("canonical_schema_version") not in _projection_compatible_schema_versions()
        or manifest.get("source") != "typemoon"
    ):
        raise ValueError("unsupported base release")
    boards = manifest.get("boards")
    if not isinstance(boards, list) or len(boards) != manifest.get("board_count"):
        raise ValueError("base release board count mismatch")
    post_refs: dict[str, dict[int, _StoredPostRef]] = {}
    post_count = 0
    comment_count = 0
    for board_ref in boards:
        board, _ = _read_ref(root, board_ref)
        board_id = board.get("board_id")
        posts = board.get("posts")
        if (
            not isinstance(board_id, str)
            or not isinstance(posts, list)
            or not isinstance(board_ref, dict)
            or board_ref.get("board_id") != board_id
            or board_ref.get("post_count") != len(posts)
        ):
            raise ValueError("invalid base board manifest")
        board_posts = post_refs.setdefault(board_id, {})
        for ref in posts:
            stored = _stored_post_ref(ref)
            summary = stored.summary
            if summary.board_id != board_id or summary.external_post_id in board_posts:
                raise ValueError("invalid base post identity")
            target = root / summary.object_key
            if not target.is_file() or target.stat().st_size != stored.object_bytes:
                raise ValueError(f"base post object is unavailable: {summary.object_key}")
            board_posts[summary.external_post_id] = stored
            post_count += 1
            comment_count += summary.comment_count

    # The finalized state attests semantic validation. Re-materializing the global search and
    # collection JSON here would exceed the runner memory limit, so retries verify their exact
    # compressed bytes and release counts instead.
    search_ref = manifest.get("search")
    collection_ref = manifest.get("collections")
    _verify_ref_object(root, search_ref)
    _verify_ref_object(root, collection_ref)
    collection_index, _ = _read_ref(root, collection_ref)
    for nested_ref in _collection_nested_refs(collection_index):
        _verify_ref_object(root, nested_ref)
    if not isinstance(search_ref, dict) or search_ref.get("post_count") != post_count:
        raise ValueError("base search count does not match boards")
    collection_count = manifest.get("collection_count")
    entry_count = manifest.get("collection_entry_count")
    if (
        not isinstance(collection_ref, dict)
        or type(collection_count) is not int
        or type(entry_count) is not int
        or collection_ref.get("collection_count") != collection_count
        or collection_ref.get("entry_count") != entry_count
    ):
        raise ValueError("base collection counts do not match release")
    expected = {
        "post_count": post_count,
        "comment_count": comment_count,
        "collection_count": collection_count,
        "collection_entry_count": entry_count,
    }
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("base release counts do not match aggregate objects")
    return _BaseRelease(release_key, manifest, post_refs)


def validate_release(root: Path, release: str) -> dict[str, int | str]:
    root = root.expanduser().resolve(strict=True)
    release_key = _release_key(release)
    release_path = root / release_key
    if not release_path.is_file():
        raise ValueError(f"release is missing: {release_key}")
    release_body = release_path.read_bytes()
    expected_release_sha256 = PurePosixPath(release_key).stem
    if _sha256(release_body) != expected_release_sha256:
        raise ValueError(f"release hash mismatch: {release_key}")
    try:
        manifest = json.loads(release_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid release JSON: {release_key}") from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("unsupported release manifest")

    boards = manifest.get("boards")
    if not isinstance(boards, list) or len(boards) != manifest.get("board_count"):
        raise ValueError("release board count mismatch")
    board_posts: set[tuple[str, int, str]] = set()
    post_keys: set[str] = set()
    comment_count = 0
    board_ids: set[str] = set()
    for board_ref in boards:
        board, _ = _read_ref(root, board_ref)
        board_id = board.get("board_id")
        posts = board.get("posts")
        if (
            not isinstance(board_id, str)
            or board_id in board_ids
            or not isinstance(posts, list)
            or len(posts) != cast(dict[str, Any], board_ref).get("post_count")
        ):
            raise ValueError("invalid board manifest")
        board_ids.add(board_id)
        for summary in posts:
            if not isinstance(summary, dict) or summary.get("board_id") != board_id:
                raise ValueError(f"invalid post summary in board: {board_id}")
            payload, _ = _read_ref(root, summary)
            post = payload.get("post")
            comments = payload.get("comments")
            if (
                not isinstance(post, dict)
                or post.get("board_id") != board_id
                or post.get("external_post_id") != summary.get("external_post_id")
                or not isinstance(comments, list)
                or len(comments) != summary.get("comment_count")
            ):
                raise ValueError(f"post object does not match summary: {summary.get('object_key')}")
            identity = (
                board_id,
                int(summary["external_post_id"]),
                str(summary["payload_sha256"]),
            )
            if identity in board_posts:
                raise ValueError(f"duplicate post summary: {board_id}/{identity[1]}")
            board_posts.add(identity)
            post_keys.add(str(summary["object_key"]))
            comment_count += len(comments)

    search, _ = _read_ref(root, manifest.get("search"))
    search_rows = search.get("posts")
    search_fields = search.get("fields")
    if search_fields not in (_SEARCH_FIELDS, _SEARCH_FIELDS_WITH_AA) or not isinstance(
        search_rows, list
    ):
        raise ValueError("invalid search index")
    assert isinstance(search_fields, list)
    search_posts = {
        (str(row[0]), int(row[1]), str(row[6]))
        for row in search_rows
        if isinstance(row, list)
        and len(row) == len(search_fields)
        and (search_fields == _SEARCH_FIELDS or isinstance(row[7], bool) or row[7] in (0, 1))
    }
    if len(search_posts) != len(search_rows) or search_posts != board_posts:
        raise ValueError("search index does not match board manifests")

    collection_index, _ = _read_ref(root, manifest.get("collections"))
    collection_rows = collection_index.get("collections")
    if not isinstance(collection_rows, list):
        raise ValueError("invalid collection index")
    collection_summaries: dict[int, dict[str, Any]] | None = None
    membership_rows: dict[tuple[str, int], tuple[int, int]] | None = None
    if collection_index.get("schema_version") == 2:
        collection_summaries = {}
        for summary in collection_rows:
            if (
                not isinstance(summary, dict)
                or type(summary.get("id")) is not int
                or not isinstance(summary.get("board_id"), str)
                or not isinstance(summary.get("kind"), str)
                or not isinstance(summary.get("title"), str)
                or type(summary.get("entry_count")) is not int
                or summary["entry_count"] < 0
                or summary["id"] in collection_summaries
            ):
                raise ValueError("invalid collection summary")
            collection_summaries[summary["id"]] = summary
        collection_rows = []
        detail_shards = collection_index.get("detail_shards")
        memberships = collection_index.get("memberships")
        _collection_nested_refs(collection_index)
        assert isinstance(detail_shards, list) and isinstance(memberships, list)
        seen_shards: set[int] = set()
        for detail_ref in detail_shards:
            assert isinstance(detail_ref, dict)
            detail, _ = _read_ref(root, detail_ref)
            shard = detail_ref.get("shard")
            rows = detail.get("collections")
            if (
                type(shard) is not int
                or shard in seen_shards
                or detail.get("schema_version") != 1
                or detail.get("shard") != shard
                or not isinstance(rows, list)
            ):
                raise ValueError("invalid collection detail shard")
            seen_shards.add(shard)
            collection_rows.extend(rows)
        membership_rows = {}
        seen_membership_boards: set[str] = set()
        for membership_ref in memberships:
            assert isinstance(membership_ref, dict)
            membership, _ = _read_ref(root, membership_ref)
            board_id = membership_ref.get("board_id")
            members = membership.get("members")
            if (
                not isinstance(board_id, str)
                or board_id in seen_membership_boards
                or membership.get("schema_version") != 1
                or membership.get("board_id") != board_id
                or not isinstance(members, list)
            ):
                raise ValueError("invalid collection membership")
            seen_membership_boards.add(board_id)
            for member in members:
                if (
                    not isinstance(member, list)
                    or len(member) != 3
                    or any(type(value) is not int or value <= 0 for value in member)
                    or (board_id, member[0]) in membership_rows
                ):
                    raise ValueError("invalid collection membership row")
                membership_rows[(board_id, member[0])] = (member[1], member[2])
    elif collection_index.get("schema_version") != 1:
        raise ValueError("unsupported collection index")
    entry_count = 0
    expected_memberships: dict[tuple[str, int], tuple[int, int]] = {}
    for collection in collection_rows:
        if (
            not isinstance(collection, dict)
            or type(collection.get("id")) is not int
            or not isinstance(collection.get("board_id"), str)
            or not isinstance(collection.get("kind"), str)
            or not isinstance(collection.get("title"), str)
            or not isinstance(collection.get("entries"), list)
        ):
            raise ValueError("invalid collection")
        summary = collection_summaries.get(collection["id"]) if collection_summaries else None
        if summary is not None and (
            summary["board_id"] != collection["board_id"]
            or summary["kind"] != collection["kind"]
            or summary["title"] != collection["title"]
            or summary["entry_count"] != len(collection["entries"])
        ):
            raise ValueError("collection summary does not match detail")
        for position, entry in enumerate(collection["entries"], 1):
            if (
                not isinstance(entry, dict)
                or entry.get("position") != position
                or not isinstance(entry.get("board_id"), str)
                or type(entry.get("external_post_id")) is not int
            ):
                raise ValueError("invalid collection entry")
            object_key = entry.get("object_key")
            if object_key is not None and object_key not in post_keys:
                raise ValueError(f"collection references unknown post object: {object_key}")
            membership_identity = (entry["board_id"], entry["external_post_id"])
            if membership_identity in expected_memberships:
                raise ValueError("post belongs to multiple collections")
            expected_memberships[membership_identity] = (collection["id"], position)
            entry_count += 1
    if collection_summaries is not None and (
        len(collection_rows) != len(collection_summaries)
        or {row["id"] for row in collection_rows} != set(collection_summaries)
        or membership_rows != expected_memberships
    ):
        raise ValueError("collection index does not match detail objects")

    expected = {
        "post_count": len(board_posts),
        "comment_count": comment_count,
        "board_count": len(board_ids),
        "collection_count": len(collection_rows),
        "collection_entry_count": entry_count,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(f"release {key} mismatch")
    unavailable = {}
    for key in ("unavailable_post_count", "unavailable_comment_count"):
        unavailable_value = manifest.get(key)
        if not isinstance(unavailable_value, int) or unavailable_value < 0:
            raise ValueError(f"invalid release {key}")
        unavailable[key] = unavailable_value
    search_ref = cast(dict[str, Any], manifest["search"])
    collection_ref = cast(dict[str, Any], manifest["collections"])
    if search_ref.get("post_count") != len(search_rows):
        raise ValueError("search reference count mismatch")
    if (
        collection_ref.get("collection_count") != len(collection_rows)
        or collection_ref.get("entry_count") != entry_count
    ):
        raise ValueError("collection reference count mismatch")
    return {"release_key": release_key, **expected, **unavailable}


def validate_incremental_release(root: Path, release: str) -> dict[str, int | str]:
    """Validate the current exporter-owned release without opening unchanged post bodies."""
    root = root.expanduser().resolve(strict=True)
    release_key = _release_key(release)
    try:
        raw_state = json.loads(_state_path(root).read_text(encoding="utf-8"))
        source_identity = raw_state.get("source") if isinstance(raw_state, dict) else None
        if (
            not isinstance(source_identity, dict)
            or set(source_identity) != {"path", "application_id", "schema_version"}
            or not isinstance(source_identity.get("path"), str)
        ):
            raise ValueError("invalid export state source")
        source = Path(source_identity["path"]).expanduser().resolve(strict=True)
        with connect_archive(source, read_only=True) as connection:
            current_identity = _source_identity(source, connection)
            compatible_schema_versions = _database_projection_schema_versions(connection)
        state = _read_state(_state_path(root), current_identity, compatible_schema_versions)
        if (
            state is None
            or state["pending"] is not None
            or not isinstance(state["base"], dict)
            or state["base"].get("release_key") != release_key
            or _pointer_key(root) != release_key
        ):
            raise ValueError("release is not the finalized exporter state")
        base = _load_base_release(root, release_key)
        fingerprint = state["base"].get("fingerprint")
        if not isinstance(fingerprint, dict):
            raise ValueError("invalid export state fingerprint")
        for key in (
            "post_count",
            "unavailable_post_count",
            "unavailable_comment_count",
            "board_count",
            "collection_count",
            "collection_entry_count",
        ):
            if base.manifest.get(key) != fingerprint.get(key):
                raise ValueError(f"export state {key} does not match release")
        return {
            "release_key": release_key,
            **{
                key: cast(int, base.manifest[key])
                for key in (
                    "post_count",
                    "comment_count",
                    "board_count",
                    "collection_count",
                    "collection_entry_count",
                    "unavailable_post_count",
                    "unavailable_comment_count",
                )
            },
        }
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RuntimeError, ValueError) as error:
        raise IncrementalExportError(
            "incremental_publish_validation_failed",
            "current release is not backed by a finalized verified export state",
        ) from error


def activate_release(root: Path, release: str) -> dict[str, Any]:
    root = root.expanduser().resolve(strict=True)
    validation = validate_release(root, release)
    release_key = str(validation["release_key"])
    release_body = (root / release_key).read_bytes()
    pointer = root / "release.json"
    previous_key = None
    if pointer.is_file():
        previous_body = pointer.read_bytes()
        previous_key = f"releases/{_sha256(previous_body)}.json"
    _atomic_replace(pointer, release_body, durable=True)
    return {**validation, "previous_release_key": previous_key}


def _post_row_matches_ref(row: sqlite3.Row, stored: _StoredPostRef) -> bool:
    summary = stored.summary
    return (
        str(row["board_id"]) == summary.board_id
        and int(row["external_post_id"]) == summary.external_post_id
        and str(row["title"]) == summary.title
        and row["author"] == summary.author
        and row["category"] == summary.category
        and row["created_at_raw"] == summary.created_at_raw
        and bool(row["is_aa"]) == summary.is_aa
        and int(row["comment_count"]) == summary.comment_count
        and _row_source_projection_sha256(row) == stored.source_projection_sha256
    )


def _projection_rows(connection: sqlite3.Connection) -> Iterator[sqlite3.Row]:
    return iter(
        connection.execute(
            """
            SELECT p.id AS post_id, p.board_id, p.external_post_id, p.canonical_url,
                   p.title, p.author, p.category, p.created_at_source, p.created_at_raw,
                   p.views, p.is_aa, p.comment_count, p.latest_version_id,
                   v.content_sha256, v.comments_sha256, v.capture_origin, v.warc_record_id
            FROM posts AS p
            JOIN post_versions AS v ON v.id = p.latest_version_id
            ORDER BY p.id
            """
        )
    )


def _changed_post_ids(
    connection: sqlite3.Connection,
    base: _BaseRelease,
    capture_low_water: int,
    capture_high_water: int,
) -> list[int]:
    changed = {
        int(row[0])
        for row in connection.execute(
            """
            SELECT DISTINCT post_id
            FROM captures
            WHERE id > ? AND id <= ? AND entity_type = 'post'
              AND outcome = 'stored' AND post_id IS NOT NULL
            """,
            (capture_low_water, capture_high_water),
        )
    }
    current_ids: set[int] = set()
    for row in _projection_rows(connection):
        post_id = int(row["post_id"])
        current_ids.add(post_id)
        stored = _base_post_ref(base.post_refs, str(row["board_id"]), int(row["external_post_id"]))
        if stored is None or not _post_row_matches_ref(row, stored):
            changed.add(post_id)
    return sorted(changed & current_ids)


def _chunks(values: list[int], size: int = 500) -> Iterator[list[int]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _changed_tasks(
    connection: sqlite3.Connection, output: Path, post_ids: list[int]
) -> list[_PostTask]:
    comments: dict[int, list[NormalizedComment]] = defaultdict(list)
    for chunk in _chunks(post_ids):
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"""
            SELECT post_id, position, source_comment_id, parent_position, depth,
                   author, content_html, content_text, created_at_raw
            FROM comments
            WHERE post_id IN ({placeholders})
            ORDER BY post_id, position
            """,
            chunk,
        ):
            comments[int(row["post_id"])].append(_comment(row))

    tasks: list[_PostTask] = []
    for chunk in _chunks(post_ids):
        placeholders = ",".join("?" for _ in chunk)
        for row in connection.execute(
            f"""
            SELECT p.id AS post_id, p.board_id, p.external_post_id, p.canonical_url,
                   p.title, p.author, p.category, p.created_at_source, p.created_at_raw,
                   p.views, p.is_aa, v.content_sha256, v.capture_origin,
                   v.body_html_zstd, v.body_text_zstd, v.comments_sha256, v.warc_record_id
            FROM posts AS p
            JOIN post_versions AS v ON v.id = p.latest_version_id
            WHERE p.id IN ({placeholders})
            ORDER BY p.id
            """,
            chunk,
        ):
            origin = str(row["capture_origin"])
            if origin not in {"live", "legacy_import", "reparse"}:
                raise ValueError(f"unsupported capture origin: {origin}")
            post_id = int(row["post_id"])
            tasks.append(
                _PostTask(
                    output,
                    post_id,
                    str(row["created_at_source"] or ""),
                    _post_from_row(row, tuple(comments.get(post_id, ()))),
                    cast(Literal["live", "legacy_import", "reparse"], origin),
                )
            )
    if len(tasks) != len(post_ids):
        raise IncrementalExportError(
            "incremental_snapshot_changed", "a changed post disappeared from the read snapshot"
        )
    return tasks


def _collection_entry_rows(
    connection: sqlite3.Connection, collection_id: int
) -> Iterator[sqlite3.Row]:
    return iter(
        connection.execute(
            """
            SELECT ce.position, ce.post_id, ce.source_external_post_id,
                   ce.title AS entry_title, c.board_id AS collection_board_id,
                   p.board_id, p.external_post_id,
                   p.title AS post_title, p.availability, p.latest_version_id
            FROM collection_entries AS ce
            JOIN collections AS c ON c.id = ce.collection_id
            LEFT JOIN posts AS p ON p.id = ce.post_id
            WHERE ce.collection_id = ?
            ORDER BY ce.position
            """,
            (collection_id,),
        )
    )


def _collection_entry(
    row: sqlite3.Row, object_key_for_row: Callable[[sqlite3.Row], str | None]
) -> dict[str, object | None]:
    external_post_id = row["external_post_id"] or row["source_external_post_id"]
    board_id = row["board_id"] or row["collection_board_id"]
    if not isinstance(board_id, str) or type(external_post_id) is not int:
        raise ValueError("collection entry has no post identity")
    object_key = object_key_for_row(row)
    if row["latest_version_id"] is not None and object_key is None:
        raise ValueError(
            f"collection entry is missing a post object: {board_id}/{external_post_id}"
        )
    return {
        "position": int(row["position"]),
        "board_id": board_id,
        "external_post_id": external_post_id,
        "title": row["entry_title"] or row["post_title"],
        "availability": row["availability"] or "missing",
        "object_key": object_key,
    }


def _stage_collection_objects(
    connection: sqlite3.Connection,
    writer: _ObjectWriter,
    object_key_for_row: Callable[[sqlite3.Row], str | None],
) -> tuple[
    list[tuple[int, _StagedObject]],
    list[tuple[str, _StagedObject]],
    list[dict[str, object]],
    int,
    int,
]:
    collection_count = int(connection.execute("SELECT COUNT(*) FROM collections").fetchone()[0])
    entry_count = int(connection.execute("SELECT COUNT(*) FROM collection_entries").fetchone()[0])
    summaries = [
        {
            "id": int(row["id"]),
            "board_id": str(row["board_id"]),
            "kind": str(row["kind"]),
            "title": str(row["title"]),
            "entry_count": int(row["entry_count"]),
            "latest_created_at": row["latest_created_at"],
        }
        for row in connection.execute(
            """
            SELECT c.id, c.board_id, c.kind, c.title, COUNT(ce.position) AS entry_count,
                   MAX(p.created_at_source) AS latest_created_at
            FROM collections AS c
            LEFT JOIN collection_entries AS ce ON ce.collection_id = c.id
            LEFT JOIN posts AS p ON p.id = ce.post_id
            GROUP BY c.id
            ORDER BY c.id
            """
        )
    ]
    if len(summaries) != collection_count:
        raise ValueError("collection count changed while staging release")

    details: list[tuple[int, _StagedObject]] = []
    for shard in range(_COLLECTION_DETAIL_SHARDS):
        shard_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM collections WHERE id % ? = ?",
                (_COLLECTION_DETAIL_SHARDS, shard),
            ).fetchone()[0]
        )
        if not shard_count:
            continue

        def detail_chunks(shard: int = shard) -> Iterator[bytes]:
            written = 0
            yield b'{"collections":['
            for collection in connection.execute(
                """
                SELECT id, board_id, kind, title
                FROM collections WHERE id % ? = ? ORDER BY id
                """,
                (_COLLECTION_DETAIL_SHARDS, shard),
            ):
                if written:
                    yield b","
                entries = [
                    _collection_entry(row, object_key_for_row)
                    for row in _collection_entry_rows(connection, int(collection["id"]))
                ]
                if any(entry["position"] != index for index, entry in enumerate(entries, 1)):
                    raise ValueError("collection positions are not contiguous")
                yield _json_bytes(
                    {
                        "id": int(collection["id"]),
                        "board_id": str(collection["board_id"]),
                        "kind": str(collection["kind"]),
                        "title": str(collection["title"]),
                        "entries": entries,
                    }
                )[:-1]
                written += 1
            if written != shard_count:
                raise ValueError("collection shard changed while staging release")
            yield b'],"schema_version":1,"shard":' + str(shard).encode() + b"}\n"

        details.append(
            (
                shard,
                _stage_zstd_object(writer, f"collections/details-v2/{shard:02d}", detail_chunks()),
            )
        )

    membership_count = 0
    memberships: list[tuple[str, _StagedObject]] = []
    board_ids = [
        str(row[0])
        for row in connection.execute(
            """
            SELECT DISTINCT c.board_id
            FROM collections AS c
            JOIN collection_entries AS ce ON ce.collection_id = c.id
            ORDER BY c.board_id
            """
        )
    ]
    for board_id in board_ids:

        def membership_chunks(board_id: str = board_id) -> Iterator[bytes]:
            nonlocal membership_count
            written = 0
            yield b'{"board_id":' + _json_bytes(board_id)[:-1] + b',"members":['
            for row in connection.execute(
                """
                SELECT COALESCE(p.external_post_id, ce.source_external_post_id) AS external_post_id,
                       c.id AS collection_id, ce.position
                FROM collections AS c
                JOIN collection_entries AS ce ON ce.collection_id = c.id
                LEFT JOIN posts AS p ON p.id = ce.post_id
                WHERE c.board_id = ?
                ORDER BY COALESCE(p.external_post_id, ce.source_external_post_id), c.id, ce.position
                """,
                (board_id,),
            ):
                if written:
                    yield b","
                yield _json_bytes(
                    [
                        int(row["external_post_id"]),
                        int(row["collection_id"]),
                        int(row["position"]),
                    ]
                )[:-1]
                written += 1
                membership_count += 1
            yield b'],"schema_version":1}\n'

        memberships.append(
            (
                board_id,
                _stage_zstd_object(
                    writer, f"collections/membership-v2/{board_id}", membership_chunks()
                ),
            )
        )
    if membership_count != entry_count:
        raise ValueError("collection membership count does not match entries")
    return details, memberships, summaries, collection_count, entry_count


def _write_collection_objects(
    writer: _ObjectWriter,
    details: list[tuple[int, _StagedObject]],
    memberships: list[tuple[str, _StagedObject]],
    summaries: list[dict[str, object]],
    collection_count: int,
    entry_count: int,
) -> dict[str, object]:
    staged = [item for _key, item in [*details, *memberships]]
    try:
        detail_refs = [
            {"shard": shard, **_write_staged_zstd_object(writer, item)} for shard, item in details
        ]
        membership_refs = [
            {"board_id": board_id, **_write_staged_zstd_object(writer, item)}
            for board_id, item in memberships
        ]
        index = _json_bytes(
            {
                "schema_version": 2,
                "shard_count": _COLLECTION_DETAIL_SHARDS,
                "collections": summaries,
                "detail_shards": detail_refs,
                "memberships": membership_refs,
            }
        )
        return {
            **_write_zstd_object(
                writer,
                "collections/index-v2",
                index,
                level=_AGGREGATE_COMPRESSION_LEVEL,
            ),
            "collection_count": collection_count,
            "entry_count": entry_count,
        }
    finally:
        for item in staged:
            item.path.unlink(missing_ok=True)


def _write_projection_release(
    connection: sqlite3.Connection,
    writer: _ObjectWriter,
    post_refs: dict[str, dict[int, _StoredPostRef]],
    fingerprint: dict[str, int | str],
) -> tuple[bytes, dict[str, int]]:
    boards = [dict(row) for row in connection.execute("SELECT * FROM boards ORDER BY board_id")]
    staged_boards: list[tuple[dict[str, Any], int, _StagedObject]] = []
    post_count = 0
    for board in boards:
        board_id = str(board["board_id"])
        board_post_count = 0

        def board_chunks() -> Iterator[bytes]:
            nonlocal board_post_count
            yield (
                b'{"board_id":'
                + _json_bytes(board_id)[:-1]
                + b',"canonical_url":'
                + _json_bytes(board["canonical_url"])[:-1]
                + b',"group_name":'
                + _json_bytes(board["group_name"])[:-1]
                + b',"name":'
                + _json_bytes(board["name"])[:-1]
                + b',"posts":['
            )
            for row in connection.execute(
                """
                SELECT p.id AS post_id, p.board_id, p.external_post_id, p.canonical_url,
                       p.title, p.author, p.category, p.created_at_source, p.created_at_raw,
                       p.views, p.is_aa, p.comment_count, p.latest_version_id,
                       v.content_sha256, v.comments_sha256, v.capture_origin, v.warc_record_id
                FROM posts AS p
                JOIN post_versions AS v ON v.id = p.latest_version_id
                WHERE p.board_id = ?
                ORDER BY p.external_post_id DESC
                """,
                (board_id,),
            ):
                stored = _base_post_ref(post_refs, board_id, int(row["external_post_id"]))
                if stored is None:
                    raise ValueError(
                        f"projection is missing a post object: {board_id}/{row['external_post_id']}"
                    )
                if not _post_row_matches_ref(row, stored):
                    raise ValueError(f"post summary is stale: {board_id}/{row['external_post_id']}")
                if board_post_count:
                    yield b","
                yield _json_bytes(stored.as_dict())[:-1]
                board_post_count += 1
            yield b'],"schema_version":1}\n'

        staged_board = _stage_zstd_object(writer, f"boards/{board_id}/manifest-v2", board_chunks())
        staged_boards.append((board, board_post_count, staged_board))
        post_count += board_post_count

    staged_search, search_post_count = _stage_search_object(connection, writer, post_refs)

    def collection_object_key(row: sqlite3.Row) -> str | None:
        if row["latest_version_id"] is None:
            return None
        stored = _base_post_ref(
            post_refs,
            str(row["board_id"]),
            int(row["external_post_id"]),
        )
        return stored.summary.object_key if stored is not None else None

    (
        staged_collection_details,
        staged_collection_memberships,
        collection_summaries,
        collection_count,
        collection_entry_count,
    ) = _stage_collection_objects(connection, writer, collection_object_key)

    counts = {
        "post_count": post_count,
        "comment_count": int(
            connection.execute(
                "SELECT COALESCE(SUM(comment_count), 0) FROM posts "
                "WHERE latest_version_id IS NOT NULL"
            ).fetchone()[0]
        ),
        "unavailable_post_count": cast(int, fingerprint["unavailable_post_count"]),
        "unavailable_comment_count": cast(int, fingerprint["unavailable_comment_count"]),
        "board_count": len(staged_boards),
        "collection_count": collection_count,
        "collection_entry_count": collection_entry_count,
    }
    for key in (
        "post_count",
        "unavailable_post_count",
        "unavailable_comment_count",
        "board_count",
        "collection_count",
        "collection_entry_count",
    ):
        if counts[key] != fingerprint[key]:
            raise ValueError(f"snapshot {key} changed while building release")
    if search_post_count != post_count:
        raise ValueError("search post count changed while staging release")

    staged_objects = [
        *(staged for _board, _post_count, staged in staged_boards),
        staged_search,
        *(staged for _shard, staged in staged_collection_details),
        *(staged for _board_id, staged in staged_collection_memberships),
    ]
    post_refs.clear()
    gc.collect()
    try:
        board_refs: list[dict[str, object]] = []
        for board, board_post_count, staged in staged_boards:
            board_refs.append(
                {
                    "board_id": str(board["board_id"]),
                    "name": board["name"],
                    "group_name": board["group_name"],
                    "post_count": board_post_count,
                    **_write_staged_zstd_object(writer, staged),
                }
            )
        search_ref = {
            **_write_staged_zstd_object(writer, staged_search),
            "post_count": search_post_count,
        }
        collection_ref = _write_collection_objects(
            writer,
            staged_collection_details,
            staged_collection_memberships,
            collection_summaries,
            collection_count,
            collection_entry_count,
        )
    finally:
        for staged in staged_objects:
            staged.path.unlink(missing_ok=True)
    release_body = _json_bytes(
        {
            "schema_version": 1,
            "canonical_schema_version": SCHEMA_VERSION,
            "source": "typemoon",
            **counts,
            "boards": board_refs,
            "search": search_ref,
            "collections": collection_ref,
        }
    )
    return release_body, counts


def _activate_built_release(root: Path, release_key: str) -> dict[str, Any]:
    body = (root / _release_key(release_key)).read_bytes()
    if _sha256(body) != PurePosixPath(release_key).stem:
        raise ValueError("built release hash mismatch")
    previous_key = _pointer_key(root)
    _atomic_replace(root / "release.json", body, durable=True)
    return {"release_key": release_key, "previous_release_key": previous_key}


def _promote_release(
    root: Path,
    state_path: Path,
    identity: dict[str, object],
    base: dict[str, object] | None,
    pending: dict[str, object],
    *,
    deep_validate: bool,
) -> dict[str, Any]:
    journal = {
        "schema_version": _EXPORT_STATE_SCHEMA_VERSION,
        "source": identity,
        "base": base,
        "pending": pending,
    }
    _write_state(state_path, journal)
    activation = (
        activate_release(root, cast(str, pending["release_key"]))
        if deep_validate
        else _activate_built_release(root, cast(str, pending["release_key"]))
    )
    _write_state(state_path, {**journal, "base": pending, "pending": None})
    return activation


def _full_export_static(
    source: Path,
    output: Path,
    *,
    workers: int,
    base: dict[str, object] | None,
) -> dict[str, Any]:
    if workers < 1:
        raise ValueError("workers must be positive")
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"not a file: {source}")
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    writer = _ObjectWriter(output)
    board_posts: dict[str, list[dict[str, object]]] = defaultdict(list)
    search_rows: list[tuple[str, StaticPostSummary]] = []
    object_key_by_post_id: dict[int, str] = {}
    comment_count = 0

    with connect_archive(source, read_only=True) as connection:
        if int(connection.execute("PRAGMA application_id").fetchone()[0]) != APPLICATION_ID:
            raise ValueError("source is not a ReDSTM canonical archive")
        if int(connection.execute("PRAGMA user_version").fetchone()[0]) != SCHEMA_VERSION:
            raise ValueError(f"canonical schema v{SCHEMA_VERSION} is required")
        connection.execute("BEGIN")
        identity = _source_identity(source, connection)
        capture_high_water = int(
            connection.execute("SELECT COALESCE(MAX(id), 0) FROM captures").fetchone()[0]
        )
        boards = [dict(row) for row in connection.execute("SELECT * FROM boards ORDER BY board_id")]
        unavailable_counts = connection.execute(
            """
            SELECT COUNT(DISTINCT p.id) AS post_count, COUNT(c.position) AS comment_count
            FROM posts AS p
            LEFT JOIN comments AS c ON c.post_id = p.id
            WHERE p.latest_version_id IS NULL
            """
        ).fetchone()
        assert unavailable_counts is not None
        unavailable_post_count = int(unavailable_counts["post_count"])
        unavailable_comment_count = int(unavailable_counts["comment_count"])
        comment_groups = iter(_grouped_comments(connection))
        current_comments = next(comment_groups, None)

        def post_tasks() -> Iterator[_PostTask]:
            nonlocal current_comments
            for row in connection.execute(
                """
                SELECT p.id AS post_id, p.board_id, p.external_post_id, p.canonical_url,
                       p.title, p.author, p.category, p.created_at_source, p.created_at_raw,
                       p.views, p.is_aa, v.content_sha256, v.capture_origin,
                       v.body_html_zstd, v.body_text_zstd, v.comments_sha256, v.warc_record_id
                FROM posts AS p
                JOIN post_versions AS v ON v.id = p.latest_version_id
                ORDER BY p.id
                """
            ):
                current_post_id = int(row["post_id"])
                if current_comments is not None and current_comments[0] < current_post_id:
                    raise ValueError(
                        f"comments reference post without latest version: {current_comments[0]}"
                    )
                comments: tuple[NormalizedComment, ...] = ()
                if current_comments is not None and current_comments[0] == current_post_id:
                    comments = current_comments[1]
                    current_comments = next(comment_groups, None)
                origin = str(row["capture_origin"])
                if origin not in {"live", "legacy_import", "reparse"}:
                    raise ValueError(f"unsupported capture origin: {origin}")
                yield _PostTask(
                    output,
                    current_post_id,
                    str(row["created_at_source"] or ""),
                    _post_from_row(row, comments),
                    cast(Literal["live", "legacy_import", "reparse"], origin),
                )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            prepared_posts = executor.map(
                _prepare_static_post,
                post_tasks(),
                buffersize=workers * 2,
            )
            for prepared in prepared_posts:
                if prepared.reused:
                    writer.reused += 1
                else:
                    writer.write(prepared.summary.object_key, prepared.body)
                post_ref = {
                    **summary_dict(prepared.summary),
                    **_object_ref(prepared.summary.object_key, prepared.payload, prepared.body),
                    "source_projection_sha256": prepared.source_projection_sha256,
                }
                board_posts[prepared.summary.board_id].append(post_ref)
                search_rows.append((prepared.created_at_source, prepared.summary))
                object_key_by_post_id[prepared.post_id] = prepared.summary.object_key
                comment_count += prepared.summary.comment_count
                if len(search_rows) % 1000 == 0:
                    print(
                        json.dumps(
                            {
                                "exported_posts": len(search_rows),
                                "objects_written": writer.written,
                                "objects_reused": writer.reused,
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    )

        if current_comments is not None:
            raise ValueError(
                f"comments reference post without latest version: {current_comments[0]}"
            )

        board_refs: list[dict[str, object]] = []
        for board in boards:
            board_id = str(board["board_id"])
            posts = sorted(
                board_posts.get(board_id, []),
                key=lambda summary: cast(int, summary["external_post_id"]),
                reverse=True,
            )
            payload = _json_bytes(
                {
                    "schema_version": 1,
                    "board_id": board_id,
                    "name": board["name"],
                    "group_name": board["group_name"],
                    "canonical_url": board["canonical_url"],
                    "posts": posts,
                }
            )
            ref = _write_zstd_object(
                writer,
                f"boards/{board_id}/manifest-v2",
                payload,
                level=_AGGREGATE_COMPRESSION_LEVEL,
            )
            board_refs.append(
                {
                    "board_id": board_id,
                    "name": board["name"],
                    "group_name": board["group_name"],
                    "post_count": len(posts),
                    **ref,
                }
            )

        ordered_search = sorted(
            search_rows,
            key=lambda item: (item[0], item[1].external_post_id, item[1].board_id),
            reverse=True,
        )
        search_payload = _json_bytes(
            {
                "schema_version": 1,
                "fields": _SEARCH_FIELDS_WITH_AA,
                "posts": [
                    [
                        summary.board_id,
                        summary.external_post_id,
                        summary.title,
                        summary.author,
                        summary.category,
                        summary.created_at_raw,
                        summary.payload_sha256,
                        summary.is_aa,
                    ]
                    for _, summary in ordered_search
                ],
            }
        )
        search_ref = {
            **_write_zstd_object(
                writer,
                "search/title-author-v2",
                search_payload,
                level=_AGGREGATE_COMPRESSION_LEVEL,
            ),
            "post_count": len(ordered_search),
        }

        def collection_object_key(row: sqlite3.Row) -> str | None:
            if row["latest_version_id"] is None or row["post_id"] is None:
                return None
            return object_key_by_post_id.get(int(row["post_id"]))

        (
            staged_collection_details,
            staged_collection_memberships,
            collection_summaries,
            collection_count,
            collection_entry_count,
        ) = _stage_collection_objects(connection, writer, collection_object_key)
        collection_ref = _write_collection_objects(
            writer,
            staged_collection_details,
            staged_collection_memberships,
            collection_summaries,
            collection_count,
            collection_entry_count,
        )
        fingerprint = _snapshot_fingerprint(connection)

    post_count = len(search_rows)
    release_body = _json_bytes(
        {
            "schema_version": 1,
            "canonical_schema_version": SCHEMA_VERSION,
            "source": "typemoon",
            "post_count": post_count,
            "comment_count": comment_count,
            "unavailable_post_count": unavailable_post_count,
            "unavailable_comment_count": unavailable_comment_count,
            "board_count": len(board_refs),
            "collection_count": collection_count,
            "collection_entry_count": collection_entry_count,
            "boards": board_refs,
            "search": search_ref,
            "collections": collection_ref,
        }
    )
    release_key = f"releases/{_sha256(release_body)}.json"
    writer.write(release_key, release_body)
    activation = _promote_release(
        output,
        _state_path(output),
        identity,
        base,
        _snapshot(release_key, capture_high_water, fingerprint),
        deep_validate=True,
    )
    return {
        **activation,
        "objects_written": writer.written,
        "objects_reused": writer.reused,
        "mode": "full",
        "capture_high_water": capture_high_water,
        "snapshot_consistent": True,
        "source_unchanged": True,
    }


def _incremental_export_static(
    source: Path,
    output: Path,
    state: dict[str, Any],
    *,
    workers: int,
    max_changed_posts: int,
) -> dict[str, Any]:
    base_snapshot = cast(dict[str, object], state["base"])
    try:
        base = _load_base_release(output, cast(str, base_snapshot["release_key"]))
    except (OSError, ValueError) as error:
        raise IncrementalExportError(
            "incremental_bootstrap_required",
            "verified base release is missing or corrupt; run an explicit full export",
        ) from error
    base_fingerprint = cast(dict[str, int | str], base_snapshot["fingerprint"])
    for key in (
        "post_count",
        "unavailable_post_count",
        "unavailable_comment_count",
        "board_count",
        "collection_count",
        "collection_entry_count",
    ):
        if base.manifest.get(key) != base_fingerprint[key]:
            raise IncrementalExportError(
                "incremental_state_invalid", f"base state {key} does not match its release"
            )

    writer = _ObjectWriter(output)
    with connect_archive(source, read_only=True) as connection:
        current_identity = _source_identity(source, connection)
        compatible_schema_versions = _database_projection_schema_versions(connection)
        if not _source_identity_matches(
            state["source"], current_identity, compatible_schema_versions
        ):
            raise IncrementalExportError(
                "incremental_source_changed", "canonical source identity changed"
            )
        connection.execute("BEGIN")
        capture_high_water = int(
            connection.execute("SELECT COALESCE(MAX(id), 0) FROM captures").fetchone()[0]
        )
        capture_low_water = cast(int, base_snapshot["capture_high_water"])
        if capture_high_water < capture_low_water:
            raise IncrementalExportError(
                "incremental_source_rewound", "capture high-water moved backwards"
            )
        fingerprint = _snapshot_fingerprint(connection)
        next_snapshot = _snapshot(base.key, capture_high_water, fingerprint)
        if fingerprint == base_fingerprint:
            _write_state(
                _state_path(output),
                {
                    **state,
                    "source": current_identity,
                    "base": next_snapshot,
                    "pending": None,
                },
            )
            return {
                "release_key": base.key,
                "post_count": base.manifest["post_count"],
                "comment_count": base.manifest["comment_count"],
                "objects_written": 0,
                "objects_reused": sum(len(posts) for posts in base.post_refs.values())
                + cast(int, base.manifest["board_count"])
                + 3,
                "changed_posts": 0,
                "mode": "incremental_noop",
                "capture_high_water": capture_high_water,
                "snapshot_consistent": True,
                "source_unchanged": True,
            }

        changed_post_ids = _changed_post_ids(
            connection, base, capture_low_water, capture_high_water
        )
        if (
            fingerprint["projection_sha256"] != base_fingerprint["projection_sha256"]
            and not changed_post_ids
            and fingerprint["post_count"] == base_fingerprint["post_count"]
        ):
            raise IncrementalExportError(
                "incremental_projection_untracked",
                "post projection changed without a matching stored capture",
            )
        if max_changed_posts and len(changed_post_ids) > max_changed_posts:
            raise IncrementalExportError(
                "incremental_delta_too_large",
                f"delta has {len(changed_post_ids)} changed posts; limit is {max_changed_posts}",
            )

        post_refs = base.post_refs
        tasks = _changed_tasks(connection, output, changed_post_ids)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for prepared in executor.map(_prepare_static_post, tasks, buffersize=workers * 2):
                if prepared.reused:
                    writer.reused += 1
                else:
                    writer.write(prepared.summary.object_key, prepared.body)
                ref: dict[str, object] = {
                    **summary_dict(prepared.summary),
                    **_object_ref(prepared.summary.object_key, prepared.payload, prepared.body),
                    "source_projection_sha256": prepared.source_projection_sha256,
                }
                post_refs.setdefault(prepared.summary.board_id, {})[
                    prepared.summary.external_post_id
                ] = _stored_post_ref(ref)
        release_body, counts = _write_projection_release(connection, writer, post_refs, fingerprint)

    release_key = f"releases/{_sha256(release_body)}.json"
    writer.write(release_key, release_body)
    pending = _snapshot(release_key, capture_high_water, fingerprint)
    activation = _promote_release(
        output,
        _state_path(output),
        current_identity,
        base_snapshot,
        pending,
        deep_validate=False,
    )
    return {
        **activation,
        **counts,
        "objects_written": writer.written,
        "objects_reused": writer.reused,
        "changed_posts": len(changed_post_ids),
        "mode": "incremental",
        "capture_high_water": capture_high_water,
        "snapshot_consistent": True,
        "source_unchanged": True,
    }


def export_static(
    source: Path,
    output: Path,
    *,
    workers: int = 1,
    incremental_only: bool = False,
    force_full: bool = False,
    max_changed_posts: int = REDSTM_EXPORT_MAX_CHANGED_POSTS,
) -> dict[str, Any]:
    if workers < 1:
        raise ValueError("workers must be positive")
    if max_changed_posts < 0:
        raise ValueError("max_changed_posts must not be negative")
    if incremental_only and force_full:
        raise ValueError("incremental_only and force_full are mutually exclusive")
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"not a file: {source}")
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    with connect_archive(source, read_only=True) as connection:
        identity = _source_identity(source, connection)
        compatible_schema_versions = _database_projection_schema_versions(connection)
    if identity["application_id"] != APPLICATION_ID or identity["schema_version"] != SCHEMA_VERSION:
        raise ValueError("source is not the required ReDSTM canonical archive")
    if force_full:
        try:
            state = _recover_state(
                output, _state_path(output), identity, compatible_schema_versions
            )
        except IncrementalExportError:
            state = None
        return _full_export_static(
            source,
            output,
            workers=workers,
            base=cast(dict[str, object], state["base"]) if state is not None else None,
        )
    state = _recover_state(output, _state_path(output), identity, compatible_schema_versions)
    if state is not None:
        return _incremental_export_static(
            source,
            output,
            state,
            workers=workers,
            max_changed_posts=max_changed_posts,
        )
    if incremental_only:
        raise IncrementalExportError(
            "incremental_bootstrap_required",
            "verified export state is missing or invalid; run an explicit full export",
        )
    return _full_export_static(source, output, workers=workers, base=None)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export or activate a static ReDSTM release.")
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("source", type=Path)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    mode = export.add_mutually_exclusive_group()
    mode.add_argument("--incremental-only", action="store_true")
    mode.add_argument("--full", action="store_true")
    export.add_argument("--max-changed-posts", type=int, default=REDSTM_EXPORT_MAX_CHANGED_POSTS)
    activate = commands.add_parser("activate")
    activate.add_argument("output", type=Path)
    activate.add_argument("release")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.command == "export":
            report = export_static(
                args.source,
                args.output,
                workers=args.workers,
                incremental_only=args.incremental_only,
                force_full=args.full,
                max_changed_posts=args.max_changed_posts,
            )
        else:
            report = activate_release(args.output, args.release)
    except IncrementalExportError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": "partial",
                    "safe_code": error.code,
                    "message": str(error),
                },
                ensure_ascii=False,
            )
        )
        return 2
    except (OSError, RuntimeError, ValueError) as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": "failed",
                    "safe_code": "export_failed",
                    "message": str(error),
                },
                ensure_ascii=False,
            )
        )
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
