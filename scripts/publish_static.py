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

from scripts.export_static import validate_release

_MAX_R2_BYTES = 20_000_000_000
_MAX_R2_OBJECTS = 800_000


def _remote_target(remote: str, runner: Any) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+", remote):
        raise ValueError("remote must include a bucket path")
    if runner is subprocess.run and shutil.which("rclone") is None:
        raise RuntimeError("rclone is not installed")
    return remote.rstrip("/")


def _current_release(root: Path) -> str:
    pointer = root / "release.json"
    if not pointer.is_file():
        raise ValueError("release.json is missing")
    return f"releases/{hashlib.sha256(pointer.read_bytes()).hexdigest()}.json"


def _ledger_path(root: Path) -> Path:
    return root / ".publish-ledger.json"


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


def _release_object_keys(root: Path, body: bytes) -> set[str]:
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
        keys.update(_object_key(post) for post in posts)
    return keys


def _read_ledger(root: Path, target: str, release_key: str) -> dict[str, Any] | None:
    try:
        ledger = json.loads(_ledger_path(root).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if (
        not isinstance(ledger, dict)
        or ledger.get("schema_version") != 1
        or ledger.get("remote") != target
        or ledger.get("release_key") != release_key
        or type(ledger.get("remote_bytes")) is not int
        or type(ledger.get("remote_objects")) is not int
        or ledger["remote_bytes"] < 0
        or ledger["remote_objects"] < 0
    ):
        return None
    return ledger


def _delta_plan(
    root: Path,
    target: str,
    previous_body: bytes,
    release_body: bytes,
) -> tuple[list[str], dict[str, int]] | None:
    previous_key = f"releases/{hashlib.sha256(previous_body).hexdigest()}.json"
    previous_path = root / previous_key
    if not previous_path.is_file() or previous_path.read_bytes() != previous_body:
        return None
    try:
        ledger = _read_ledger(root, target, previous_key)
        if ledger is None:
            return None
        keys = sorted(
            _release_object_keys(root, release_body) - _release_object_keys(root, previous_body)
        )
    except OSError, ValueError, json.JSONDecodeError:
        return None
    new_bytes = sum((root / key).stat().st_size for key in keys)
    projected_bytes = (
        int(ledger["remote_bytes"]) + new_bytes + len(release_body) - len(previous_body)
    )
    projected_objects = int(ledger["remote_objects"]) + len(keys)
    if projected_bytes > _MAX_R2_BYTES or projected_objects > _MAX_R2_OBJECTS:
        raise RuntimeError(
            "R2 publishing budget limit exceeded: "
            f"projected_bytes={projected_bytes}, projected_objects={projected_objects}"
        )
    return keys, {
        "remote_bytes_before": int(ledger["remote_bytes"]),
        "remote_objects_before": int(ledger["remote_objects"]),
        "new_bytes": new_bytes,
        "new_objects": len(keys),
        "projected_remote_bytes": projected_bytes,
        "projected_remote_objects": projected_objects,
    }


def _write_ledger(root: Path, target: str, release_key: str, budget: dict[str, int]) -> None:
    ledger = _ledger_path(root)
    partial = ledger.with_suffix(f"{ledger.suffix}.partial")
    try:
        partial.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "remote": target,
                    "release_key": release_key,
                    "remote_bytes": budget["projected_remote_bytes"],
                    "remote_objects": budget["projected_remote_objects"],
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        os.replace(partial, ledger)
    finally:
        partial.unlink(missing_ok=True)


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


def _r2_budget_preflight(
    root: Path,
    target: str,
    *,
    pointer_bytes: int,
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
                "--exclude",
                "/release.json",
                "--exclude",
                "/.publish-ledger.json",
                "--immutable",
                "--dry-run",
                "--missing-on-dst",
                str(missing),
                "--checkers",
                "16",
                "--fast-list",
                "--stats",
                "0",
                "--log-level",
                "ERROR",
            ],
            check=True,
        )
        if missing.is_file():
            for raw_key in missing.read_text(encoding="utf-8").splitlines():
                key = PurePosixPath(raw_key)
                if key.is_absolute() or not key.parts or ".." in key.parts:
                    raise RuntimeError(f"invalid rclone object key: {raw_key!r}")
                local = root.joinpath(*key.parts)
                if not local.is_file():
                    raise RuntimeError(f"rclone reported missing local object: {raw_key}")
                new_bytes += local.stat().st_size
                new_objects += 1

    projected_bytes = remote_bytes + new_bytes + pointer_bytes
    projected_objects = remote_objects + new_objects + 1
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


def publish_static(
    root: Path,
    remote: str,
    *,
    release: str | None = None,
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    root = root.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("static root must be a directory")

    validation = validate_release(root, release or _current_release(root))
    release_key = str(validation["release_key"])
    release_body = (root / release_key).read_bytes()
    target = _remote_target(remote, runner)
    pointer_target = f"{target}/release.json"
    try:
        remote_pointer = runner(
            ["rclone", "cat", pointer_target],
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
    except subprocess.CalledProcessError:
        remote_pointer = None
    if remote_pointer == release_body:
        ledger_written = _read_ledger(root, target, release_key) is not None
        if not ledger_written:
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
            except (OSError, RuntimeError, subprocess.CalledProcessError):
                ledger_written = False
        return {
            **validation,
            "remote": target,
            "pointer_verified": True,
            "mode": "noop",
            "new_bytes": 0,
            "new_objects": 0,
            "ledger_written": ledger_written,
        }

    common = {"check": True}
    delta = (
        _delta_plan(root, target, remote_pointer, release_body)
        if remote_pointer is not None
        else None
    )
    if delta is None:
        mode = "publish"
        budget = _r2_budget_preflight(
            root,
            target,
            pointer_bytes=len(release_body),
            runner=runner,
        )
        runner(
            [
                "rclone",
                "copy",
                str(root),
                target,
                "--exclude",
                "/release.json",
                "--exclude",
                "/.publish-ledger.json",
                "--immutable",
                "--checkers",
                "16",
                "--transfers",
                "16",
                "--fast-list",
            ],
            **common,
        )
        runner(
            [
                "rclone",
                "check",
                str(root),
                target,
                "--exclude",
                "/release.json",
                "--exclude",
                "/.publish-ledger.json",
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
                    "16",
                    "--transfers",
                    "16",
                ],
                **common,
            )
            runner(
                ["rclone", "check", str(root), target, "--files-from", str(files), "--one-way"],
                **common,
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
        _write_ledger(root, target, release_key, budget)
        ledger_written = True
    except OSError:
        ledger_written = False
    return {
        **validation,
        **budget,
        "remote": target,
        "pointer_verified": True,
        "ledger_written": ledger_written,
        "mode": mode,
    }


def activate_remote_release(
    root: Path,
    remote: str,
    release: str,
    *,
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

    target = _remote_target(remote, runner)
    remote_release = f"{target}/{release_key}"
    existing = runner(
        ["rclone", "cat", remote_release],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    if existing != release_body:
        raise RuntimeError("remote versioned release verification failed")

    pointer_target = f"{target}/release.json"
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
    return {
        "release_key": release_key,
        "remote": target,
        "pointer_verified": True,
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
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.activate:
            report = activate_remote_release(args.root, args.remote, args.activate)
        else:
            report = publish_static(args.root, args.remote, release=args.release)
    except (OSError, subprocess.CalledProcessError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
