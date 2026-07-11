from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts.publish_static import (
    _r2_budget_preflight,
    activate_remote_release,
    publish_static,
)


def _release(root: Path) -> tuple[str, bytes]:
    body = b'{"schema_version":1}\n'
    key = f"releases/{hashlib.sha256(body).hexdigest()}.json"
    (root / "releases").mkdir(parents=True)
    (root / key).write_bytes(body)
    (root / "release.json").write_bytes(body)
    return key, body


def test_publish_validates_objects_before_writing_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=body if command[1] == "cat" else b"")

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: {"projected_remote_bytes": 100},
    )
    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["copy", "check", "copyto", "cat"]
    assert commands[0][commands[0].index("--exclude") + 1] == "/release.json"
    assert commands[2][3] == "r2:redstm-archive/release.json"
    assert report["pointer_verified"] is True


def test_failed_remote_check_never_writes_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, _ = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "check":
            raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(stdout=b"")

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: {"projected_remote_bytes": 100},
    )
    with pytest.raises(subprocess.CalledProcessError):
        publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["copy", "check"]


def test_activate_existing_release_only_writes_pointer(tmp_path: Path) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=body if command[1] == "cat" else b"")

    report = activate_remote_release(
        tmp_path,
        "r2:redstm-archive",
        release_key,
        runner=run,
    )

    assert [command[1] for command in commands] == ["cat", "copyto", "cat"]
    assert commands[0][2] == f"r2:redstm-archive/{release_key}"
    assert commands[1][2] == f"r2:redstm-archive/{release_key}"
    assert commands[1][3] == "r2:redstm-archive/release.json"
    assert report["mode"] == "activate"
    assert report["pointer_verified"] is True


def test_activate_rejects_unknown_remote_release(tmp_path: Path) -> None:
    release_key, _ = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=b"wrong release")

    with pytest.raises(RuntimeError, match="versioned release verification"):
        activate_remote_release(
            tmp_path,
            "r2:redstm-archive",
            release_key,
            runner=run,
        )

    assert [command[1] for command in commands] == ["cat"]


def test_budget_preflight_blocks_before_free_tier_margin(tmp_path: Path) -> None:
    (tmp_path / "new.bin").write_bytes(b"x" * 200)

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "size":
            return SimpleNamespace(stdout=b'{"count":799999,"bytes":7999999900}')
        missing = Path(command[command.index("--missing-on-dst") + 1])
        missing.write_text("new.bin\n", encoding="utf-8")
        return SimpleNamespace(stdout=b"")

    with pytest.raises(RuntimeError, match="free-tier safety limit exceeded"):
        _r2_budget_preflight(
            tmp_path,
            "r2:redstm-archive",
            pointer_bytes=100,
            runner=run,
        )
