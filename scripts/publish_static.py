from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from scripts.export_static import validate_release


def _current_release(root: Path) -> str:
    pointer = root / "release.json"
    if not pointer.is_file():
        raise ValueError("release.json is missing")
    return f"releases/{hashlib.sha256(pointer.read_bytes()).hexdigest()}.json"


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
    if not re.fullmatch(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+", remote):
        raise ValueError("remote must include a bucket path")
    if runner is subprocess.run and shutil.which("rclone") is None:
        raise RuntimeError("rclone is not installed")

    validation = validate_release(root, release or _current_release(root))
    release_key = str(validation["release_key"])
    release_body = (root / release_key).read_bytes()
    target = remote.rstrip("/")
    common = {"check": True}

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
        ],
        **common,
    )
    runner(
        ["rclone", "check", str(root), target, "--exclude", "/release.json", "--one-way"],
        **common,
    )
    pointer_target = f"{target}/release.json"
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
    return {**validation, "remote": target, "pointer_verified": True}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish a validated static release with release.json written last."
    )
    parser.add_argument("root", type=Path)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--release")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        report = publish_static(args.root, args.remote, release=args.release)
    except (OSError, subprocess.CalledProcessError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": str(error)}))
        return 1
    print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
