from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

CommandRunner = Callable[..., subprocess.CompletedProcess[Any]]
_CANONICAL_CHUNK_BYTES = 512 * 1024 * 1024
_REMOTE_CANONICAL_CHUNK = "/tmp/redstm-canonical.chunk.partial"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class OracleTarget:
    host: str
    user: str
    key: Path

    def __post_init__(self) -> None:
        if re.fullmatch(r"[a-zA-Z0-9.-]+", self.host) is None:
            raise ValueError("Oracle host is invalid")
        if re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", self.user) is None:
            raise ValueError("Oracle user is invalid")
        if not self.key.expanduser().is_file():
            raise ValueError("Oracle SSH key is missing")

    @property
    def destination(self) -> str:
        return f"{self.user}@{self.host}"


def _ssh(target: OracleTarget) -> list[str]:
    return [
        "ssh",
        "-n",
        "-i",
        str(target.key.expanduser().resolve()),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        target.destination,
    ]


def _scp(target: OracleTarget) -> list[str]:
    return [
        "scp",
        "-i",
        str(target.key.expanduser().resolve()),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
    ]


def preflight(root: Path, *, runner: CommandRunner = subprocess.run) -> str:
    root = root.expanduser().resolve(strict=True)
    status = runner(
        ["git", "status", "--porcelain"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    if status.stdout:
        raise RuntimeError("working tree must be clean before deploy")
    checks = [
        ["uv", "lock", "--check"],
        ["uv", "run", "pytest", "-q"],
        ["uv", "run", "ruff", "check", "."],
        ["uv", "run", "ruff", "format", "--check", "."],
        ["uv", "run", "mypy", "crawler", "scripts", "tests"],
    ]
    for command in checks:
        runner(command, cwd=root, check=True)
    release = runner(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    if re.fullmatch(r"[0-9a-f]{40}", release) is None:
        raise RuntimeError("git release identity is invalid")
    return release


def build_archive(
    root: Path, release: str, destination: Path, *, runner: CommandRunner = subprocess.run
) -> str:
    if re.fullmatch(r"[0-9a-f]{40}", release) is None:
        raise ValueError("release identity is invalid")
    runner(
        [
            "git",
            "archive",
            "--format=tar.gz",
            f"--output={destination}",
            release,
        ],
        cwd=root,
        check=True,
    )
    return _sha256_file(destination)


def deploy_release(
    target: OracleTarget,
    release: str,
    archive: Path,
    archive_sha256: str,
    installer: Path,
    *,
    runner: CommandRunner = subprocess.run,
) -> None:
    if (
        re.fullmatch(r"[0-9a-f]{40}", release) is None
        or re.fullmatch(r"[0-9a-f]{64}", archive_sha256) is None
    ):
        raise ValueError("release archive identity is invalid")
    remote_archive = f"/tmp/redstm-release-{release}.tar.gz.partial"
    remote_installer = "/tmp/redstm-install-release.sh"
    runner([*_scp(target), str(archive), f"{target.destination}:{remote_archive}"], check=True)
    runner([*_scp(target), str(installer), f"{target.destination}:{remote_installer}"], check=True)
    runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            remote_installer,
            "install",
            release,
            remote_archive,
            archive_sha256,
        ],
        check=True,
    )


def activate_canonical(
    target: OracleTarget,
    canonical: Path,
    *,
    runner: CommandRunner = subprocess.run,
    chunk_bytes: int = _CANONICAL_CHUNK_BYTES,
) -> dict[str, Any]:
    canonical = canonical.expanduser().resolve(strict=True)
    if chunk_bytes < 1:
        raise ValueError("canonical chunk size must be positive")
    source_before = canonical.stat()
    size = source_before.st_size
    offset_result = runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "canonical-transfer-size",
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    raw_offset = offset_result.stdout.strip()
    if re.fullmatch(r"[0-9]+", raw_offset) is None:
        raise RuntimeError("remote canonical transfer size is invalid")
    remote_offset = int(raw_offset)
    if remote_offset > size:
        raise RuntimeError("remote canonical transfer is not resumable")
    if remote_offset != size and remote_offset % chunk_bytes:
        remote_offset -= remote_offset % chunk_bytes
        runner(
            [
                *_ssh(target),
                "sudo",
                "bash",
                "/opt/redstm/install_release.sh",
                "truncate-canonical-transfer",
                str(remote_offset),
            ],
            check=True,
        )
    digest = hashlib.sha256()
    position = 0
    with (
        canonical.open("rb") as source,
        TemporaryDirectory(prefix="redstm-canonical-chunk-") as temporary,
    ):
        chunk = Path(temporary) / "canonical.chunk"
        while position < size:
            chunk_digest = hashlib.sha256()
            chunk_size = 0
            planned_size = min(chunk_bytes, size - position)
            with chunk.open("wb") as destination:
                while chunk_size < planned_size:
                    block = source.read(min(1024 * 1024, planned_size - chunk_size))
                    if not block:
                        break
                    destination.write(block)
                    digest.update(block)
                    chunk_digest.update(block)
                    chunk_size += len(block)
            if chunk_size != planned_size:
                raise RuntimeError("canonical source ended before its declared size")
            next_position = position + chunk_size
            if next_position > remote_offset:
                if position != remote_offset:
                    raise RuntimeError("remote canonical transfer offset changed")
                runner(
                    [
                        *_scp(target),
                        str(chunk),
                        f"{target.destination}:{_REMOTE_CANONICAL_CHUNK}",
                    ],
                    check=True,
                )
                runner(
                    [
                        *_ssh(target),
                        "sudo",
                        "bash",
                        "/opt/redstm/install_release.sh",
                        "append-canonical-chunk",
                        str(position),
                        str(chunk_size),
                        chunk_digest.hexdigest(),
                    ],
                    check=True,
                )
                remote_offset = next_position
                print(
                    json.dumps({"canonical_bytes": remote_offset, "canonical_total": size}),
                    flush=True,
                )
            position = next_position
    source_after = canonical.stat()
    if (source_after.st_size, source_after.st_mtime_ns) != (
        source_before.st_size,
        source_before.st_mtime_ns,
    ):
        raise RuntimeError("canonical source changed during transfer")
    canonical_sha256 = digest.hexdigest()
    runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "activate-canonical",
            str(size),
            canonical_sha256,
        ],
        check=True,
    )
    return {"bytes": size, "sha256": canonical_sha256}


def rollback(target: OracleTarget, *, runner: CommandRunner = subprocess.run) -> None:
    runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "rollback",
        ],
        check=True,
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deploy a versioned ReDSTM Oracle release.")
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", default="ubuntu")
    parser.add_argument("--key", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    deploy = commands.add_parser("deploy")
    deploy.add_argument("--canonical", type=Path)
    commands.add_parser("rollback")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parents[1]
    target = OracleTarget(args.host, args.user, args.key)
    if args.command == "rollback":
        rollback(target)
        print(json.dumps({"ok": True, "mode": "rollback"}))
        return 0
    release = preflight(root)
    installer = root / "deploy" / "oracle" / "install_release.sh"
    with TemporaryDirectory(prefix="redstm-oracle-deploy-") as temporary:
        archive = Path(temporary) / f"redstm-release-{release}.tar.gz"
        digest = build_archive(root, release, archive)
        deploy_release(target, release, archive, digest, installer)
        canonical = activate_canonical(target, args.canonical) if args.canonical else None
    print(
        json.dumps(
            {"ok": True, "mode": "deploy", "release": release, "canonical": canonical},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
