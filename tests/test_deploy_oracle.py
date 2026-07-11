from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from scripts.deploy_oracle import OracleTarget, activate_canonical, deploy_release, preflight


def _target(tmp_path: Path) -> OracleTarget:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    return OracleTarget("oracle.example", "ubuntu", key)


def test_target_rejects_shell_metacharacters(tmp_path: Path) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    with pytest.raises(ValueError, match="host"):
        OracleTarget("host;shutdown", "ubuntu", key)
    with pytest.raises(ValueError, match="user"):
        OracleTarget("host.example", "ubuntu root", key)


def test_deploy_uses_fixed_partial_and_installer_paths(tmp_path: Path) -> None:
    target = _target(tmp_path)
    archive = tmp_path / "release.tar.gz"
    installer = tmp_path / "install_release.sh"
    archive.write_bytes(b"archive")
    installer.write_text("#!/bin/sh\n", encoding="utf-8")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    release = "a" * 40
    deploy_release(target, release, archive, "b" * 64, installer, runner=run)

    assert len(commands) == 3
    assert commands[0][-1].endswith(f":/tmp/redstm-release-{release}.tar.gz.partial")
    assert commands[1][-1].endswith(":/tmp/redstm-install-release.sh")
    assert commands[2][-7:] == [
        "sudo",
        "bash",
        "/tmp/redstm-install-release.sh",
        "install",
        release,
        f"/tmp/redstm-release-{release}.tar.gz.partial",
        "b" * 64,
    ]
    assert "enable" not in commands[2]


def test_preflight_requires_clean_tree_and_all_quality_gates(tmp_path: Path) -> None:
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        stdout = "c" * 40 + "\n" if command[:2] == ["git", "rev-parse"] else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    assert preflight(tmp_path, runner=run) == "c" * 40
    assert ["uv", "lock", "--check"] in commands
    assert ["uv", "run", "pytest", "-q"] in commands
    assert ["uv", "run", "ruff", "format", "--check", "."] in commands
    assert ["uv", "run", "mypy", "crawler", "scripts", "tests"] in commands


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
    assert (
        sum(command[-1].endswith(":/tmp/redstm-canonical.chunk.partial") for command in commands)
        == 2
    )
    assert commands[-1][-3:] == ["activate-canonical", "10", report["sha256"]]


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


def test_install_assets_never_enable_or_touch_legacy() -> None:
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

    assert "systemctl enable" not in installer
    assert '"uv ${UV_VERSION}" ||' in installer
    assert installer.count("UV_NO_CONFIG=1") == 2
    assert installer.count('PYTHONPATH="$CURRENT"') == 3
    assert 'PYTHONPATH="$staging"' in installer
    assert "redstm-release-[0-9a-f]{40}" in installer
    assert "/home/ubuntu" not in installer
    assert "pm2" not in installer
    assert "nginx" not in installer
    assert "EnvironmentFile=/etc/redstm/access.env" in service
    assert "Environment=RCLONE_CONFIG=/etc/redstm/rclone.conf" in service
    assert "Environment=RCLONE_CONFIG=/etc/redstm/rclone.conf" in schedule_service
    assert "ProtectSystem=strict" in service
    assert "TimeoutStartSec=4h" in service
    assert "RuntimeMaxSec" not in service
    assert "Persistent=true" in timer
    assert "--scheduled" in schedule_service
    assert "ConditionPathExists=/srv/redstm/canonical/archive.sqlite" in schedule_service
    assert "00,06,12,18:17:00 UTC" in schedule_timer
    assert "Persistent=true" in schedule_timer
    assert "redstm-schedule.timer" in installer
    assert "systemctl disable --now redstm-schedule.timer" in installer
    assert "canonical-transfer-size" in installer
    assert "truncate-canonical-transfer" in installer
    assert "append-canonical-chunk" in installer
