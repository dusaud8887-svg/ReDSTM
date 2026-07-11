from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
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


def _r2_budget_preflight(
    root: Path,
    target: str,
    *,
    pointer_bytes: int,
    runner: Any,
) -> dict[str, int]:
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
        return {
            **validation,
            "remote": target,
            "pointer_verified": True,
            "mode": "noop",
            "new_bytes": 0,
            "new_objects": 0,
        }

    common = {"check": True}
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
        ["rclone", "check", str(root), target, "--exclude", "/release.json", "--one-way"],
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
    return {
        **validation,
        **budget,
        "remote": target,
        "pointer_verified": True,
        "mode": "publish",
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
