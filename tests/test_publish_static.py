from __future__ import annotations

import hashlib
import json
import subprocess
from compression import zstd
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
    (root / "releases").mkdir(parents=True, exist_ok=True)
    (root / key).write_bytes(body)
    (root / "release.json").write_bytes(body)
    return key, body


def _graph_release(root: Path, marker: str) -> tuple[str, bytes, set[str]]:
    post_key = f"posts/write/1-{marker * 64}.json.zst"
    (root / post_key).parent.mkdir(parents=True, exist_ok=True)
    (root / post_key).write_bytes(marker.encode())
    board_payload = json.dumps(
        {"schema_version": 1, "board_id": "write", "posts": [{"object_key": post_key}]},
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    board_body = zstd.compress(board_payload, level=15)
    board_payload_sha = hashlib.sha256(board_payload).hexdigest()
    board_key = f"boards/write/manifest-{board_payload_sha}.json.zst"
    (root / board_key).parent.mkdir(parents=True, exist_ok=True)
    (root / board_key).write_bytes(board_body)
    board_ref = {
        "object_key": board_key,
        "payload_sha256": board_payload_sha,
        "object_sha256": hashlib.sha256(board_body).hexdigest(),
        "object_bytes": len(board_body),
    }
    body = (
        json.dumps({"schema_version": 1, "boards": [board_ref]}, sort_keys=True) + "\n"
    ).encode()
    key = f"releases/{hashlib.sha256(body).hexdigest()}.json"
    (root / "releases").mkdir(parents=True, exist_ok=True)
    (root / key).write_bytes(body)
    (root / "release.json").write_bytes(body)
    return key, body, {key, board_key, post_key}


def test_publish_validates_objects_before_writing_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        pointer_checks = sum(item[1] == "cat" for item in commands)
        return SimpleNamespace(
            stdout=body if command[1] == "cat" and pointer_checks == 2 else b"previous"
        )

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: {
            "projected_remote_bytes": 100,
            "projected_remote_objects": 10,
        },
    )
    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat", "copy", "check", "copyto", "cat"]
    assert commands[1][commands[1].index("--exclude") + 1] == "/release.json"
    assert commands[3][3] == "r2:redstm-archive/release.json"
    assert report["pointer_verified"] is True
    assert report["ledger_written"] is True
    assert report["mode"] == "publish"


def test_publish_is_noop_when_remote_pointer_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(
            stdout=json.dumps({"bytes": 1000, "count": 10}).encode()
            if command[1] == "size"
            else body
        )

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )
    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat", "size"]
    assert report["mode"] == "noop"
    assert report["pointer_verified"] is True
    assert report["ledger_written"] is True
    assert report["new_bytes"] == report["new_objects"] == 0
    assert json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))[
        "release_key"
    ] == release_key


def test_publish_noop_reuses_matching_ledger_without_remote_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=body)

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )

    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat"]
    assert report["mode"] == "noop"
    assert report["ledger_written"] is True


def test_publish_uses_verified_local_delta_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, previous_keys = _graph_release(tmp_path, "a")
    release_key, release_body, release_keys = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    commands: list[list[str]] = []
    copied: list[str] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "copy" and "--files-from" in command:
            files = Path(command[command.index("--files-from") + 1])
            copied.extend(files.read_text(encoding="utf-8").splitlines())
        pointer_checks = sum(item[1] == "cat" for item in commands)
        return SimpleNamespace(
            stdout=release_body if command[1] == "cat" and pointer_checks == 2 else previous_body
        )

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: pytest.fail("verified delta must not full-scan R2"),
    )

    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat", "copy", "check", "copyto", "cat"]
    assert set(copied) == release_keys - previous_keys
    assert report["mode"] == "delta"
    assert report["ledger_written"] is True
    assert report["new_objects"] == 3


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
        lambda *args, **kwargs: {
            "projected_remote_bytes": 100,
            "projected_remote_objects": 10,
        },
    )
    with pytest.raises(subprocess.CalledProcessError):
        publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat", "copy", "check"]


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


@pytest.mark.parametrize(
    ("remote_bytes", "remote_objects", "blocked"),
    [
        (19_999_999_999, 0, False),
        (20_000_000_000, 0, True),
        (0, 799_999, False),
        (0, 800_000, True),
    ],
    ids=["bytes-at-limit", "bytes-over-limit", "objects-at-limit", "objects-over-limit"],
)
def test_budget_preflight_enforces_byte_and_object_boundaries(
    tmp_path: Path, remote_bytes: int, remote_objects: int, blocked: bool
) -> None:
    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "size":
            body = f'{{"count":{remote_objects},"bytes":{remote_bytes}}}'.encode()
            return SimpleNamespace(stdout=body)
        return SimpleNamespace(stdout=b"")

    def preflight() -> dict[str, int]:
        return _r2_budget_preflight(
            tmp_path,
            "r2:redstm-archive",
            pointer_bytes=1,
            runner=run,
        )

    if blocked:
        with pytest.raises(RuntimeError, match="publishing budget limit exceeded"):
            preflight()
    else:
        preflight()
