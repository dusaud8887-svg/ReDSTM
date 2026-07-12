from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import tarfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

CommandRunner = Callable[..., subprocess.CompletedProcess[Any]]
_CANONICAL_CHUNK_BYTES = 512 * 1024 * 1024
_MAX_STATUS_BYTES = 2048
_MAX_INSTALLER_BYTES = 1024 * 1024
_POST_INSTALL_STATUS_ATTEMPTS = 5
_CANONICAL_MIGRATION_TIMEOUT_SECONDS = 8 * 60 * 60
_MAX_SCHEMA_STATUS_BYTES = 16 * 1024


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


def _connection_options(target: OracleTarget) -> list[str]:
    return [
        "-i",
        str(target.key.expanduser().resolve()),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
    ]


def _ssh(target: OracleTarget) -> list[str]:
    return ["ssh", "-n", *_connection_options(target), target.destination]


def _scp(target: OracleTarget) -> list[str]:
    return ["scp", *_connection_options(target)]


def release_identity(root: Path, *, runner: CommandRunner = subprocess.run) -> str:
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
    release = runner(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    if re.fullmatch(r"[0-9a-f]{40}", release) is None:
        raise RuntimeError("git release identity is invalid")
    runner(["git", "fetch", "--quiet", "--prune"], cwd=root, check=True, timeout=60)
    upstream_result = runner(
        ["git", "rev-parse", "--verify", "@{upstream}^{commit}"],
        cwd=root,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if upstream_result.returncode != 0:
        raise RuntimeError("current branch must have a configured upstream before deploy")
    upstream = upstream_result.stdout.strip()
    if re.fullmatch(r"[0-9a-f]{40}", upstream) is None:
        raise RuntimeError("configured upstream identity is invalid")
    if release != upstream:
        raise RuntimeError("HEAD must exactly match its configured upstream before deploy")
    return release


def quality_gates(root: Path, *, runner: CommandRunner = subprocess.run) -> None:
    checks = [
        ["uv", "lock", "--check"],
        ["uv", "run", "pytest", "-q"],
        ["uv", "run", "ruff", "check", "."],
        ["uv", "run", "ruff", "format", "--check", "."],
        ["uv", "run", "mypy", "crawler", "scripts", "tests"],
    ]
    for command in checks:
        runner(command, cwd=root, check=True)


def preflight(root: Path, *, runner: CommandRunner = subprocess.run) -> str:
    release = release_identity(root, runner=runner)
    quality_gates(root, runner=runner)
    return release


def _validate_status(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("remote status must be a JSON object")
    report = cast(dict[str, Any], payload)
    if set(report) != {
        "canonical_previous_count",
        "control_timer",
        "current_release",
        "previous_release",
        "rclone",
        "releases_count",
        "root_free_bytes",
        "schedule_timer",
    }:
        raise RuntimeError("remote status fields are invalid")
    for key in ("current_release", "previous_release"):
        release = report[key]
        if release is not None and (
            not isinstance(release, str) or re.fullmatch(r"[0-9a-f]{40}", release) is None
        ):
            raise RuntimeError(f"remote {key} is invalid")
    for key in ("control_timer", "schedule_timer"):
        timer = report[key]
        if (
            not isinstance(timer, dict)
            or set(timer) != {"active", "enabled"}
            or type(timer["active"]) is not bool
            or type(timer["enabled"]) is not bool
        ):
            raise RuntimeError(f"remote {key} is invalid")
    rclone = report["rclone"]
    if not isinstance(rclone, dict) or set(rclone) != {"available", "version"}:
        raise RuntimeError("remote rclone status is invalid")
    available, version = rclone["available"], rclone["version"]
    if type(available) is not bool or available != (version is not None):
        raise RuntimeError("remote rclone availability is invalid")
    if version is not None and (
        not isinstance(version, str) or re.fullmatch(r"[0-9][0-9A-Za-z.+_-]{0,31}", version) is None
    ):
        raise RuntimeError("remote rclone version is invalid")
    for key in ("canonical_previous_count", "releases_count", "root_free_bytes"):
        value = report[key]
        if type(value) is not int or not 0 <= value <= 2**63 - 1:
            raise RuntimeError(f"remote {key} is invalid")
    return report


def _status_at(target: OracleTarget, installer: str, *, runner: CommandRunner) -> dict[str, Any]:
    result = runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            installer,
            "status",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
    )
    raw = result.stdout
    if not isinstance(raw, str):
        raise RuntimeError("remote status output is missing")
    if len(raw.encode("utf-8")) > _MAX_STATUS_BYTES:
        raise RuntimeError("remote status output is too large")
    try:
        payload: object = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("remote status is not valid JSON") from error
    return _validate_status(payload)


def status(target: OracleTarget, *, runner: CommandRunner = subprocess.run) -> dict[str, Any]:
    return _status_at(target, "/opt/redstm/install_release.sh", runner=runner)


def canonical_schema_status(
    target: OracleTarget, *, runner: CommandRunner = subprocess.run
) -> dict[str, Any]:
    result = runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "canonical-schema-status",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )
    raw = result.stdout
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > _MAX_SCHEMA_STATUS_BYTES:
        raise RuntimeError("remote canonical schema status output is invalid")
    try:
        payload: object = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("remote canonical schema status is not valid JSON") from error
    if not isinstance(payload, dict) or set(payload) != {
        "application_id",
        "compatible",
        "exact",
        "migration_count",
        "migrations",
        "schema_policy",
        "schema_version",
    }:
        raise RuntimeError("remote canonical schema status fields are invalid")
    report = cast(dict[str, Any], payload)
    for key in ("application_id", "migration_count", "schema_version"):
        if type(report[key]) is not int or not 0 <= report[key] <= 2**31 - 1:
            raise RuntimeError(f"remote canonical {key} is invalid")
    if (
        type(report["compatible"]) is not bool
        or type(report["exact"]) is not bool
        or (report["exact"] and not report["compatible"])
        or not isinstance(report["schema_policy"], str)
        or re.fullmatch(r"[a-z0-9-]{1,32}", report["schema_policy"]) is None
        or not isinstance(report["migrations"], list)
    ):
        raise RuntimeError("remote canonical schema status metadata is invalid")
    migrations = report["migrations"]
    if not all(
        isinstance(item, list)
        and len(item) == 2
        and type(item[0]) is int
        and item[0] >= 1
        and isinstance(item[1], str)
        and re.fullmatch(r"[0-9a-f]{64}", item[1]) is not None
        for item in migrations
    ) or len({item[0] for item in migrations}) != len(migrations):
        raise RuntimeError("remote canonical migrations are invalid")
    if report["migration_count"] != len(migrations):
        raise RuntimeError("remote canonical migration count is invalid")
    return report


def migrate_canonical_schema(
    target: OracleTarget,
    *,
    expected_current: str,
    expected_previous: str,
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    for name, release in (
        ("current", expected_current),
        ("previous", expected_previous),
    ):
        if re.fullmatch(r"[0-9a-f]{40}", release) is None:
            raise ValueError(f"expected {name} release is invalid")
    if expected_current == expected_previous:
        raise ValueError("canonical migration requires two distinct releases")
    result = runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "migrate-canonical",
            expected_current,
            expected_previous,
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=_CANONICAL_MIGRATION_TIMEOUT_SECONDS,
    )
    raw = result.stdout
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 4096:
        raise RuntimeError("remote canonical migration output is invalid")
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in fields:
            raise RuntimeError("remote canonical migration output is invalid")
        fields[key] = value
    if fields.get("canonical-schema") not in {"migrated", "noop"}:
        raise RuntimeError("remote canonical migration result is invalid")
    if re.fullmatch(r"[1-9][0-9]*", fields.get("schema-version", "")) is None:
        raise RuntimeError("remote canonical migration schema version is invalid")
    optional = set(fields) - {"canonical-schema", "schema-version"}
    if fields["canonical-schema"] == "noop":
        if optional:
            raise RuntimeError("remote canonical migration no-op fields are invalid")
    elif optional != {"snapshot", "manifest"}:
        raise RuntimeError("remote canonical migration evidence is incomplete")
    elif not all(
        re.fullmatch(r"/srv/redstm/snapshots/[A-Za-z0-9_.-]{1,200}", fields[name])
        for name in ("snapshot", "manifest")
    ):
        raise RuntimeError("remote canonical migration evidence path is invalid")
    return {
        "state": fields["canonical-schema"],
        "schema_version": int(fields["schema-version"]),
        **({name: fields[name] for name in ("snapshot", "manifest")} if optional else {}),
    }


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


def _installer_from_archive(archive: Path) -> bytes:
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            member = bundle.getmember("deploy/oracle/install_release.sh")
            if not member.isfile() or not 0 < member.size <= _MAX_INSTALLER_BYTES:
                raise RuntimeError("release installer member is invalid")
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("release installer member is missing")
            data = source.read(_MAX_INSTALLER_BYTES + 1)
    except (KeyError, OSError, tarfile.TarError) as error:
        raise RuntimeError("release archive does not contain a valid installer") from error
    if len(data) != member.size:
        raise RuntimeError("release installer member is truncated")
    return data


def status_from_archive(
    target: OracleTarget,
    archive: Path,
    *,
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    installer = _installer_from_archive(archive)
    attempt = secrets.token_hex(16)
    remote_installer = f"/tmp/redstm-status-{attempt}.sh.partial"
    try:
        with TemporaryDirectory(prefix="redstm-oracle-status-") as temporary:
            snapshot = Path(temporary) / "install_release.sh"
            snapshot.write_bytes(installer)
            runner(
                [*_scp(target), str(snapshot), f"{target.destination}:{remote_installer}"],
                check=True,
            )
        return _status_at(target, remote_installer, runner=runner)
    finally:
        try:
            runner(
                [*_ssh(target), "rm", "-f", "--", remote_installer],
                check=False,
                timeout=20,
            )
        except OSError, subprocess.SubprocessError:
            pass


def deploy_release(
    target: OracleTarget,
    release: str,
    archive: Path,
    archive_sha256: str,
    installer: Path,
    *,
    install_mode: str = "install",
    runner: CommandRunner = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    if install_mode not in {"install", "install-bridge"}:
        raise ValueError("release install mode is invalid")
    if (
        re.fullmatch(r"[0-9a-f]{40}", release) is None
        or re.fullmatch(r"[0-9a-f]{64}", archive_sha256) is None
    ):
        raise ValueError("release archive identity is invalid")
    attempt = secrets.token_hex(16)
    committed_installer = _installer_from_archive(archive)
    installer = installer.expanduser().resolve(strict=True)
    with installer.open("rb") as source:
        if source.read(_MAX_INSTALLER_BYTES + 1) != committed_installer:
            raise RuntimeError("installer does not match the release archive")
    installer_snapshot = archive.with_name(f".redstm-install-release-{attempt}.sh")
    installer_snapshot.write_bytes(committed_installer)
    remote_archive = f"/tmp/redstm-release-{release}-{attempt}.tar.gz.partial"
    remote_installer = f"/tmp/redstm-install-release-{release}-{attempt}.sh.partial"
    try:
        runner([*_scp(target), str(archive), f"{target.destination}:{remote_archive}"], check=True)
        runner(
            [
                *_scp(target),
                str(installer_snapshot),
                f"{target.destination}:{remote_installer}",
            ],
            check=True,
        )
        try:
            before_install = _status_at(target, remote_installer, runner=runner)
        except (OSError, subprocess.SubprocessError, RuntimeError) as status_error:
            raise RuntimeError(
                f"pre-install status failed; install not started: {status_error}"
            ) from status_error
        install_command = [
            *_ssh(target),
            "sudo",
            "bash",
            remote_installer,
            install_mode,
            release,
            remote_archive,
            archive_sha256,
            before_install["current_release"] or "none",
        ]
        try:
            runner(
                install_command,
                check=True,
                stderr=subprocess.PIPE,
                text=True,
            )
        except subprocess.CalledProcessError as install_error:
            if (
                install_error.returncode == 75
                and isinstance(install_error.stderr, str)
                and "redstm_install_not_started" in install_error.stderr.splitlines()
            ):
                raise RuntimeError(
                    "install not started because the remote release state changed or is busy"
                ) from install_error
            install_failure = f"install failed with exit status {install_error.returncode}"
            try:
                before_rollback = status(target, runner=runner)
            except (OSError, subprocess.SubprocessError, RuntimeError) as status_error:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback not attempted because status check "
                    f"failed: {status_error}"
                ) from install_error
            rollback_target = before_install["current_release"]
            if before_install["current_release"] == release:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback not attempted because the release was "
                    "already current before install"
                ) from install_error
            if before_rollback["current_release"] != release:
                current = before_rollback["current_release"] or "unavailable"
                raise RuntimeError(
                    f"{install_failure}; automatic rollback not attempted because current release "
                    f"is {current}, not the attempted release"
                ) from install_error
            if rollback_target is None:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback failed because the pre-install current "
                    "release is unavailable"
                ) from install_error
            try:
                rollback(
                    target,
                    expected_current=release,
                    target_release=rollback_target,
                    expected_attempt=attempt,
                    runner=runner,
                )
            except subprocess.CalledProcessError as rollback_error:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback failed with exit status "
                    f"{rollback_error.returncode}"
                ) from install_error
            except (OSError, RuntimeError, ValueError) as rollback_error:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback failed: {rollback_error}"
                ) from install_error
            try:
                after_rollback = status(target, runner=runner)
            except (OSError, subprocess.SubprocessError, RuntimeError) as status_error:
                raise RuntimeError(
                    f"{install_failure}; automatic rollback command completed but verification "
                    f"failed: {status_error}"
                ) from install_error
            if after_rollback["current_release"] != rollback_target:
                current = after_rollback["current_release"] or "unavailable"
                raise RuntimeError(
                    f"{install_failure}; automatic rollback command completed but current release "
                    f"is {current}, expected {rollback_target}"
                ) from install_error
            raise RuntimeError(
                f"{install_failure}; automatic rollback succeeded to {rollback_target}"
            ) from install_error
        last_status: dict[str, Any] | None = None
        last_error: BaseException | None = None
        for status_attempt in range(_POST_INSTALL_STATUS_ATTEMPTS):
            try:
                last_status = status(target, runner=runner)
                last_error = None
            except (OSError, subprocess.SubprocessError, RuntimeError) as status_error:
                last_error = status_error
            else:
                if last_status["current_release"] == release:
                    return last_status
            if status_attempt + 1 < _POST_INSTALL_STATUS_ATTEMPTS:
                sleep(2)
        if last_error is not None:
            raise RuntimeError(
                f"install completed but current release verification failed: {last_error}"
            ) from last_error
        assert last_status is not None
        current = last_status["current_release"] or "unavailable"
        raise RuntimeError(
            f"current release verification failed: expected {release}, observed {current}"
        )
    finally:
        try:
            installer_snapshot.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            runner(
                [*_ssh(target), "rm", "-f", "--", remote_archive, remote_installer],
                check=False,
                timeout=20,
            )
        except OSError, subprocess.SubprocessError:
            pass


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
    remote_chunk = f"/tmp/redstm-canonical-{secrets.token_hex(16)}.chunk.partial"
    try:
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
                            f"{target.destination}:{remote_chunk}",
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
                            remote_chunk,
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
    finally:
        try:
            runner(
                [*_ssh(target), "rm", "-f", "--", remote_chunk],
                check=False,
                timeout=20,
            )
        except OSError, subprocess.SubprocessError:
            pass


def rollback(
    target: OracleTarget,
    *,
    expected_current: str | None = None,
    target_release: str | None = None,
    expected_attempt: str | None = None,
    runner: CommandRunner = subprocess.run,
) -> None:
    if target_release is None:
        raise ValueError("rollback requires an explicit target release")
    if re.fullmatch(r"[0-9a-f]{40}", target_release) is None:
        raise ValueError("rollback target release is invalid")
    if expected_current is None:
        report = status(target, runner=runner)
        expected_current = report["current_release"]
    if (
        not isinstance(expected_current, str)
        or re.fullmatch(r"[0-9a-f]{40}", expected_current) is None
    ):
        raise RuntimeError("rollback current release is unavailable")
    if expected_attempt is not None and re.fullmatch(r"[0-9a-f]{32}", expected_attempt) is None:
        raise ValueError("rollback attempt identity is invalid")
    runner(
        [
            *_ssh(target),
            "sudo",
            "bash",
            "/opt/redstm/install_release.sh",
            "rollback",
            expected_current,
            target_release,
            expected_attempt or "none",
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
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--target-release", required=True)
    commands.add_parser("status")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parents[1]
    target = OracleTarget(args.host, args.user, args.key)
    if args.command == "status":
        print(json.dumps({"ok": True, "mode": "status", **status(target)}, sort_keys=True))
        return 0
    if args.command == "rollback":
        remote = status(target)
        rollback(
            target,
            expected_current=remote["current_release"],
            target_release=args.target_release,
        )
        print(
            json.dumps(
                {"ok": True, "mode": "rollback", "release": args.target_release},
                sort_keys=True,
            )
        )
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
