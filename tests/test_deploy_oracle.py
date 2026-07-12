from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
from pathlib import Path
from typing import Any

import pytest

from scripts.deploy_oracle import (
    OracleTarget,
    activate_canonical,
    deploy_release,
    preflight,
    rollback,
    status,
    status_from_archive,
)


def _target(tmp_path: Path) -> OracleTarget:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    return OracleTarget("oracle.example", "ubuntu", key)


def _status_json(
    current_release: str | None,
    previous_release: str | None = "d" * 40,
) -> str:
    return json.dumps(
        {
            "canonical_previous_count": 2,
            "control_timer": {"active": True, "enabled": True},
            "current_release": current_release,
            "previous_release": previous_release,
            "rclone": {"available": True, "version": "1.72.1"},
            "releases_count": 3,
            "root_free_bytes": 82_000_000_000,
            "schedule_timer": {"active": False, "enabled": False},
        }
    )


def _run_canonical_installer(
    tmp_path: Path, expected: bytes, *, crash_at: str = ""
) -> subprocess.CompletedProcess[str]:
    root = Path(__file__).resolve().parents[1]
    installer = (root / "deploy" / "oracle" / "install_release.sh").read_text(encoding="utf-8")
    functions = installer.split('\nmode="${1:-}"', 1)[0]
    harness = tmp_path / "canonical-harness.sh"
    harness.write_text(
        functions
        + r"""
CANONICAL_TARGET="$PWD/canonical/archive.sqlite"
CANONICAL_TRANSFER="$PWD/canonical/archive.sqlite.transfer.partial"
CANONICAL_STAGING="$PWD/canonical/archive.sqlite.partial"
CURRENT="$PWD/current"
acquire_runner_lock() { :; }
sudo() { :; }
sync() { :; }
canonical_activation_checkpoint() {
  [[ "${CRASH_AT:-}" != "$1" ]] || return 97
}
activate_canonical "$EXPECTED_BYTES" "$EXPECTED_HASH"
""",
        encoding="utf-8",
    )
    git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
    bash = str(git_bash) if git_bash.is_file() else shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for the Oracle installer harness")
    environment = os.environ.copy()
    environment.update(
        {
            "CRASH_AT": crash_at,
            "EXPECTED_BYTES": str(len(expected)),
            "EXPECTED_HASH": hashlib.sha256(expected).hexdigest(),
        }
    )
    return subprocess.run(
        [bash, harness.name],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def _release_files(tmp_path: Path, installer_data: bytes = b"#!/bin/sh\n") -> tuple[Path, Path]:
    archive = tmp_path / "release.tar.gz"
    installer = tmp_path / "install_release.sh"
    installer.write_bytes(installer_data)
    member = tarfile.TarInfo("deploy/oracle/install_release.sh")
    member.mode = 0o755
    member.size = len(installer_data)
    with tarfile.open(archive, "w:gz") as bundle:
        bundle.addfile(member, io.BytesIO(installer_data))
    return archive, installer


def test_target_rejects_shell_metacharacters(tmp_path: Path) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    with pytest.raises(ValueError, match="host"):
        OracleTarget("host;shutdown", "ubuntu", key)
    with pytest.raises(ValueError, match="user"):
        OracleTarget("host.example", "ubuntu root", key)


def test_deploy_uses_fixed_partial_and_installer_paths(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    commands: list[list[str]] = []

    release = "a" * 40

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        commands.append(command)
        stdout = ""
        if command[-1] == "status":
            is_staged = any(item.startswith("/tmp/redstm-install-release-") for item in command)
            current = "c" * 40 if is_staged else release
            stdout = _status_json(current)
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    report = deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    assert report["current_release"] == release
    assert len(commands) == 6
    remote_archive = commands[0][-1].split(":", 1)[1]
    remote_installer = commands[1][-1].split(":", 1)[1]
    nonce = remote_archive.removeprefix(f"/tmp/redstm-release-{release}-").removesuffix(
        ".tar.gz.partial"
    )
    assert len(nonce) == 32 and all(character in "0123456789abcdef" for character in nonce)
    assert remote_installer == f"/tmp/redstm-install-release-{release}-{nonce}.sh.partial"
    assert commands[1][-2] != str(installer)
    assert not Path(commands[1][-2]).exists()
    assert commands[2][-3:] == ["bash", remote_installer, "status"]
    assert commands[3][-8:] == [
        "sudo",
        "bash",
        remote_installer,
        "install",
        release,
        remote_archive,
        "b" * 64,
        "c" * 40,
    ]
    assert "enable" not in commands[3]
    assert commands[4][-3:] == [
        "bash",
        "/opt/redstm/install_release.sh",
        "status",
    ]
    assert commands[5][-5:] == ["rm", "-f", "--", remote_archive, remote_installer]


def test_deploy_retries_and_returns_the_validated_post_install_status(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release, previous = "a" * 40, "c" * 40
    post_install_statuses = 0
    sleeps: list[float] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal post_install_statuses
        if command[-1] != "status":
            return subprocess.CompletedProcess(command, 0, stdout="")
        if any(item.startswith("/tmp/redstm-install-release-") for item in command):
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(previous))
        post_install_statuses += 1
        if post_install_statuses == 1:
            return subprocess.CompletedProcess(command, 0, stdout="{}")
        current = previous if post_install_statuses == 2 else release
        return subprocess.CompletedProcess(command, 0, stdout=_status_json(current, previous))

    report = deploy_release(
        target,
        release,
        archive,
        "b" * 64,
        installer,
        runner=run,
        sleep=sleeps.append,
    )

    assert report["current_release"] == release
    assert post_install_statuses == 3
    assert sleeps == [2, 2]


def test_deploy_cleans_attempt_paths_when_upload_fails(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        if command[0] == "scp":
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(subprocess.CalledProcessError):
        deploy_release(target, "a" * 40, archive, "b" * 64, installer, runner=run)

    assert commands[-1][-5:-2] == ["rm", "-f", "--"]
    assert commands[-1][-2].startswith("/tmp/redstm-release-")
    assert commands[-1][-1].startswith("/tmp/redstm-install-release-")


def test_deploy_rejects_installer_outside_the_release_archive(tmp_path: Path) -> None:
    archive, installer = _release_files(tmp_path)
    installer.write_bytes(b"#!/bin/sh\nexit 1\n")

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise AssertionError(f"unexpected command: {command}")

    with pytest.raises(RuntimeError, match="does not match the release archive"):
        deploy_release(
            _target(tmp_path),
            "a" * 40,
            archive,
            "b" * 64,
            installer,
            runner=run,
        )


def test_preflight_requires_clean_tree_and_all_quality_gates(tmp_path: Path) -> None:
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = ""
        if command[-1:] == ["HEAD^{commit}"]:
            stdout = "c" * 40 + "\n"
        elif command[-1:] == ["@{upstream}^{commit}"]:
            stdout = "c" * 40 + "\n"
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    assert preflight(tmp_path, runner=run) == "c" * 40
    assert ["uv", "lock", "--check"] in commands
    assert ["uv", "run", "pytest", "-q"] in commands
    assert ["uv", "run", "ruff", "format", "--check", "."] in commands
    assert ["uv", "run", "mypy", "crawler", "scripts", "tests"] in commands
    assert ["git", "fetch", "--quiet", "--prune"] in commands
    assert not any(command[:2] == ["git", "merge-base"] for command in commands)


def test_preflight_rejects_missing_upstream(tmp_path: Path) -> None:
    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[-1:] == ["HEAD^{commit}"]:
            return subprocess.CompletedProcess(command, 0, stdout="c" * 40 + "\n")
        if command[-1:] == ["@{upstream}^{commit}"]:
            return subprocess.CompletedProcess(command, 128, stdout="")
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="configured upstream"):
        preflight(tmp_path, runner=run)


@pytest.mark.parametrize(
    ("head", "upstream"),
    [
        ("c" * 40, "d" * 40),
        ("d" * 40, "c" * 40),
    ],
    ids=["ahead", "behind"],
)
def test_preflight_rejects_any_head_upstream_mismatch(
    tmp_path: Path, head: str, upstream: str
) -> None:
    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[-1:] == ["HEAD^{commit}"]:
            return subprocess.CompletedProcess(command, 0, stdout=head + "\n")
        if command[-1:] == ["@{upstream}^{commit}"]:
            return subprocess.CompletedProcess(command, 0, stdout=upstream + "\n")
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="exactly match"):
        preflight(tmp_path, runner=run)


def test_status_returns_bounded_remote_state(tmp_path: Path) -> None:
    target = _target(tmp_path)
    commands: list[list[str]] = []
    options: list[dict[str, object]] = []

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        options.append(kwargs)
        return subprocess.CompletedProcess(command, 0, stdout=_status_json("a" * 40))

    report = status(target, runner=run)

    assert report["current_release"] == "a" * 40
    assert report["schedule_timer"] == {"active": False, "enabled": False}
    assert report["root_free_bytes"] == 82_000_000_000
    assert commands[0][-3:] == ["bash", "/opt/redstm/install_release.sh", "status"]
    assert options[0]["timeout"] == 20
    for option in (
        "IdentitiesOnly=yes",
        "StrictHostKeyChecking=yes",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=4",
    ):
        assert ["-o", option] == commands[0][commands[0].index(option) - 1 :][:2]


def test_status_from_archive_bootstraps_an_old_installer_and_cleans_up(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive = tmp_path / "release.tar.gz"
    installer = b"#!/usr/bin/env bash\nprintf '{}\\n'\n"
    with tarfile.open(archive, "w:gz") as bundle:
        member = tarfile.TarInfo("deploy/oracle/install_release.sh")
        member.size = len(installer)
        bundle.addfile(member, io.BytesIO(installer))
    uploaded = b""
    remote_installer = ""
    cleaned = ""

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal uploaded, remote_installer, cleaned
        if command[0] == "scp":
            uploaded = Path(command[-2]).read_bytes()
            remote_installer = command[-1].split(":", 1)[1]
            return subprocess.CompletedProcess(command, 0, stdout="")
        if command[-1] == "status":
            assert command[-2] == remote_installer
            return subprocess.CompletedProcess(command, 0, stdout=_status_json("a" * 40))
        if "rm" in command:
            cleaned = command[-1]
        return subprocess.CompletedProcess(command, 0, stdout="")

    report = status_from_archive(target, archive, runner=run)

    assert report["current_release"] == "a" * 40
    assert uploaded == installer
    assert cleaned == remote_installer


def test_status_rejects_unbounded_remote_output(tmp_path: Path) -> None:
    target = _target(tmp_path)

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, stdout="x" * 4096)

    with pytest.raises(RuntimeError, match="too large"):
        status(target, runner=run)


def test_rollback_resolves_and_sends_server_side_guards(tmp_path: Path) -> None:
    target = _target(tmp_path)
    current, previous = "a" * 40, "d" * 40
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = _status_json(current, previous) if command[-1] == "status" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    rollback(target, target_release=previous, runner=run)

    assert commands[1][-4:] == ["rollback", current, previous, "none"]


def test_rollback_requires_an_explicit_target(tmp_path: Path) -> None:
    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise AssertionError(f"unexpected command: {command}")

    with pytest.raises(ValueError, match="explicit target"):
        rollback(_target(tmp_path), runner=run)


def test_failed_install_rolls_back_only_after_attempted_release_is_current(
    tmp_path: Path,
) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release, previous = "a" * 40, "d" * 40
    commands: list[list[str]] = []
    status_calls = 0

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal status_calls
        commands.append(command)
        if "install" in command:
            raise subprocess.CalledProcessError(23, command)
        if command[-1] == "status":
            status_calls += 1
            current = [previous, release, previous][status_calls - 1]
            prior = ["e" * 40, "f" * 40, release][status_calls - 1]
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current, prior))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(
        RuntimeError,
        match=f"install failed with exit status 23; automatic rollback succeeded to {previous}",
    ):
        deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    rollback_index = next(index for index, command in enumerate(commands) if "rollback" in command)
    status_indexes = [index for index, command in enumerate(commands) if command[-1] == "status"]
    assert status_indexes[0] < status_indexes[1] < rollback_index < status_indexes[2]
    archive_path = commands[0][-1].split(":", 1)[1]
    attempt = archive_path.removeprefix(f"/tmp/redstm-release-{release}-").removesuffix(
        ".tar.gz.partial"
    )
    assert commands[rollback_index][-4:] == ["rollback", release, previous, attempt]


def test_failed_bootstrap_cannot_roll_back_without_a_previous_current(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release = "a" * 40
    commands: list[list[str]] = []
    status_calls = 0

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal status_calls
        commands.append(command)
        if "install" in command:
            raise subprocess.CalledProcessError(23, command)
        if command[-1] == "status":
            status_calls += 1
            current = None if status_calls == 1 else release
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current, None))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="pre-install current release is unavailable"):
        deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    assert not any("rollback" in command for command in commands)


def test_failed_install_does_not_roll_back_another_current_release(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release, current = "a" * 40, "c" * 40
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        if "install" in command:
            raise subprocess.CalledProcessError(23, command)
        if command[-1] == "status":
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="automatic rollback not attempted"):
        deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    assert not any("rollback" in command for command in commands)


def test_failed_install_reports_rollback_failure(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release, previous = "a" * 40, "d" * 40
    status_calls = 0

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal status_calls
        if "install" in command:
            raise subprocess.CalledProcessError(23, command)
        if command[-1] == "status":
            status_calls += 1
            current = previous if status_calls == 1 else release
            prior = "e" * 40 if status_calls == 1 else previous
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current, prior))
        if "rollback" in command:
            raise subprocess.CalledProcessError(42, command)
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(
        RuntimeError,
        match="install failed with exit status 23; automatic rollback failed with exit status 42",
    ):
        deploy_release(target, release, archive, "b" * 64, installer, runner=run)


def test_failed_idempotent_install_does_not_roll_back(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    release = "a" * 40
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        if "install" in command:
            raise subprocess.CalledProcessError(23, command)
        if command[-1] == "status":
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(release))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="already current before install"):
        deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    assert not any("rollback" in command for command in commands)


def test_install_not_started_never_checks_status_or_rolls_back(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    current = "d" * 40
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        if "install" in command:
            raise subprocess.CalledProcessError(
                75,
                command,
                stderr="redstm_install_not_started\nremote release busy\n",
            )
        if command[-1] == "status":
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="install not started"):
        deploy_release(target, "a" * 40, archive, "b" * 64, installer, runner=run)

    assert sum(command[-1] == "status" for command in commands) == 1
    assert not any("rollback" in command for command in commands)


def test_exit_75_without_sentinel_is_treated_as_started_failure(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    current = "d" * 40
    status_calls = 0

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal status_calls
        if "install" in command:
            raise subprocess.CalledProcessError(75, command, stderr="child failed\n")
        if command[-1] == "status":
            status_calls += 1
            return subprocess.CompletedProcess(command, 0, stdout=_status_json(current))
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(RuntimeError, match="install failed with exit status 75"):
        deploy_release(target, "a" * 40, archive, "b" * 64, installer, runner=run)

    assert status_calls == 2


def test_successful_install_requires_attempted_release_to_be_current(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive, installer = _release_files(tmp_path)
    status_calls = 0
    sleeps: list[float] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal status_calls
        if command[-1] == "status":
            status_calls += 1
        stdout = _status_json("c" * 40) if command[-1] == "status" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    with pytest.raises(RuntimeError, match="current release verification failed"):
        deploy_release(
            target,
            "a" * 40,
            archive,
            "b" * 64,
            installer,
            runner=run,
            sleep=sleeps.append,
        )

    assert status_calls == 6
    assert sleeps == [2, 2, 2, 2]


def test_canonical_transfer_resumes_at_verified_chunk_boundary(tmp_path: Path) -> None:
    target = _target(tmp_path)
    canonical = tmp_path / "archive.sqlite"
    canonical.write_bytes(b"abcdefghij")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = "4\n" if command[-1] == "canonical-transfer-size" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    report = activate_canonical(target, canonical, runner=run, chunk_bytes=4)

    assert report == {
        "bytes": 10,
        "sha256": "72399361da6a7754fec986dca5b7cbaf1c810a28ded4abaf56b2106d06cb78b0",
    }
    append_commands = [command for command in commands if "append-canonical-chunk" in command]
    assert [command[-3:-1] for command in append_commands] == [["4", "4"], ["8", "2"]]
    uploads = [command[-1].split(":", 1)[1] for command in commands if command[0] == "scp"]
    assert len(uploads) == 2 and len(set(uploads)) == 1
    remote_chunk = uploads[0]
    assert re.fullmatch(r"/tmp/redstm-canonical-[0-9a-f]{32}\.chunk\.partial", remote_chunk)
    assert all(command[-4] == remote_chunk for command in append_commands)
    activation = next(command for command in commands if "activate-canonical" in command)
    assert activation[-3:] == ["activate-canonical", "10", report["sha256"]]
    assert commands[-1][-4:] == ["rm", "-f", "--", remote_chunk]
    for command in [*append_commands, *(item for item in commands if item[0] == "scp")]:
        for option in ("IdentitiesOnly=yes", "ServerAliveInterval=15", "ServerAliveCountMax=4"):
            assert option in command


def test_canonical_transfer_truncates_unaligned_remote_partial(tmp_path: Path) -> None:
    target = _target(tmp_path)
    canonical = tmp_path / "archive.sqlite"
    canonical.write_bytes(b"abcdefghij")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = "3\n" if command[-1] == "canonical-transfer-size" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    activate_canonical(target, canonical, runner=run, chunk_bytes=4)

    truncate = next(command for command in commands if "truncate-canonical-transfer" in command)
    assert truncate[-2:] == ["truncate-canonical-transfer", "0"]
    append_commands = [command for command in commands if "append-canonical-chunk" in command]
    assert [command[-3:-1] for command in append_commands] == [["0", "4"], ["4", "4"], ["8", "2"]]


@pytest.mark.parametrize("failure", ["scp", "append"])
def test_canonical_chunk_failure_cleans_only_its_random_remote_path(
    tmp_path: Path, failure: str
) -> None:
    target = _target(tmp_path)
    canonical = tmp_path / "archive.sqlite"
    canonical.write_bytes(b"a")
    commands: list[list[str]] = []
    remote_chunk = ""

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal remote_chunk
        commands.append(command)
        if command[-1] == "canonical-transfer-size":
            return subprocess.CompletedProcess(command, 0, stdout="0\n")
        if command[0] == "scp":
            remote_chunk = command[-1].split(":", 1)[1]
            if failure == "scp":
                raise subprocess.CalledProcessError(1, command)
        if failure == "append" and "append-canonical-chunk" in command:
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(subprocess.CalledProcessError):
        activate_canonical(target, canonical, runner=run, chunk_bytes=1)

    assert re.fullmatch(r"/tmp/redstm-canonical-[0-9a-f]{32}\.chunk\.partial", remote_chunk)
    assert commands[-1][-4:] == ["rm", "-f", "--", remote_chunk]
    assert not any("find" in command for command in commands)


def test_canonical_activation_ssh_does_not_inherit_parent_stdin(tmp_path: Path) -> None:
    target = _target(tmp_path)
    canonical = tmp_path / "archive.sqlite"
    canonical.write_bytes(b"a")
    activated = False

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal activated
        if command[-1] == "canonical-transfer-size":
            return subprocess.CompletedProcess(command, 0, stdout="1\n")
        if "activate-canonical" in command:
            if "-n" not in command:
                raise subprocess.TimeoutExpired(command, 1)
            activated = True
        return subprocess.CompletedProcess(command, 0, stdout="")

    activate_canonical(target, canonical, runner=run, chunk_bytes=1)

    assert activated is True


def test_canonical_activation_keeps_old_inode_until_atomic_replace(tmp_path: Path) -> None:
    canonical = tmp_path / "canonical"
    canonical.mkdir()
    target = canonical / "archive.sqlite"
    staging = canonical / "archive.sqlite.partial"
    old, new = b"old canonical", b"new canonical"
    target.write_bytes(old)
    staging.write_bytes(new)
    old_inode = target.stat().st_ino

    for _ in range(2):
        failed = _run_canonical_installer(tmp_path, new, crash_at="before-snapshot-commit")
        assert failed.returncode != 0
        assert target.read_bytes() == old
        assert staging.read_bytes() == new

    snapshots = sorted(canonical.glob("archive.previous-*.sqlite"))
    assert len(snapshots) == 2
    assert len({snapshot.name for snapshot in snapshots}) == 2
    assert all(snapshot.read_bytes() == old for snapshot in snapshots)
    assert all(snapshot.stat().st_ino == old_inode for snapshot in snapshots)

    activated = _run_canonical_installer(tmp_path, new)

    assert activated.returncode == 0, activated.stderr
    assert "canonical=activated" in activated.stdout
    assert target.read_bytes() == new
    assert not staging.exists()
    snapshots = sorted(canonical.glob("archive.previous-*.sqlite"))
    assert len(snapshots) == 3
    assert all(snapshot.stat().st_ino == old_inode for snapshot in snapshots)


def test_canonical_activation_response_loss_retries_as_noop(tmp_path: Path) -> None:
    canonical = tmp_path / "canonical"
    canonical.mkdir()
    target = canonical / "archive.sqlite"
    staging = canonical / "archive.sqlite.partial"
    old, new = b"old canonical", b"new canonical"
    target.write_bytes(old)
    staging.write_bytes(new)
    old_inode = target.stat().st_ino

    lost_response = _run_canonical_installer(tmp_path, new, crash_at="after-replace")

    assert lost_response.returncode != 0
    assert target.read_bytes() == new
    assert not staging.exists()
    snapshots = list(canonical.glob("archive.previous-*.sqlite"))
    assert len(snapshots) == 1
    assert snapshots[0].stat().st_ino == old_inode

    retried = _run_canonical_installer(tmp_path, new)

    assert retried.returncode == 0, retried.stderr
    assert "canonical=noop" in retried.stdout
    assert target.read_bytes() == new
    assert list(canonical.glob("archive.previous-*.sqlite")) == snapshots


@pytest.mark.parametrize("staged", [b"short", b"bad canonical"])
def test_canonical_activation_rejects_invalid_staging(tmp_path: Path, staged: bytes) -> None:
    canonical = tmp_path / "canonical"
    canonical.mkdir()
    target = canonical / "archive.sqlite"
    target.write_bytes(b"old canonical")
    (canonical / "archive.sqlite.partial").write_bytes(staged)

    rejected = _run_canonical_installer(tmp_path, b"new canonical")

    assert rejected.returncode != 0
    assert target.read_bytes() == b"old canonical"
    assert not list(canonical.glob("archive.previous-*.sqlite"))


def test_install_assets_enable_control_only_and_never_touch_legacy() -> None:
    root = Path(__file__).resolve().parents[1]
    installer = (root / "deploy" / "oracle" / "install_release.sh").read_text(encoding="utf-8")
    service = (root / "deploy" / "oracle" / "redstm-control.service").read_text(encoding="utf-8")
    timer = (root / "deploy" / "oracle" / "redstm-control.timer").read_text(encoding="utf-8")
    schedule_service = (root / "deploy" / "oracle" / "redstm-schedule.service").read_text(
        encoding="utf-8"
    )
    schedule_timer = (root / "deploy" / "oracle" / "redstm-schedule.timer").read_text(
        encoding="utf-8"
    )

    assert "systemctl enable --now redstm-control.timer" in installer
    assert "enable --now redstm-schedule.timer" not in installer
    assert "UV_VERSION=0.11.28" in installer
    assert '"uv ${UV_VERSION}" ||' in installer
    assert "github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}" in installer
    assert "${asset}.sha256" in installer
    assert "sha256sum --check --strict --status" in installer
    assert (
        "UV_X86_64_SHA256=e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224"
        in installer
    )
    assert (
        "UV_AARCH64_SHA256=03e9fe0a81b0718d0bc84625de3885df6cc3f89a8b6af6121d6b9f6113fb6533"
        in installer
    )
    assert "UV_UNMANAGED_INSTALL" not in installer
    assert "/usr/local/bin/uvx" in installer
    assert installer.count("UV_NO_CONFIG=1") == 2
    assert installer.count('PYTHONPATH="$CURRENT"') == 3
    assert 'PYTHONPATH="$staging"' in installer
    assert "redstm-release-${release}-([0-9a-f]{32})" in installer
    assert "/home/ubuntu" not in installer
    assert "pm2" not in installer
    assert "nginx" not in installer
    assert "EnvironmentFile=-/etc/redstm/access.env" in service
    assert "Environment=RCLONE_CONFIG=/etc/redstm/rclone.conf" in service
    assert "Environment=RCLONE_CONFIG=/etc/redstm/rclone.conf" in schedule_service
    assert "ProtectSystem=strict" in service
    assert "TimeoutStartSec=5h" in service
    assert "TimeoutStartSec=7h" in schedule_service
    assert "RuntimeMaxSec" not in service
    assert "Persistent=true" in timer
    assert "--scheduled" in schedule_service
    assert "ConditionPathExists" not in schedule_service
    assert "00,06,12,18:17:00 UTC" in schedule_timer
    assert "Persistent=true" in schedule_timer
    assert "redstm-schedule.timer" in installer
    assert "systemctl disable --now redstm-schedule.timer" in installer
    assert "/etc/systemd/journald.conf.d/redstm.conf" in installer
    assert "systemctl restart systemd-journald" not in installer
    assert "systemctl try-restart systemd-journald" not in installer
    assert "journalctl --vacuum" not in installer
    assert "rclone version" in installer
    assert "RCLONE_MIN_VERSION=1.74.3" in installer
    assert "install_rclone" in installer
    assert "rclone-v${RCLONE_MIN_VERSION}-linux-${architecture}.deb" in installer
    assert 'temporary="$(mktemp -d /tmp/redstm-rclone.XXXXXX)"' in installer
    assert 'chown root:root "$temporary"' in installer
    assert 'chmod 0700 "$temporary"' in installer
    assert "trap 'rm -rf -- \"$temporary\"' EXIT" in installer
    assert 'package="/tmp/rclone-' not in installer
    assert "rclone version is unsupported" in installer
    assert "/srv/redstm/snapshots" in installer
    assert "-m 0700 /srv/redstm/warc" in installer
    assert '"canonical_previous_count"' in installer
    assert '"releases_count"' in installer
    assert '"root_free_bytes"' in installer
    assert "status) release_status" in installer
    assert "redstm_install_not_started" in installer
    assert 'exec 8<>"$lock"' in installer
    assert installer.count("acquire_runner_lock") == 4
    assert "crawler or control runner is active" in installer
    assert "current-release.complete" in installer
    assert "release_attempt_matches" in installer
    assert "rollback requires expected current, target release, and attempt" in installer
    assert "find /tmp" not in installer
    assert "validate_archive_for_release" in installer
    assert "from crawler.archive import MIGRATIONS, SCHEMA_VERSION" in installer
    assert 'target_schema_version=target_payload["schema_version"]' in installer
    assert 'PYTHONPATH="$source_release"' in installer
    assert 'target_environment["PYTHONPATH"] = str(target_release)' in installer
    assert "if extra_versions or mismatched or user_version > supported_max" not in installer
    rollback_body = installer.split("rollback_release() {", 1)[1].split('mode="${1:-}"', 1)[0]
    assert rollback_body.index("validate_archive_for_release") < rollback_body.index(
        'ln -sfn -- "$target" "${CURRENT}.new"'
    )
    assert "canonical-transfer-size" in installer
    assert "truncate-canonical-transfer" in installer
    assert "append-canonical-chunk" in installer
    assert "CANONICAL_CHUNK=" not in installer
    assert "append-canonical-chunk requires path, offset, bytes, and hash" in installer
    assert "^/tmp/redstm-canonical-[0-9a-f]{32}\\.chunk\\.partial$" in installer
    assert '[[ -f "$chunk" && ! -L "$chunk" ]]' in installer
    assert '[[ -f "$CANONICAL_TARGET" && ! -L "$CANONICAL_TARGET" ]]' in installer
    assert 'ln -- "$CANONICAL_TARGET" "$previous_snapshot"' in installer
    assert 'mv -Tf -- "$CANONICAL_STAGING" "$CANONICAL_TARGET"' in installer
    assert 'sync -d "$CANONICAL_STAGING"' in installer
    assert 'sync -f "$canonical_dir"' in installer
    assert 'mv -- "$CANONICAL_TARGET" "$previous_snapshot"' not in installer
    append_body = installer.split("append_canonical_chunk() {", 1)[1].split(
        "activate_canonical() {", 1
    )[0]
    assert append_body.index("invalid canonical chunk path") < append_body.index('-f "$chunk"')
    install_body = installer.split("install_release() {", 1)[1].split(
        "canonical_transfer_size() {", 1
    )[0]
    lock_index = install_body.index("  acquire_runner_lock\n")
    mutation_index = install_body.index("  INSTALL_MUTATED=1\n")
    assert lock_index < mutation_index
    assert installer.count("INSTALL_ACTIVE == 1 && INSTALL_MUTATED == 0") == 2
    for mutation in (
        "useradd --system",
        'install -o root -g root -m 0755 "$0" /opt/redstm/install_release.sh',
        "  install_uv\n",
        "  install_rclone\n",
        'install -d -o redstm -g redstm -m 0750 "$staging"',
    ):
        assert mutation_index < install_body.index(mutation)
    assert "CURRENT_MUTATED" not in installer
    assert "IOSchedulingClass=idle" in service
    assert "IOSchedulingClass=idle" in schedule_service
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    assert (
        f"ghcr.io/astral-sh/uv:{installer.split('UV_VERSION=', 1)[1].splitlines()[0]}" in dockerfile
    )
    assert "REDSTM_DATA_DIR" not in dockerfile
