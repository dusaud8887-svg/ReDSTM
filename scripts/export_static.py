from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from collections import defaultdict
from collections.abc import Iterator
from compression import zstd
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast

from crawler.archive import APPLICATION_ID, SCHEMA_VERSION, connect_archive, decompress_body
from crawler.pipelines import NormalizedComment, NormalizedPost
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
_COMPRESSION_LEVEL = 15


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
    summary: StaticPostSummary
    payload: bytes
    body: bytes
    reused: bool


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
        payload.summary,
        payload.payload,
        body,
        reused,
    )


def _object_ref(key: str, payload: bytes, body: bytes) -> dict[str, object]:
    return {
        "object_key": key,
        "payload_sha256": _sha256(payload),
        "object_sha256": _sha256(body),
        "object_bytes": len(body),
    }


def _write_zstd_object(writer: _ObjectWriter, prefix: str, payload: bytes) -> dict[str, object]:
    payload_sha256 = _sha256(payload)
    key = f"{prefix}-{payload_sha256}.json.zst"
    body = zstd.compress(payload, level=_COMPRESSION_LEVEL)
    writer.write(key, body)
    return _object_ref(key, payload, body)


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
    if search.get("fields") != _SEARCH_FIELDS or not isinstance(search_rows, list):
        raise ValueError("invalid search index")
    search_posts = {
        (str(row[0]), int(row[1]), str(row[6]))
        for row in search_rows
        if isinstance(row, list) and len(row) == len(_SEARCH_FIELDS)
    }
    if len(search_posts) != len(search_rows) or search_posts != board_posts:
        raise ValueError("search index does not match board manifests")

    collections, _ = _read_ref(root, manifest.get("collections"))
    collection_rows = collections.get("collections")
    if not isinstance(collection_rows, list):
        raise ValueError("invalid collection index")
    entry_count = 0
    for collection in collection_rows:
        if not isinstance(collection, dict) or not isinstance(collection.get("entries"), list):
            raise ValueError("invalid collection")
        for entry in collection["entries"]:
            if not isinstance(entry, dict):
                raise ValueError("invalid collection entry")
            object_key = entry.get("object_key")
            if object_key is not None and object_key not in post_keys:
                raise ValueError(f"collection references unknown post object: {object_key}")
            entry_count += 1

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


def export_static(source: Path, output: Path, *, workers: int = 1) -> dict[str, Any]:
    if workers < 1:
        raise ValueError("workers must be positive")
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"not a file: {source}")
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    source_before = source.stat()
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
            ref = _write_zstd_object(writer, f"boards/{board_id}/manifest", payload)
            board_refs.append({"board_id": board_id, "post_count": len(posts), **ref})

        ordered_search = sorted(
            search_rows,
            key=lambda item: (item[0], item[1].external_post_id, item[1].board_id),
            reverse=True,
        )
        search_payload = _json_bytes(
            {
                "schema_version": 1,
                "fields": _SEARCH_FIELDS,
                "posts": [
                    [
                        summary.board_id,
                        summary.external_post_id,
                        summary.title,
                        summary.author,
                        summary.category,
                        summary.created_at_raw,
                        summary.payload_sha256,
                    ]
                    for _, summary in ordered_search
                ],
            }
        )
        search_ref = {
            **_write_zstd_object(writer, "search/title-author", search_payload),
            "post_count": len(ordered_search),
        }

        collections: list[dict[str, object]] = []
        collection_by_id: dict[int, dict[str, object]] = {}
        for row in connection.execute(
            "SELECT id, board_id, kind, title FROM collections ORDER BY id"
        ):
            collection: dict[str, object] = {
                "id": int(row["id"]),
                "board_id": row["board_id"],
                "kind": str(row["kind"]),
                "title": str(row["title"]),
                "entries": [],
            }
            collections.append(collection)
            collection_by_id[int(row["id"])] = collection
        collection_entry_count = 0
        for row in connection.execute(
            """
            SELECT ce.collection_id, ce.position, ce.post_id, ce.source_external_post_id,
                   ce.title AS entry_title, p.board_id, p.external_post_id,
                   p.title AS post_title, p.availability
            FROM collection_entries AS ce
            LEFT JOIN posts AS p ON p.id = ce.post_id
            ORDER BY ce.collection_id, ce.position
            """
        ):
            post_id = int(row["post_id"]) if row["post_id"] is not None else None
            entries = cast(
                list[dict[str, object]],
                collection_by_id[int(row["collection_id"])]["entries"],
            )
            entries.append(
                {
                    "position": int(row["position"]),
                    "board_id": row["board_id"],
                    "external_post_id": row["external_post_id"]
                    if row["external_post_id"] is not None
                    else row["source_external_post_id"],
                    "title": row["entry_title"] or row["post_title"],
                    "availability": row["availability"],
                    "object_key": (
                        object_key_by_post_id.get(post_id) if post_id is not None else None
                    ),
                }
            )
            collection_entry_count += 1
        collection_payload = _json_bytes({"schema_version": 1, "collections": collections})
        collection_ref = {
            **_write_zstd_object(writer, "collections/all", collection_payload),
            "collection_count": len(collections),
            "entry_count": collection_entry_count,
        }

    source_after = source.stat()
    if (source_before.st_size, source_before.st_mtime_ns) != (
        source_after.st_size,
        source_after.st_mtime_ns,
    ):
        raise RuntimeError("source database changed during export")

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
            "collection_count": len(collections),
            "collection_entry_count": collection_entry_count,
            "boards": board_refs,
            "search": search_ref,
            "collections": collection_ref,
        }
    )
    release_key = f"releases/{_sha256(release_body)}.json"
    writer.write(release_key, release_body)
    activation = activate_release(output, release_key)
    return {
        **activation,
        "objects_written": writer.written,
        "objects_reused": writer.reused,
        "source_unchanged": True,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export or activate a static ReDSTM release.")
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("source", type=Path)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    activate = commands.add_parser("activate")
    activate.add_argument("output", type=Path)
    activate.add_argument("release")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.command == "export":
        report = export_static(args.source, args.output, workers=args.workers)
    else:
        report = activate_release(args.output, args.release)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
