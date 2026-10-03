"""Store one committed Newtomi Arcalive media batch in R2 under its CDN path keys (docs/20)."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.text_archive.runtime import RuntimeWindowError, operation_window

_BATCH_ID = re.compile(r"\d{8}T\d{6}Z-media-[a-f0-9]{8}\Z")
# Same rule as edge/public/arca-media.js PATH_KEY.
_PATH_KEY = re.compile(r"[a-z0-9]{2,20}/[a-f0-9]{16,128}\.(?:png|jpe?g|webp|gif|avif)\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
# Text and both lanes are both published; Newtomi archives the images of either.
_POST = re.compile(r"arcalive:[A-Za-z0-9_-]{1,80}:[1-9][0-9]{0,12}:(?:text|both)\Z")
_TYPES = {"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif"}
_MANIFEST_FIELDS = {"schema", "kind", "batch_id", "producer", "items"}
_ITEM_FIELDS = {
    "path_key",
    "relative_path",
    "content_type",
    "bytes",
    "sha256",
    "width",
    "height",
    "post",
}
_MAX_ITEMS = 200
_MAX_FILE_BYTES = 8 * 1024 * 1024
_MAX_BATCH_BYTES = 48 * 1024 * 1024
_MAX_MANIFEST_BYTES = 256 * 1024
# Arcalive answers unsigned or expired requests with this fixed 200x200 "access denied" image.
_DENIED_PLACEHOLDER_SHA256 = "f2a44313661ef4ab6ad83b675c12452ca28f568ee5ee5ccd7bc26ddfac7b8c0b"
_REMOTE = "r2text:redstm-text-archive"
_RCLONE_CONFIG = "/etc/redstm-text/rclone.conf"
_RCLONE_TIMEOUT_S = 600

_SCHEMA = """
CREATE TABLE IF NOT EXISTS text_archive_media (
    path_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
    post TEXT NOT NULL, batch_id TEXT NOT NULL, stored_at TEXT NOT NULL
);
"""

Runner = Callable[..., Any]


class MediaBatchRejectedError(ValueError):
    pass


class MediaBatchNotReadyError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def sniff_image_type(head: bytes) -> str | None:
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] == b"GIF8":
        return "image/gif"
    return None


def _json_file(path: Path, limit: int) -> tuple[dict[str, Any], bytes]:
    if path.is_symlink() or not path.is_file():
        raise MediaBatchRejectedError(f"{path.name}_missing")
    if path.stat().st_size > limit:
        raise MediaBatchRejectedError(f"{path.name}_too_large")
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise MediaBatchRejectedError(f"{path.name}_invalid") from exc
    if not isinstance(value, dict):
        raise MediaBatchRejectedError(f"{path.name}_invalid")
    return value, raw


def _positive_int(value: Any, upper: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= upper


def _item_reason(item: dict[str, Any], source: Path) -> str:
    """Per-item checks; a failing item is rejected without failing its batch."""
    content_type = item.get("content_type")
    extension = _TYPES.get(content_type) if isinstance(content_type, str) else None
    if extension is None:
        return "content_type_invalid"
    if not re.fullmatch(rf"files/[0-9]{{6}}\.{extension}", item["relative_path"]):
        return "relative_path_type_mismatch"
    if not isinstance(item.get("post"), str) or not _POST.fullmatch(item["post"]):
        return "post_invalid"
    if not _positive_int(item.get("width"), 20000) or not _positive_int(item.get("height"), 20000):
        return "dimensions_invalid"
    size, digest = item.get("bytes"), item.get("sha256")
    if not _positive_int(size, _MAX_FILE_BYTES) or not isinstance(digest, str):
        return "content_metadata_invalid"
    if not _SHA256.fullmatch(digest):
        return "content_metadata_invalid"
    if digest == _DENIED_PLACEHOLDER_SHA256:
        return "placeholder_image"
    if source.is_symlink() or not source.is_file():
        return "content_missing"
    if source.stat().st_size != size:
        return "size_mismatch"
    hasher = hashlib.sha256()
    with source.open("rb") as stream:
        head = stream.read(12)
        hasher.update(head)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    if hasher.hexdigest() != digest:
        return "sha256_mismatch"
    if sniff_image_type(head) != content_type:
        return "magic_mismatch"
    return ""


def validate_batch(inbox_root: Path, batch_id: str) -> tuple[str, list[dict[str, Any]]]:
    """Structural problems reject the whole batch; item problems only mark that item."""
    if not _BATCH_ID.fullmatch(batch_id):
        raise MediaBatchRejectedError("batch_id_invalid")
    drop = inbox_root / "drop"
    batch_dir = drop / batch_id
    if any(path.is_symlink() for path in (inbox_root, drop, batch_dir)):
        raise MediaBatchRejectedError("batch_path_symlink")
    if not batch_dir.is_dir():
        raise MediaBatchNotReadyError("batch_not_found")
    if not (batch_dir / "ready.json").exists():
        raise MediaBatchNotReadyError("ready_marker_missing")
    ready, _ = _json_file(batch_dir / "ready.json", 16 * 1024)
    manifest, manifest_bytes = _json_file(batch_dir / "manifest.json", _MAX_MANIFEST_BYTES)
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    if (
        set(ready) != {"schema", "batch_id", "manifest_sha256"}
        or type(ready.get("schema")) is not int
        or ready["schema"] != 1
        or ready["batch_id"] != batch_id
    ):
        raise MediaBatchRejectedError("ready_marker_invalid")
    if ready["manifest_sha256"] != manifest_sha:
        raise MediaBatchRejectedError("manifest_digest_mismatch")
    items = manifest.get("items")
    if (
        set(manifest) != _MANIFEST_FIELDS
        or type(manifest.get("schema")) is not int
        or manifest["schema"] != 1
        or manifest["kind"] != "arcalive_media"
        or manifest["batch_id"] != batch_id
        or manifest["producer"] != "newtomi-pc"
        or not isinstance(items, list)
        or not 1 <= len(items) <= _MAX_ITEMS
    ):
        raise MediaBatchRejectedError("manifest_invalid")
    files_dir = batch_dir / "files"
    if files_dir.is_symlink() or not files_dir.is_dir():
        raise MediaBatchRejectedError("files_dir_invalid")
    actual = set()
    for entry in files_dir.iterdir():
        if entry.is_symlink() or not entry.is_file():
            raise MediaBatchRejectedError("batch_entry_invalid")
        actual.add(entry.name)
        if len(actual) > _MAX_ITEMS:
            raise MediaBatchRejectedError("too_many_batch_files")
    listed: set[str] = set()
    paths: set[str] = set()
    total = 0
    checked: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != _ITEM_FIELDS:
            raise MediaBatchRejectedError("item_fields_invalid")
        path_key, relative = item["path_key"], item["relative_path"]
        if not isinstance(path_key, str) or not _PATH_KEY.fullmatch(path_key):
            raise MediaBatchRejectedError("path_key_invalid")
        if path_key in paths:
            raise MediaBatchRejectedError("path_key_duplicate")
        paths.add(path_key)
        if not isinstance(relative, str) or not re.fullmatch(
            r"files/[0-9]{6}\.(?:webp|png|jpg|gif)", relative
        ):
            raise MediaBatchRejectedError("relative_path_invalid")
        name = relative.removeprefix("files/")
        if name in listed:
            raise MediaBatchRejectedError("relative_path_duplicate")
        listed.add(name)
        if _positive_int(item["bytes"], _MAX_FILE_BYTES):
            total += item["bytes"]
            if total > _MAX_BATCH_BYTES:
                raise MediaBatchRejectedError("batch_too_large")
        source = files_dir / name
        checked.append({**item, "source": source, "reason": _item_reason(item, source)})
    if actual - listed:
        raise MediaBatchRejectedError("unlisted_batch_file")
    return manifest_sha, checked


def _run(argv: list[str], runner: Runner) -> bytes:
    result = runner(
        argv,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=_RCLONE_TIMEOUT_S,
    )
    output = result.stdout
    return output if isinstance(output, bytes) else str(output).encode()


def upload(build_root: Path, batch_id: str, items: list[dict[str, Any]], runner: Runner) -> None:
    """Copy each type group to media/arca/<path key>, then SHA-256-check every R2 body."""
    stage = build_root / "media" / batch_id
    shutil.rmtree(stage, ignore_errors=True)
    destination = f"{_REMOTE}/media/arca"
    try:
        for content_type, extension in _TYPES.items():
            group = [item for item in items if item["content_type"] == content_type]
            if not group:
                continue
            root = stage / extension
            for item in group:
                # A bounded copy (<= 48 MiB) out of the read-only drop filesystem.
                target = root / item["path_key"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(item["source"], target)
            selection = stage / f"{extension}.files"
            checksums = stage / f"{extension}.sha256"
            selection.write_text("".join(f"{item['path_key']}\n" for item in group), "utf-8")
            checksums.write_text(
                "".join(f"{item['sha256']}  {item['path_key']}\n" for item in group), "utf-8"
            )
            common = ["--contimeout", "10s", "--timeout", "60s", "--retries", "1"]
            _run(
                [
                    "rclone",
                    "--config",
                    _RCLONE_CONFIG,
                    "copy",
                    str(root),
                    destination,
                    "--files-from-raw",
                    str(selection),
                    "--ignore-times",
                    "--header-upload",
                    f"Content-Type: {content_type}",
                    "--transfers",
                    "2",
                    "--checkers",
                    "2",
                    *common,
                    "--low-level-retries",
                    "2",
                ],
                runner,
            )
            try:
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
                        *common,
                    ],
                    runner,
                )
            except subprocess.CalledProcessError as exc:
                raise OSError("R2 readback mismatch for media batch") from exc
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _write_json_atomic(target: Path, value: dict[str, Any]) -> None:
    if target.is_symlink():
        raise OSError("receipt path is a symlink")
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    fd, name = tempfile.mkstemp(prefix=f".{target.name}-", dir=target.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def import_media_batch(
    inbox_root: Path,
    batch_id: str,
    db_path: Path,
    build_root: Path,
    receipts_root: Path,
    *,
    runner: Runner = subprocess.run,
) -> dict[str, Any] | None:
    """Upload, verify, record, then write the receipt; None when the batch is not ready."""
    receipt_path = receipts_root / f"{batch_id}.json"
    if receipt_path.is_file() and not receipt_path.is_symlink():
        return json.loads(receipt_path.read_bytes())
    try:
        manifest_sha, items = validate_batch(inbox_root, batch_id)
    except MediaBatchNotReadyError:
        return None
    accepted = [item for item in items if not item["reason"]]
    if accepted:
        upload(build_root, batch_id, accepted, runner)
    stored_at = _now()
    with closing(sqlite3.connect(db_path)) as db, db:
        db.executescript(_SCHEMA)
        db.executemany(
            """INSERT INTO text_archive_media(
                   path_key,sha256,content_type,bytes,width,height,post,batch_id,stored_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(path_key) DO UPDATE SET sha256=excluded.sha256,
                   content_type=excluded.content_type,bytes=excluded.bytes,
                   width=excluded.width,height=excluded.height,post=excluded.post,
                   batch_id=excluded.batch_id,stored_at=excluded.stored_at""",
            [
                (
                    item["path_key"],
                    item["sha256"],
                    item["content_type"],
                    item["bytes"],
                    item["width"],
                    item["height"],
                    item["post"],
                    batch_id,
                    stored_at,
                )
                for item in accepted
            ],
        )
    receipt = {
        "schema": 1,
        "kind": "arcalive_media",
        "batch_id": batch_id,
        "manifest_sha256": manifest_sha,
        "imported_at": stored_at,
        "items": [
            {"path_key": item["path_key"], "status": "rejected", "reason": item["reason"]}
            if item["reason"]
            else {"path_key": item["path_key"], "status": "stored"}
            for item in items
        ],
    }
    _write_json_atomic(receipt_path, receipt)
    return receipt


def record_rejection(receipts_root: Path, batch_id: str, reason: str) -> None:
    if not _BATCH_ID.fullmatch(batch_id):
        raise MediaBatchRejectedError("batch_id_invalid")
    _write_json_atomic(
        receipts_root / f"{batch_id}.status.json",
        {
            "schema": 1,
            "kind": "arcalive_media",
            "batch_id": batch_id,
            "batch_status": "rejected",
            "reason": reason[:300],
            "detected_at": _now(),
        },
    )


def next_ready_batch(inbox_root: Path, attempts_root: Path | None = None) -> str | None:
    drop = inbox_root / "drop"
    receipts = inbox_root / "receipts"
    if drop.is_symlink() or not drop.is_dir():
        return None
    for directory in sorted(drop.iterdir(), key=lambda entry: entry.name):
        name = directory.name
        if (
            _BATCH_ID.fullmatch(name)
            and not directory.is_symlink()
            and (directory / "ready.json").is_file()
            and not (receipts / f"{name}.json").exists()
            and not (receipts / f"{name}.status.json").exists()
        ):
            # The oldest ready batch waits out its failure backoff; later ones stay behind it.
            if attempts_root is not None and _backoff_active(attempts_root, name):
                return None
            return name
    return None


# A batch failing on an unexpected error (rclone, OSError, SQLite) is retried with growing
# waits and rejected after this many attempts, so it cannot block the media lane forever.
_IMPORT_ATTEMPTS = 5
_IMPORT_BACKOFF_SECONDS = (300, 900, 1800, 3600)


def _backoff_active(attempts_root: Path, batch_id: str) -> bool:
    try:
        record = json.loads((attempts_root / f"{batch_id}.json").read_text(encoding="utf-8"))
        return float(record["next_at"]) > time.time()
    except OSError, ValueError, KeyError, TypeError:
        return False


def record_failure(
    receipts_root: Path, attempts_root: Path, batch_id: str, error: BaseException
) -> dict[str, Any]:
    path = attempts_root / f"{batch_id}.json"
    try:
        attempts = int(json.loads(path.read_text(encoding="utf-8"))["attempts"]) + 1
    except OSError, ValueError, KeyError, TypeError:
        attempts = 1
    reason = f"import_failed:{type(error).__name__}"
    if attempts >= _IMPORT_ATTEMPTS:
        record_rejection(receipts_root, batch_id, reason)
        path.unlink(missing_ok=True)
        return {"status": "rejected", "batch_id": batch_id, "reason": reason}
    delay = _IMPORT_BACKOFF_SECONDS[min(attempts, len(_IMPORT_BACKOFF_SECONDS)) - 1]
    attempts_root.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps({"attempts": attempts, "next_at": time.time() + delay, "reason": reason}),
        encoding="utf-8",
    )
    temporary.replace(path)
    return {"status": "failed", "batch_id": batch_id, "reason": reason, "attempt": attempts}


# One run drains ready batches in order, well inside the unit's 20 min timeout.
_DRAIN_SECONDS = 600
_DRAIN_BATCHES = 10
_INBOX_ROOT = Path("/srv/redstm-text-inbox")
_DB_PATH = Path("/srv/redstm-text/text-archive.sqlite")
_BUILD_ROOT = Path("/srv/redstm-text/build")
_ATTEMPTS_ROOT = Path("/srv/redstm-text/media-attempts")


def main() -> None:
    parser = argparse.ArgumentParser(description="Store committed Newtomi media batches")
    parser.add_argument("--batch-id", help="import one batch; default drains the ready batches")
    args = parser.parse_args()
    inbox_root = _INBOX_ROOT
    receipts_root = inbox_root / "receipts"
    deadline = time.monotonic() + _DRAIN_SECONDS
    seen: set[str] = set()
    done = 0
    while True:
        batch_id = args.batch_id or next_ready_batch(inbox_root, _ATTEMPTS_ROOT)
        if batch_id is None or batch_id in seen:
            if not done:
                print(json.dumps({"status": "idle", "reason": "no_ready_media_batch"}))
            return
        seen.add(batch_id)
        try:
            with operation_window(
                lock_wait_seconds=30, exclusive=True, need_bytes=120 * 1024 * 1024
            ):
                receipt = import_media_batch(
                    inbox_root,
                    batch_id,
                    _DB_PATH,
                    _BUILD_ROOT,
                    receipts_root,
                )
        except RuntimeWindowError as exc:
            parser.exit(75, f"media import deferred: {exc}\n")
        except MediaBatchRejectedError as exc:
            record_rejection(receipts_root, batch_id, str(exc))
            print(json.dumps({"status": "rejected", "batch_id": batch_id, "reason": str(exc)}))
        except (OSError, sqlite3.Error, ValueError, subprocess.SubprocessError) as exc:
            failure = record_failure(receipts_root, _ATTEMPTS_ROOT, batch_id, exc)
            print(json.dumps(failure))
            if failure["status"] == "failed":
                parser.exit(1, f"media import of {batch_id} failed: {exc!r}\n")
        else:
            (_ATTEMPTS_ROOT / f"{batch_id}.json").unlink(missing_ok=True)
            if receipt is None:
                parser.exit(0, "media batch not ready; no receipt written\n")
            counts: dict[str, int] = {}
            for item in receipt["items"]:
                counts[item["status"]] = counts.get(item["status"], 0) + 1
            print(json.dumps({"batch_id": batch_id, **counts}, sort_keys=True))
        done += 1
        # Newtomi deletes a batch from the 2 GiB drop only after its receipt, so a
        # waiting batch also holds back the next upload.
        if args.batch_id or done >= _DRAIN_BATCHES or time.monotonic() >= deadline:
            return


if __name__ == "__main__":
    main()
