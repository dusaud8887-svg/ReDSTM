from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from compression import zstd
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any

from filelock import FileLock, Timeout

from scripts.export_static import (
    IncrementalExportError,
    validate_incremental_release,
    validate_release,
)

_MAX_R2_BYTES = 20_000_000_000
_MAX_R2_OBJECTS = 800_000
_RCLONE_CHECKERS = 16
_RCLONE_TRANSFERS = 16
_RCLONE_EXCLUDES = (
    "/release.json",
    "/.publish-ledger.json",
    "/.publish-ledger.pending.json",
    "/.publish-smoke.pending.json",
    "/.publish.lock",
    "/.export-state.json",
    "*.partial",
    "**/*.partial",
)


def _rclone_excludes() -> list[str]:
    return [item for pattern in _RCLONE_EXCLUDES for item in ("--exclude", pattern)]


def _remote_target(remote: str, runner: Any) -> str:
    normalized = remote.rstrip("/")
    match = re.fullmatch(r"[A-Za-z0-9_.-]+:([A-Za-z0-9_./-]+)", normalized)
    if match is None:
        raise ValueError("remote must include a bucket path")
    path = PurePosixPath(match.group(1))
    if path.is_absolute() or not path.parts or ".." in path.parts or str(path) != match.group(1):
        raise ValueError("remote bucket path is invalid")
    if runner is subprocess.run and shutil.which("rclone") is None:
        raise RuntimeError("rclone is not installed")
    return normalized


def _read_remote_pointer(target: str, runner: Any) -> bytes | None:
    try:
        raw = runner(
            ["rclone", "cat", f"{target}/release.json"],
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
    except subprocess.CalledProcessError as error:
        if error.returncode in {3, 4}:
            return None
        raise RuntimeError("remote release pointer is unavailable") from error
    if not isinstance(raw, bytes):
        raise RuntimeError("remote release pointer response is invalid")
    return raw


def _current_release(root: Path) -> str:
    pointer = root / "release.json"
    if not pointer.is_file():
        raise ValueError("release.json is missing")
    return f"releases/{hashlib.sha256(pointer.read_bytes()).hexdigest()}.json"


def _ledger_path(root: Path) -> Path:
    return root / ".publish-ledger.json"


def _pending_ledger_path(root: Path) -> Path:
    return root / ".publish-ledger.pending.json"


def _pending_smoke_path(root: Path) -> Path:
    return root / ".publish-smoke.pending.json"


def _object_key(ref: object) -> str:
    if not isinstance(ref, dict) or not isinstance(ref.get("object_key"), str):
        raise ValueError("invalid release object reference")
    key = str(ref["object_key"])
    path = PurePosixPath(key)
    if (
        not re.fullmatch(r"[A-Za-z0-9_./-]+", key)
        or path.is_absolute()
        or not path.parts
        or ".." in path.parts
        or str(path) != key
    ):
        raise ValueError("invalid release object key")
    return key


def _release_objects(
    root: Path,
    body: bytes,
    *,
    verify_missing_from: set[str] | None = None,
) -> set[str]:
    manifest = json.loads(body)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("unsupported release manifest")
    release_key = f"releases/{hashlib.sha256(body).hexdigest()}.json"
    boards = manifest.get("boards", [])
    if not isinstance(boards, list):
        raise ValueError("invalid release boards")
    keys = {release_key}
    for ref in [*boards, manifest.get("search"), manifest.get("collections")]:
        if ref is not None:
            keys.add(_object_key(ref))
    for ref in boards:
        key = _object_key(ref)
        compressed = (root / key).read_bytes()
        if (
            ref.get("object_bytes") != len(compressed)
            or ref.get("object_sha256") != hashlib.sha256(compressed).hexdigest()
        ):
            raise ValueError("board object does not match release")
        try:
            payload = zstd.decompress(compressed)
        except zstd.ZstdError as error:
            raise ValueError("invalid board object") from error
        if ref.get("payload_sha256") != hashlib.sha256(payload).hexdigest():
            raise ValueError("board payload does not match release")
        board = json.loads(payload)
        posts = board.get("posts") if isinstance(board, dict) else None
        if not isinstance(posts, list):
            raise ValueError("invalid board manifest")
        for post in posts:
            post_key = _object_key(post)
            if not isinstance(post, dict):
                raise ValueError("invalid post object reference")
            if post_key in keys:
                raise ValueError("duplicate post object reference")
            if verify_missing_from is not None and post_key not in verify_missing_from:
                _verify_object_ref(root, post)
            keys.add(post_key)
    collection_ref = manifest.get("collections")
    if isinstance(collection_ref, dict):
        _verify_object_ref(root, collection_ref)
        compressed = (root / _object_key(collection_ref)).read_bytes()
        try:
            payload = zstd.decompress(compressed)
            collection_index = json.loads(payload)
        except (zstd.ZstdError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid collection index") from error
        if collection_ref.get("payload_sha256") != hashlib.sha256(
            payload
        ).hexdigest() or not isinstance(collection_index, dict):
            raise ValueError("invalid collection index")
        if collection_index.get("schema_version") == 2:
            details = collection_index.get("detail_shards")
            memberships = collection_index.get("memberships")
            if not isinstance(details, list) or not isinstance(memberships, list):
                raise ValueError("invalid collection index")
            for nested_ref in [*details, *memberships]:
                if not isinstance(nested_ref, dict):
                    raise ValueError("invalid collection object reference")
                nested_key = _object_key(nested_ref)
                if nested_key in keys:
                    raise ValueError("duplicate collection object reference")
                _verify_object_ref(root, nested_ref)
                keys.add(nested_key)
        elif collection_index.get("schema_version") != 1:
            raise ValueError("unsupported collection index")
    return keys


def _verify_object_ref(root: Path, ref: dict[str, object]) -> None:
    key = _object_key(ref)
    expected_bytes = ref.get("object_bytes")
    expected_sha256 = ref.get("object_sha256")
    if (
        type(expected_bytes) is not int
        or expected_bytes < 0
        or not isinstance(expected_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
    ):
        raise ValueError(f"invalid post object reference: {key}")
    target = root / key
    if not target.is_file() or target.stat().st_size != expected_bytes:
        raise ValueError(f"post object size mismatch: {key}")
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise ValueError(f"post object hash mismatch: {key}")


def _read_ledger_state(
    root: Path, target: str, *, path: Path | None = None
) -> dict[str, Any] | None:
    try:
        ledger = json.loads((path or _ledger_path(root)).read_text(encoding="utf-8"))
    except OSError, UnicodeDecodeError, json.JSONDecodeError:
        return None
    if (
        not isinstance(ledger, dict)
        or ledger.get("schema_version") != 1
        or ledger.get("remote") != target
        or not isinstance(ledger.get("release_key"), str)
        or re.fullmatch(r"releases/[0-9a-f]{64}\.json", ledger["release_key"]) is None
        or type(ledger.get("remote_bytes")) is not int
        or type(ledger.get("remote_objects")) is not int
        or ledger["remote_bytes"] < 0
        or ledger["remote_objects"] < 0
    ):
        return None
    previous_release_key = ledger.get("previous_release_key")
    if previous_release_key is not None and (
        not isinstance(previous_release_key, str)
        or re.fullmatch(r"releases/[0-9a-f]{64}\.json", previous_release_key) is None
        or previous_release_key == ledger["release_key"]
    ):
        return None
    return ledger


def _read_ledger(root: Path, target: str, release_key: str) -> dict[str, Any] | None:
    ledger = _read_ledger_state(root, target)
    if ledger is None or ledger["release_key"] != release_key:
        return None
    return ledger


def _delta_plan(
    root: Path,
    target: str,
    previous_body: bytes,
    release_body: bytes,
    runner: Any,
) -> tuple[list[str], dict[str, int]] | None:
    previous_key = f"releases/{hashlib.sha256(previous_body).hexdigest()}.json"
    previous_path = root / previous_key
    if not previous_path.is_file() or previous_path.read_bytes() != previous_body:
        return None
    ledger = _read_ledger(root, target, previous_key)
    if ledger is None:
        return None
    previous_keys = _release_objects(root, previous_body)
    current_keys = _release_objects(root, release_body, verify_missing_from=previous_keys)
    keys = sorted(current_keys - previous_keys)
    with TemporaryDirectory(prefix="redstm-r2-delta-budget-") as temporary:
        files = Path(temporary) / "files.txt"
        missing = Path(temporary) / "missing.txt"
        files.write_text("\n".join(keys) + "\n", encoding="utf-8")
        runner(
            [
                "rclone",
                "copy",
                str(root),
                target,
                "--files-from",
                str(files),
                "--immutable",
                "--dry-run",
                "--missing-on-dst",
                str(missing),
                "--no-traverse",
                "--retries",
                "1",
                "--checkers",
                str(_RCLONE_CHECKERS),
                "--stats",
                "0",
                "--log-level",
                "ERROR",
            ],
            check=True,
        )
        missing_keys = _missing_local_keys(root, missing, allowed=set(keys))
    new_bytes = sum((root / key).stat().st_size for key in missing_keys)
    new_objects = len(missing_keys)
    projected_bytes = (
        int(ledger["remote_bytes"]) + new_bytes + len(release_body) - len(previous_body)
    )
    projected_objects = int(ledger["remote_objects"]) + new_objects
    if projected_bytes > _MAX_R2_BYTES or projected_objects > _MAX_R2_OBJECTS:
        raise RuntimeError(
            "R2 publishing budget limit exceeded: "
            f"projected_bytes={projected_bytes}, projected_objects={projected_objects}"
        )
    return keys, {
        "remote_bytes_before": int(ledger["remote_bytes"]),
        "remote_objects_before": int(ledger["remote_objects"]),
        "new_bytes": new_bytes,
        "new_objects": new_objects,
        "projected_remote_bytes": projected_bytes,
        "projected_remote_objects": projected_objects,
    }


def _verified_previous_release(
    root: Path,
    target: str,
    body: bytes,
    runner: Any,
) -> str | None:
    release_key = f"releases/{hashlib.sha256(body).hexdigest()}.json"
    release_path = root / release_key
    try:
        manifest = json.loads(body)
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema_version") != 1
            or not release_path.is_file()
            or release_path.read_bytes() != body
        ):
            return None
        remote_body = runner(
            ["rclone", "cat", f"{target}/{release_key}"],
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
    except OSError, UnicodeDecodeError, json.JSONDecodeError, subprocess.CalledProcessError:
        return None
    return release_key if remote_body == body else None


def _write_ledger(
    root: Path,
    target: str,
    release_key: str,
    budget: dict[str, int],
    *,
    previous_release_key: str | None = None,
    path: Path | None = None,
) -> None:
    ledger = path or _ledger_path(root)
    partial = ledger.with_suffix(f"{ledger.suffix}.partial")
    try:
        with partial.open("w", encoding="utf-8") as destination:
            destination.write(
                json.dumps(
                    {
                        "schema_version": 1,
                        "remote": target,
                        "release_key": release_key,
                        "previous_release_key": previous_release_key,
                        "remote_bytes": budget["projected_remote_bytes"],
                        "remote_objects": budget["projected_remote_objects"],
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
            )
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(partial, ledger)
        if os.name != "nt":
            directory = os.open(ledger.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        partial.unlink(missing_ok=True)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    directory = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _recover_pending_ledger(
    root: Path,
    target: str,
    remote_pointer: bytes | None,
    *,
    verified_incremental: bool,
) -> bool:
    path = _pending_ledger_path(root)
    if not path.exists():
        return False
    pending = _read_ledger_state(root, target, path=path)
    try:
        if pending is None:
            raise ValueError("invalid pending publish ledger")
        release_path = root / str(pending["release_key"])
        release_body = release_path.read_bytes()
        if (
            hashlib.sha256(release_body).hexdigest()
            != PurePosixPath(str(pending["release_key"])).stem
        ):
            raise ValueError("pending publish release is invalid")
    except (OSError, ValueError) as error:
        if verified_incremental:
            raise IncrementalExportError(
                "incremental_publish_ledger_invalid",
                "pending publish ledger cannot be recovered",
            ) from error
        path.unlink(missing_ok=True)
        return False
    if remote_pointer is None:
        if (
            pending.get("previous_release_key") is None
            and _read_ledger_state(root, target) is None
            and not _pending_smoke_path(root).exists()
        ):
            path.unlink()
            _fsync_directory(path.parent)
            return False
        if verified_incremental:
            raise IncrementalExportError(
                "incremental_publish_pointer_unavailable",
                "remote release pointer is unavailable; pending publish ledger was preserved",
            )
        raise RuntimeError(
            "remote release pointer is unavailable; pending publish ledger was preserved"
        )
    if remote_pointer != release_body:
        path.unlink(missing_ok=True)
        return False
    _write_ledger(
        root,
        target,
        str(pending["release_key"]),
        {
            "projected_remote_bytes": int(pending["remote_bytes"]),
            "projected_remote_objects": int(pending["remote_objects"]),
        },
        previous_release_key=pending.get("previous_release_key"),
    )
    path.unlink(missing_ok=True)
    return True


def _pending_smoke_ledger(
    root: Path,
    target: str,
    remote_pointer: bytes | None,
    *,
    verified_incremental: bool,
) -> dict[str, Any] | None:
    path = _pending_smoke_path(root)
    if not path.exists():
        return None
    pending = _read_ledger_state(root, target, path=path)
    try:
        if pending is None:
            raise ValueError("invalid pending publish smoke marker")
        release_path = root / str(pending["release_key"])
        release_body = release_path.read_bytes()
        if (
            hashlib.sha256(release_body).hexdigest()
            != PurePosixPath(str(pending["release_key"])).stem
        ):
            raise ValueError("pending publish smoke release is invalid")
    except (OSError, ValueError) as error:
        if verified_incremental:
            raise IncrementalExportError(
                "incremental_publish_smoke_marker_invalid",
                "pending publish smoke marker cannot be recovered",
            ) from error
        path.unlink(missing_ok=True)
        return None
    if remote_pointer != release_body:
        path.unlink(missing_ok=True)
        return None
    return pending


def _recover_rolled_back_ledger(
    root: Path,
    target: str,
    remote_pointer: bytes | None,
) -> bool:
    if remote_pointer is None:
        return False
    active = _read_ledger_state(root, target)
    remote_key = f"releases/{hashlib.sha256(remote_pointer).hexdigest()}.json"
    if (
        active is None
        or active["release_key"] == remote_key
        or active.get("previous_release_key") != remote_key
    ):
        return False
    try:
        previous_path = root / remote_key
        active_path = root / str(active["release_key"])
        previous_body = previous_path.read_bytes()
        active_body = active_path.read_bytes()
        manifest = json.loads(remote_pointer)
    except OSError, UnicodeDecodeError, json.JSONDecodeError:
        return False
    if (
        previous_body != remote_pointer
        or not isinstance(manifest, dict)
        or manifest.get("schema_version") != 1
        or hashlib.sha256(active_body).hexdigest() != PurePosixPath(str(active["release_key"])).stem
    ):
        return False
    remote_bytes = int(active["remote_bytes"]) + len(remote_pointer) - len(active_body)
    if remote_bytes < 0:
        return False
    _write_ledger(
        root,
        target,
        remote_key,
        {
            "projected_remote_bytes": remote_bytes,
            "projected_remote_objects": int(active["remote_objects"]),
        },
        previous_release_key=str(active["release_key"]),
    )
    return True


def _remote_size(target: str, runner: Any) -> tuple[int, int]:
    remote_raw = runner(
        ["rclone", "size", target, "--json"],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    try:
        remote = json.loads(remote_raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("invalid rclone size response") from error
    if not isinstance(remote, dict):
        raise RuntimeError("invalid rclone size response")
    remote_bytes = remote.get("bytes")
    remote_objects = remote.get("count")
    if type(remote_bytes) is not int or remote_bytes < 0:
        raise RuntimeError("invalid remote byte count")
    if type(remote_objects) is not int or remote_objects < 0:
        raise RuntimeError("invalid remote object count")
    return remote_bytes, remote_objects


def _missing_local_keys(
    root: Path,
    report: Path,
    *,
    allowed: set[str] | None = None,
) -> list[str]:
    if not report.is_file():
        return []
    keys: set[str] = set()
    for raw_key in report.read_text(encoding="utf-8").splitlines():
        key = PurePosixPath(raw_key)
        if (
            re.fullmatch(r"[A-Za-z0-9_./-]+", raw_key) is None
            or key.is_absolute()
            or not key.parts
            or ".." in key.parts
            or str(key) != raw_key
            or (allowed is not None and raw_key not in allowed)
        ):
            raise RuntimeError(f"invalid rclone object key: {raw_key!r}")
        local = root.joinpath(*key.parts)
        if not local.is_file():
            raise RuntimeError(f"rclone reported missing local object: {raw_key}")
        keys.add(raw_key)
    return sorted(keys)


def _r2_budget_preflight(
    root: Path,
    target: str,
    *,
    pointer_bytes: int,
    previous_pointer_bytes: int | None = None,
    runner: Any,
) -> dict[str, int]:
    remote_bytes, remote_objects = _remote_size(target, runner)

    new_bytes = 0
    new_objects = 0
    with TemporaryDirectory(prefix="redstm-r2-preflight-") as temporary:
        missing = Path(temporary) / "missing.txt"
        runner(
            [
                "rclone",
                "copy",
                str(root),
                target,
                *_rclone_excludes(),
                "--immutable",
                "--dry-run",
                "--missing-on-dst",
                str(missing),
                "--retries",
                "1",
                "--checkers",
                str(_RCLONE_CHECKERS),
                "--fast-list",
                "--stats",
                "0",
                "--log-level",
                "ERROR",
            ],
            check=True,
        )
        missing_keys = _missing_local_keys(root, missing)
        new_bytes = sum((root / key).stat().st_size for key in missing_keys)
        new_objects = len(missing_keys)

    replaced_pointer_bytes = previous_pointer_bytes or 0
    projected_bytes = remote_bytes + new_bytes + pointer_bytes - replaced_pointer_bytes
    projected_objects = remote_objects + new_objects + (previous_pointer_bytes is None)
    if projected_bytes > _MAX_R2_BYTES or projected_objects > _MAX_R2_OBJECTS:
        raise RuntimeError(
            "R2 publishing budget limit exceeded: "
            f"projected_bytes={projected_bytes}, projected_objects={projected_objects}"
        )
    return {
        "remote_bytes_before": remote_bytes,
        "remote_objects_before": remote_objects,
        "new_bytes": new_bytes,
        "new_objects": new_objects,
        "projected_remote_bytes": projected_bytes,
        "projected_remote_objects": projected_objects,
    }


def reconcile_pending_smoke(
    root: Path,
    remote: str,
    *,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    resolved = root.expanduser().resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("static root must be a directory")
    try:
        with FileLock(str(resolved / ".publish.lock"), timeout=0):
            return _reconcile_pending_smoke_locked(resolved, remote, runner=runner)
    except Timeout as error:
        raise RuntimeError("another static publish or activation is active") from error


def _reconcile_pending_smoke_locked(
    root: Path,
    remote: str,
    *,
    runner: Any,
) -> dict[str, Any]:
    target = _remote_target(remote, runner)
    marker_path = _pending_smoke_path(root)
    if not marker_path.exists():
        return {"pending_smoke": False, "remote": target, "mode": "noop"}
    pending = _read_ledger_state(root, target, path=marker_path)
    try:
        if pending is None:
            raise ValueError("invalid pending publish smoke marker")
        attempted_key = str(pending["release_key"])
        attempted_body = (root / attempted_key).read_bytes()
        if hashlib.sha256(attempted_body).hexdigest() != PurePosixPath(attempted_key).stem:
            raise ValueError("pending publish smoke release is invalid")
    except (OSError, ValueError) as error:
        raise IncrementalExportError(
            "incremental_publish_smoke_marker_invalid",
            "pending publish smoke marker cannot be recovered",
        ) from error
    try:
        remote_pointer = _read_remote_pointer(target, runner)
    except RuntimeError as error:
        raise IncrementalExportError(
            "incremental_publish_pointer_unavailable",
            "remote release pointer is unavailable; pending publish smoke was preserved",
        ) from error
    if remote_pointer is None:
        pending_ledger = _read_ledger_state(root, target, path=_pending_ledger_path(root))
        active_ledger = _read_ledger_state(root, target)
        if (
            pending.get("previous_release_key") is None
            and (pending_ledger is None or pending_ledger == pending)
            and active_ledger is None
        ):
            _pending_ledger_path(root).unlink(missing_ok=True)
            marker_path.unlink()
            _fsync_directory(marker_path.parent)
            return {
                "pending_smoke": False,
                "discarded_unactivated_release": attempted_key,
                "remote": target,
                "mode": "noop",
            }
        raise IncrementalExportError(
            "incremental_publish_smoke_pointer_conflict",
            "remote release pointer is missing; pending publish smoke was preserved",
        )

    ledger_recovered = False
    rollback_already_active = False
    if remote_pointer == attempted_body:
        ledger_recovered = _recover_pending_ledger(
            root,
            target,
            remote_pointer,
            verified_incremental=True,
        )
        active_key = attempted_key
        active_ledger = _read_ledger(root, target, active_key)
        if active_ledger is None:
            _write_ledger(
                root,
                target,
                active_key,
                {
                    "projected_remote_bytes": int(pending["remote_bytes"]),
                    "projected_remote_objects": int(pending["remote_objects"]),
                },
                previous_release_key=pending.get("previous_release_key"),
            )
            ledger_recovered = True
        previous_release_key = pending.get("previous_release_key")
        previous_release_verified = False
        if isinstance(previous_release_key, str):
            try:
                previous_body = (root / previous_release_key).read_bytes()
            except OSError:
                previous_body = b""
            previous_release_verified = (
                previous_body != b""
                and hashlib.sha256(previous_body).hexdigest()
                == PurePosixPath(previous_release_key).stem
                and _verified_previous_release(root, target, previous_body, runner)
                == previous_release_key
            )
    else:
        previous_release_key = pending.get("previous_release_key")
        try:
            if not isinstance(previous_release_key, str):
                raise ValueError("pending publish smoke has no rollback release")
            previous_body = (root / previous_release_key).read_bytes()
            if (
                hashlib.sha256(previous_body).hexdigest()
                != PurePosixPath(previous_release_key).stem
                or remote_pointer != previous_body
            ):
                raise ValueError("remote pointer is outside the pending smoke transaction")
        except (OSError, ValueError) as error:
            raise IncrementalExportError(
                "incremental_publish_smoke_pointer_conflict",
                "remote release pointer conflicts with pending publish smoke",
            ) from error
        rollback_already_active = True
        active_key = previous_release_key
        ledger_recovered = _recover_rolled_back_ledger(root, target, remote_pointer)
        active_ledger = _read_ledger(root, target, active_key)
        if active_ledger is None:
            remote_bytes = int(pending["remote_bytes"]) + len(previous_body) - len(attempted_body)
            if remote_bytes < 0:
                raise IncrementalExportError(
                    "incremental_publish_smoke_marker_invalid",
                    "pending publish smoke budget cannot be recovered",
                )
            _write_ledger(
                root,
                target,
                active_key,
                {
                    "projected_remote_bytes": remote_bytes,
                    "projected_remote_objects": int(pending["remote_objects"]),
                },
                previous_release_key=attempted_key,
            )
            ledger_recovered = True
        previous_release_key = None
        previous_release_verified = False

    return {
        "pending_smoke": True,
        "release_key": active_key,
        "smoke_marker_release_key": attempted_key,
        "attempted_release_key": attempted_key,
        "remote": target,
        "pointer_verified": True,
        "mode": "noop",
        "new_bytes": 0,
        "new_objects": 0,
        "ledger_written": True,
        "ledger_recovered": ledger_recovered,
        "activation_pending_smoke": True,
        "rollback_already_active": rollback_already_active,
        "previous_release_key": previous_release_key,
        "previous_release_verified": previous_release_verified,
    }


def publish_static(
    root: Path,
    remote: str,
    *,
    release: str | None = None,
    verified_incremental: bool = False,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    resolved = root.expanduser().resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("static root must be a directory")
    try:
        with FileLock(str(resolved / ".publish.lock"), timeout=0):
            return _publish_static_locked(
                resolved,
                remote,
                release=release,
                verified_incremental=verified_incremental,
                runner=runner,
            )
    except Timeout as error:
        raise RuntimeError("another static publish or activation is active") from error


def _publish_static_locked(
    root: Path,
    remote: str,
    *,
    release: str | None = None,
    verified_incremental: bool = False,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    root = root.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("static root must be a directory")

    if verified_incremental and release is not None:
        raise ValueError("verified incremental publish only accepts the current release")
    release_to_publish = release or _current_release(root)
    validation = (
        validate_incremental_release(root, release_to_publish)
        if verified_incremental
        else validate_release(root, release_to_publish)
    )
    release_key = str(validation["release_key"])
    release_body = (root / release_key).read_bytes()
    target = _remote_target(remote, runner)
    pointer_target = f"{target}/release.json"
    try:
        remote_pointer = _read_remote_pointer(target, runner)
    except RuntimeError as error:
        if _pending_ledger_path(root).exists() or _pending_smoke_path(root).exists():
            if verified_incremental:
                raise IncrementalExportError(
                    "incremental_publish_pointer_unavailable",
                    "remote release pointer is unavailable; pending publish ledger was preserved",
                ) from error
            raise RuntimeError(
                "remote release pointer is unavailable; pending publish ledger was preserved"
            ) from error
        raise
    ledger_recovered = _recover_pending_ledger(
        root,
        target,
        remote_pointer,
        verified_incremental=verified_incremental,
    )
    ledger_recovered = _recover_rolled_back_ledger(root, target, remote_pointer) or ledger_recovered
    pending_smoke = _pending_smoke_ledger(
        root,
        target,
        remote_pointer,
        verified_incremental=verified_incremental,
    )
    if pending_smoke is not None and pending_smoke["release_key"] != release_key:
        active_release_key = str(pending_smoke["release_key"])
        active_ledger = _read_ledger(root, target, active_release_key)
        return {
            "release_key": active_release_key,
            "deferred_release_key": release_key,
            "remote": target,
            "pointer_verified": True,
            "mode": "noop",
            "new_bytes": 0,
            "new_objects": 0,
            "ledger_written": active_ledger is not None,
            "ledger_recovered": ledger_recovered,
            "activation_pending_smoke": True,
            "previous_release_key": pending_smoke.get("previous_release_key"),
            "previous_release_verified": bool(pending_smoke.get("previous_release_key")),
        }
    if remote_pointer == release_body:
        ledger = _read_ledger(root, target, release_key)
        if ledger is None and verified_incremental:
            raise IncrementalExportError(
                "incremental_publish_bootstrap_required",
                "active release has no verified publish ledger; run an explicit full publish",
            )
        ledger_written = ledger is not None
        if ledger is None and not verified_incremental:
            try:
                remote_bytes, remote_objects = _remote_size(target, runner)
                _write_ledger(
                    root,
                    target,
                    release_key,
                    {
                        "projected_remote_bytes": remote_bytes,
                        "projected_remote_objects": remote_objects,
                    },
                )
                ledger_written = True
            except OSError, RuntimeError, subprocess.CalledProcessError:
                ledger_written = False
        return {
            **validation,
            "remote": target,
            "pointer_verified": True,
            "mode": "noop",
            "new_bytes": 0,
            "new_objects": 0,
            "ledger_written": ledger_written,
            "ledger_recovered": ledger_recovered,
            "activation_pending_smoke": pending_smoke is not None,
            "previous_release_key": (
                pending_smoke.get("previous_release_key")
                if pending_smoke is not None
                else ledger.get("previous_release_key")
                if ledger is not None
                else None
            ),
            "previous_release_verified": bool(
                pending_smoke is not None
                and pending_smoke.get("previous_release_key")
                or ledger is not None
                and ledger.get("previous_release_key")
            ),
        }

    previous_release_key = (
        _verified_previous_release(root, target, remote_pointer, runner)
        if isinstance(remote_pointer, bytes)
        else None
    )
    if verified_incremental and isinstance(remote_pointer, bytes) and previous_release_key is None:
        raise IncrementalExportError(
            "incremental_publish_predecessor_unavailable",
            "active predecessor release could not be verified; remote pointer was not changed",
        )

    common = {"check": True}
    delta = (
        _delta_plan(root, target, remote_pointer, release_body, runner)
        if remote_pointer is not None and previous_release_key is not None
        else None
    )
    if delta is None:
        if verified_incremental:
            raise IncrementalExportError(
                "incremental_publish_bootstrap_required",
                "verified predecessor ledger is missing; run an explicit full publish",
            )
        mode = "publish"
        budget = _r2_budget_preflight(
            root,
            target,
            pointer_bytes=len(release_body),
            previous_pointer_bytes=(
                len(remote_pointer) if isinstance(remote_pointer, bytes) else None
            ),
            runner=runner,
        )
        runner(
            [
                "rclone",
                "copy",
                str(root),
                target,
                *_rclone_excludes(),
                "--immutable",
                "--checkers",
                str(_RCLONE_CHECKERS),
                "--transfers",
                str(_RCLONE_TRANSFERS),
                "--fast-list",
            ],
            **common,
        )
        if previous_release_key is None and isinstance(remote_pointer, bytes):
            previous_release_key = _verified_previous_release(root, target, remote_pointer, runner)
        runner(
            [
                "rclone",
                "check",
                str(root),
                target,
                *_rclone_excludes(),
                "--one-way",
            ],
            **common,
        )
    else:
        mode = "delta"
        keys, budget = delta
        with TemporaryDirectory(prefix="redstm-r2-delta-") as temporary:
            files = Path(temporary) / "files.txt"
            files.write_text("\n".join(keys) + "\n", encoding="utf-8")
            runner(
                [
                    "rclone",
                    "copy",
                    str(root),
                    target,
                    "--files-from",
                    str(files),
                    "--immutable",
                    "--checkers",
                    str(_RCLONE_CHECKERS),
                    "--transfers",
                    str(_RCLONE_TRANSFERS),
                ],
                **common,
            )
            runner(
                ["rclone", "check", str(root), target, "--files-from", str(files), "--one-way"],
                **common,
            )
    if _read_remote_pointer(target, runner) != remote_pointer:
        raise RuntimeError("remote release pointer changed during publish")
    # Keep the active ledger intact until the remote pointer is verified. The pending record
    # makes a crash after copyto recoverable without losing the predecessor budget.
    _write_ledger(
        root,
        target,
        release_key,
        budget,
        previous_release_key=previous_release_key,
        path=_pending_ledger_path(root),
    )
    _write_ledger(
        root,
        target,
        release_key,
        budget,
        previous_release_key=previous_release_key,
        path=_pending_smoke_path(root),
    )
    runner(
        ["rclone", "copyto", str(root / release_key), pointer_target, "--no-check-dest"],
        **common,
    )
    remote_pointer = runner(
        ["rclone", "cat", pointer_target],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if remote_pointer != release_body:
        raise RuntimeError("remote release pointer verification failed")
    try:
        _write_ledger(
            root,
            target,
            release_key,
            budget,
            previous_release_key=previous_release_key,
        )
        _pending_ledger_path(root).unlink(missing_ok=True)
        ledger_written = True
    except OSError:
        # The verified pointer and pending ledger are enough to recover on the next cycle.
        ledger_written = False
    return {
        **validation,
        **budget,
        "remote": target,
        "pointer_verified": True,
        "ledger_written": ledger_written,
        "ledger_recovered": ledger_recovered,
        "activation_pending_smoke": True,
        "mode": mode,
        "previous_release_key": previous_release_key,
        "previous_release_verified": previous_release_key is not None,
    }


def activate_remote_release(
    root: Path,
    remote: str,
    release: str,
    *,
    expected_current: str | None = None,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    resolved = root.expanduser().resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("static root must be a directory")
    try:
        with FileLock(str(resolved / ".publish.lock"), timeout=0):
            return _activate_remote_release_locked(
                resolved,
                remote,
                release,
                expected_current=expected_current,
                runner=runner,
            )
    except Timeout as error:
        raise RuntimeError("another static publish or activation is active") from error


def _activate_remote_release_locked(
    root: Path,
    remote: str,
    release: str,
    *,
    expected_current: str | None = None,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    root = root.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("static root must be a directory")
    release_key = release if release.startswith("releases/") else f"releases/{release}.json"
    match = re.fullmatch(r"releases/([0-9a-f]{64})\.json", release_key)
    if match is None:
        raise ValueError(f"invalid release key: {release!r}")
    release_path = root / release_key
    if not release_path.is_file():
        raise ValueError(f"release is missing: {release_key}")
    release_body = release_path.read_bytes()
    if hashlib.sha256(release_body).hexdigest() != match.group(1):
        raise ValueError(f"release hash mismatch: {release_key}")
    try:
        manifest = json.loads(release_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid release JSON: {release_key}") from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("unsupported release manifest")

    expected_key: str | None = None
    expected_body = None
    if expected_current is not None:
        expected_key = (
            expected_current
            if expected_current.startswith("releases/")
            else f"releases/{expected_current}.json"
        )
        expected_match = re.fullmatch(r"releases/([0-9a-f]{64})\.json", expected_key)
        expected_path = root / expected_key
        if expected_match is None or not expected_path.is_file():
            raise ValueError("expected current release is invalid or missing")
        expected_body = expected_path.read_bytes()
        if hashlib.sha256(expected_body).hexdigest() != expected_match.group(1):
            raise ValueError("expected current release hash mismatch")

    target = _remote_target(remote, runner)
    smoke_path = _pending_smoke_path(root)
    pending_smoke = _read_ledger_state(root, target, path=smoke_path)
    pending_smoke_body: bytes | None = None
    if smoke_path.exists():
        if pending_smoke is None:
            raise RuntimeError("pending publish smoke marker is invalid")
        try:
            pending_smoke_body = (root / str(pending_smoke["release_key"])).read_bytes()
        except OSError as error:
            raise RuntimeError("pending publish smoke release is missing") from error
        if (
            hashlib.sha256(pending_smoke_body).hexdigest()
            != PurePosixPath(str(pending_smoke["release_key"])).stem
        ):
            raise RuntimeError("pending publish smoke release is invalid")
    attempted_candidates = (
        _read_ledger_state(root, target, path=_pending_ledger_path(root)),
        _read_ledger_state(root, target),
    )
    remote_release = f"{target}/{release_key}"
    existing = runner(
        ["rclone", "cat", remote_release],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if existing != release_body:
        raise RuntimeError("remote versioned release verification failed")

    pointer_target = f"{target}/release.json"
    previous_pointer = _read_remote_pointer(target, runner)
    if expected_body is not None and previous_pointer not in {expected_body, release_body}:
        raise RuntimeError("remote release pointer does not match the expected current release")
    if pending_smoke is not None:
        rollback_request = (
            expected_key == pending_smoke["release_key"]
            and release_key == pending_smoke.get("previous_release_key")
            and pending_smoke_body is not None
            and previous_pointer in {pending_smoke_body, release_body}
        )
        if not rollback_request:
            raise RuntimeError(
                "pending publish smoke must be confirmed or rolled back before activation"
            )
    attempted_body = None
    recovered_from_attempt = None
    for attempted in attempted_candidates:
        if attempted is None or attempted.get("previous_release_key") != release_key:
            continue
        attempted_path = root / str(attempted["release_key"])
        try:
            candidate_body = attempted_path.read_bytes()
        except OSError:
            continue
        if (
            hashlib.sha256(candidate_body).hexdigest()
            == PurePosixPath(str(attempted["release_key"])).stem
            and previous_pointer == candidate_body
        ):
            attempted_body = candidate_body
            recovered_from_attempt = attempted
            break
    budget = None
    previous_release_key = None
    if recovered_from_attempt is not None:
        assert attempted_body is not None
        budget = {
            "projected_remote_bytes": int(recovered_from_attempt["remote_bytes"])
            + len(release_body)
            - len(attempted_body),
            "projected_remote_objects": int(recovered_from_attempt["remote_objects"]),
        }
        previous_release_key = str(recovered_from_attempt["release_key"])
    if _read_remote_pointer(target, runner) != previous_pointer:
        raise RuntimeError("remote release pointer changed during activation")
    if budget is not None:
        _write_ledger(
            root,
            target,
            release_key,
            budget,
            previous_release_key=previous_release_key,
            path=_pending_ledger_path(root),
        )
    runner(
        ["rclone", "copyto", remote_release, pointer_target, "--no-check-dest"],
        check=True,
    )
    remote_pointer = runner(
        ["rclone", "cat", pointer_target],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if remote_pointer != release_body:
        raise RuntimeError("remote release pointer verification failed")
    ledger_written = False
    if budget is not None:
        try:
            _write_ledger(
                root,
                target,
                release_key,
                budget,
                previous_release_key=previous_release_key,
            )
            _pending_ledger_path(root).unlink(missing_ok=True)
            ledger_written = True
        except OSError:
            # Pointer rollback succeeded; the pending ledger remains recoverable.
            ledger_written = False
    else:
        try:
            remote_bytes, remote_objects = _remote_size(target, runner)
            _write_ledger(
                root,
                target,
                release_key,
                {
                    "projected_remote_bytes": remote_bytes,
                    "projected_remote_objects": remote_objects,
                },
            )
            ledger_written = True
        except OSError, RuntimeError, subprocess.CalledProcessError:
            ledger_written = False
    return {
        "release_key": release_key,
        "remote": target,
        "pointer_verified": True,
        "ledger_written": ledger_written,
        "ledger_recovered": recovered_from_attempt is not None,
        "mode": "activate",
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish a validated static release with release.json written last."
    )
    parser.add_argument("root", type=Path)
    parser.add_argument("--remote", required=True)
    release_group = parser.add_mutually_exclusive_group()
    release_group.add_argument("--release")
    release_group.add_argument("--activate")
    release_group.add_argument("--reconcile-smoke", action="store_true")
    parser.add_argument("--expected-current")
    parser.add_argument("--verified-incremental", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.reconcile_smoke:
            if args.verified_incremental or args.expected_current is not None:
                raise ValueError(
                    "--reconcile-smoke cannot be combined with incremental or activation options"
                )
            report = reconcile_pending_smoke(args.root, args.remote)
        elif args.activate:
            if args.verified_incremental:
                raise ValueError("--verified-incremental cannot be used with --activate")
            report = activate_remote_release(
                args.root,
                args.remote,
                args.activate,
                expected_current=args.expected_current,
            )
        else:
            if args.expected_current is not None:
                raise ValueError("--expected-current requires --activate")
            report = publish_static(
                args.root,
                args.remote,
                release=args.release,
                verified_incremental=args.verified_incremental,
            )
    except IncrementalExportError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": "partial",
                    "safe_code": error.code,
                    "message": str(error),
                }
            )
        )
        return 2
    except (OSError, subprocess.CalledProcessError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
