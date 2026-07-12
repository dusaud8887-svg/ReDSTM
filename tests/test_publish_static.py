from __future__ import annotations

import hashlib
import json
import subprocess
from compression import zstd
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from filelock import FileLock

import scripts.publish_static as publish_static_module
from scripts.export_static import IncrementalExportError
from scripts.publish_static import (
    _r2_budget_preflight,
    _read_ledger,
    activate_remote_release,
    publish_static,
    reconcile_pending_smoke,
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
    post_body = marker.encode()
    (root / post_key).write_bytes(post_body)
    board_payload = json.dumps(
        {
            "schema_version": 1,
            "board_id": "write",
            "posts": [
                {
                    "object_key": post_key,
                    "object_bytes": len(post_body),
                    "object_sha256": hashlib.sha256(post_body).hexdigest(),
                }
            ],
        },
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
            stdout=body if command[1] == "cat" and pointer_checks == 3 else b"previous"
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

    assert [command[1] for command in commands] == [
        "cat",
        "copy",
        "check",
        "cat",
        "copyto",
        "cat",
    ]
    assert commands[1][commands[1].index("--exclude") + 1] == "/release.json"
    assert "*.partial" in commands[1] and "**/*.partial" in commands[1]
    assert commands[4][3] == "r2:redstm-archive/release.json"
    assert report["pointer_verified"] is True
    assert report["ledger_written"] is True
    assert report["mode"] == "publish"
    assert report["activation_pending_smoke"] is True
    assert report["previous_release_key"] is None
    assert report["previous_release_verified"] is False
    smoke_marker = json.loads(
        (tmp_path / ".publish-smoke.pending.json").read_text(encoding="utf-8")
    )
    assert smoke_marker["release_key"] == release_key
    assert smoke_marker["previous_release_key"] is None


def test_publish_refuses_a_second_local_writer(tmp_path: Path) -> None:
    _release(tmp_path)
    lock = FileLock(str(tmp_path / ".publish.lock"), timeout=0)

    with lock, pytest.raises(RuntimeError, match="another static publish"):
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            runner=lambda *_args, **_kwargs: pytest.fail("busy writer must not contact R2"),
        )


def test_verified_incremental_publish_uses_only_the_bounded_validator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    calls: list[str] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        calls.append(command[1])
        return SimpleNamespace(
            stdout=json.dumps({"bytes": 100, "count": 2}).encode() if command[1] == "size" else body
        )

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda *args: pytest.fail("automatic incremental publish must not deep-scan posts"),
    )
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": None,
                "remote_bytes": 100,
                "remote_objects": 2,
            }
        ),
        encoding="utf-8",
    )

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=run,
    )

    assert calls == ["cat"]
    assert report["mode"] == "noop"


def test_verified_incremental_noop_requires_an_active_publish_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=lambda *_args, **_kwargs: SimpleNamespace(stdout=body),
        )

    assert failure.value.code == "incremental_publish_bootstrap_required"


def test_verified_incremental_publish_never_falls_back_to_deep_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _release(tmp_path)
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda *args: (_ for _ in ()).throw(ValueError("invalid export state")),
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda *args: pytest.fail("invalid bounded state must fail closed"),
    )

    with pytest.raises(ValueError, match="invalid export state"):
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=lambda *args, **kwargs: pytest.fail("R2 must not be contacted"),
        )


def test_verified_incremental_publish_requires_a_predecessor_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, _body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=b"untracked previous pointer")

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: pytest.fail("automatic publish must not full-scan R2"),
    )

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=run,
        )

    assert failure.value.code == "incremental_publish_predecessor_unavailable"
    assert [command[1] for command in commands] == ["cat"]


def test_verified_incremental_publish_requires_a_remote_versioned_predecessor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, _release_body, _ = _graph_release(tmp_path, "b")
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "cat":
            raise subprocess.CalledProcessError(4, command)
        pytest.fail(f"unverified predecessor must block before R2 mutation: {command}")

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=run,
        )

    assert failure.value.code == "incremental_publish_predecessor_unavailable"
    assert [command[1] for command in commands] == ["cat", "cat"]


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
    assert (
        json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))["release_key"]
        == release_key
    )


def test_publish_noop_reuses_matching_ledger_without_remote_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, body = _release(tmp_path)
    previous = f"releases/{'b' * 64}.json"
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": previous,
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
    assert report["previous_release_key"] == previous
    assert report["previous_release_verified"] is True


def test_publish_noop_discards_a_smoke_marker_for_an_inactive_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, _previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 900,
                "remote_objects": 8,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=lambda *_args, **_kwargs: SimpleNamespace(stdout=release_body),
    )

    assert report["mode"] == "noop"
    assert report["activation_pending_smoke"] is False
    assert not smoke_pending.exists()


def test_verified_publish_preserves_and_rejects_a_corrupt_smoke_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, release_body = _release(tmp_path)
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_bytes(b"\xff")
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=lambda *_args, **_kwargs: SimpleNamespace(stdout=release_body),
        )

    assert failure.value.code == "incremental_publish_smoke_marker_invalid"
    assert smoke_pending.is_file()


def test_publish_ledger_is_fsynced_before_atomic_activation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(publish_static_module.os, "fsync", calls.append)

    publish_static_module._write_ledger(
        tmp_path,
        "r2:redstm-archive",
        f"releases/{'a' * 64}.json",
        {"projected_remote_bytes": 1000, "projected_remote_objects": 10},
    )

    assert calls
    assert (
        json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))["release_key"]
        == f"releases/{'a' * 64}.json"
    )


def test_publish_defers_a_new_pointer_until_the_active_release_is_smoked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    active_key, active_body, _ = _graph_release(tmp_path, "a")
    desired_key, _desired_body, _ = _graph_release(tmp_path, "b")
    active_state = {
        "schema_version": 1,
        "remote": "r2:redstm-archive",
        "release_key": active_key,
        "previous_release_key": None,
        "remote_bytes": 1000,
        "remote_objects": 10,
    }
    (tmp_path / ".publish-ledger.json").write_text(json.dumps(active_state), encoding="utf-8")
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(json.dumps(active_state), encoding="utf-8")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=active_body)

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": desired_key, "post_count": 1},
    )

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=run,
    )

    assert [command[1] for command in commands] == ["cat"]
    assert report["mode"] == "noop"
    assert report["release_key"] == active_key
    assert report["deferred_release_key"] == desired_key
    assert report["activation_pending_smoke"] is True
    assert json.loads(smoke_pending.read_text(encoding="utf-8"))["release_key"] == active_key


def test_reconcile_pending_smoke_recovers_the_active_release_without_export(
    tmp_path: Path,
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    attempted_key, attempted_body, _ = _graph_release(tmp_path, "b")
    pending_state = {
        "schema_version": 1,
        "remote": "r2:redstm-archive",
        "release_key": attempted_key,
        "previous_release_key": previous_key,
        "remote_bytes": 1500,
        "remote_objects": 13,
    }
    (tmp_path / ".publish-ledger.pending.json").write_text(
        json.dumps(pending_state), encoding="utf-8"
    )
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(json.dumps(pending_state), encoding="utf-8")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            return SimpleNamespace(stdout=attempted_body)
        if command[1] == "cat" and command[2].endswith(previous_key):
            return SimpleNamespace(stdout=previous_body)
        pytest.fail(f"unexpected recovery command: {command}")

    report = reconcile_pending_smoke(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == ["cat", "cat"]
    assert report["release_key"] == attempted_key
    assert report["smoke_marker_release_key"] == attempted_key
    assert report["rollback_already_active"] is False
    assert report["previous_release_key"] == previous_key
    assert report["previous_release_verified"] is True
    assert report["ledger_recovered"] is True
    assert smoke_pending.is_file()
    assert not (tmp_path / ".publish-ledger.pending.json").exists()


def test_reconcile_pending_smoke_detects_an_interrupted_rollback(
    tmp_path: Path,
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    attempted_key, _attempted_body, _ = _graph_release(tmp_path, "b")
    pending_state = {
        "schema_version": 1,
        "remote": "r2:redstm-archive",
        "release_key": attempted_key,
        "previous_release_key": previous_key,
        "remote_bytes": 1500,
        "remote_objects": 13,
    }
    (tmp_path / ".publish-ledger.json").write_text(json.dumps(pending_state), encoding="utf-8")
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(json.dumps(pending_state), encoding="utf-8")

    report = reconcile_pending_smoke(
        tmp_path,
        "r2:redstm-archive",
        runner=lambda *_args, **_kwargs: SimpleNamespace(stdout=previous_body),
    )

    assert report["release_key"] == previous_key
    assert report["smoke_marker_release_key"] == attempted_key
    assert report["rollback_already_active"] is True
    assert report["previous_release_key"] is None
    durable = json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))
    assert durable["release_key"] == previous_key
    assert durable["previous_release_key"] == attempted_key
    assert smoke_pending.is_file()


def test_reconcile_discards_an_initial_release_that_never_wrote_a_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, release_body = _release(tmp_path)
    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 0},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: {
            "projected_remote_bytes": 1000,
            "projected_remote_objects": 10,
        },
    )

    def fail_pointer(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "cat":
            raise subprocess.CalledProcessError(4, command)
        if command[1] == "copyto":
            raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(stdout=b"")

    with pytest.raises(subprocess.CalledProcessError):
        publish_static(tmp_path, "r2:redstm-archive", runner=fail_pointer)

    pending_ledger = tmp_path / ".publish-ledger.pending.json"
    pending_smoke = tmp_path / ".publish-smoke.pending.json"
    assert pending_ledger.is_file()
    assert pending_smoke.is_file()

    reconciled = reconcile_pending_smoke(
        tmp_path,
        "r2:redstm-archive",
        runner=lambda command, **_kwargs: (_ for _ in ()).throw(
            subprocess.CalledProcessError(4, command)
        ),
    )

    assert reconciled["pending_smoke"] is False
    assert reconciled["discarded_unactivated_release"] == release_key
    assert not pending_ledger.exists()
    assert not pending_smoke.exists()

    pointer_reads = 0

    def retry(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        if command[1] == "cat":
            pointer_reads += 1
            if pointer_reads < 3:
                raise subprocess.CalledProcessError(4, command)
            return SimpleNamespace(stdout=release_body)
        return SimpleNamespace(stdout=b"")

    report = publish_static(tmp_path, "r2:redstm-archive", runner=retry)

    assert report["mode"] == "publish"
    assert report["pointer_verified"] is True
    assert report["activation_pending_smoke"] is True


def test_initial_unactivated_cleanup_converges_after_one_unlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, _release_body = _release(tmp_path)
    pending_state = {
        "schema_version": 1,
        "remote": "r2:redstm-archive",
        "release_key": release_key,
        "previous_release_key": None,
        "remote_bytes": 1000,
        "remote_objects": 10,
    }
    pending_ledger = tmp_path / ".publish-ledger.pending.json"
    pending_smoke = tmp_path / ".publish-smoke.pending.json"
    pending_ledger.write_text(json.dumps(pending_state), encoding="utf-8")
    pending_smoke.write_text(json.dumps(pending_state), encoding="utf-8")
    original_unlink = Path.unlink
    interrupted = False

    def interrupt_after_ledger(path: Path, *args: Any, **kwargs: Any) -> None:
        nonlocal interrupted
        if path == pending_smoke and not interrupted:
            interrupted = True
            raise OSError("simulated cleanup interruption")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", interrupt_after_ledger)

    def missing_pointer(command: list[str], **_kwargs: object) -> SimpleNamespace:
        raise subprocess.CalledProcessError(4, command)

    with pytest.raises(OSError, match="cleanup interruption"):
        reconcile_pending_smoke(
            tmp_path,
            "r2:redstm-archive",
            runner=missing_pointer,
        )

    assert not pending_ledger.exists()
    assert pending_smoke.is_file()

    monkeypatch.setattr(Path, "unlink", original_unlink)
    report = reconcile_pending_smoke(
        tmp_path,
        "r2:redstm-archive",
        runner=missing_pointer,
    )

    assert report["pending_smoke"] is False
    assert not pending_smoke.exists()


def test_pending_only_initial_publish_state_is_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, _release_body = _release(tmp_path)
    pending_ledger = tmp_path / ".publish-ledger.pending.json"
    pending_ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 0},
    )
    commands: list[list[str]] = []

    def missing_pointer(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        raise subprocess.CalledProcessError(4, command)

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=missing_pointer,
        )

    assert failure.value.code == "incremental_publish_bootstrap_required"
    assert [command[1] for command in commands] == ["cat"]
    assert not pending_ledger.exists()


def test_publish_noop_recovers_ledger_after_pointer_activation_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, _previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    pending = tmp_path / ".publish-ledger.pending.json"
    pending_state = {
        "schema_version": 1,
        "remote": "r2:redstm-archive",
        "release_key": release_key,
        "previous_release_key": previous_key,
        "remote_bytes": 1500,
        "remote_objects": 13,
    }
    pending.write_text(json.dumps(pending_state), encoding="utf-8")
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(json.dumps(pending_state), encoding="utf-8")
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=release_body)

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=run,
    )

    assert [command[1] for command in commands] == ["cat"]
    assert report["mode"] == "noop"
    assert report["ledger_recovered"] is True
    assert report["activation_pending_smoke"] is True
    assert report["previous_release_key"] == previous_key
    assert not pending.exists()
    assert smoke_pending.is_file()
    durable = json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))
    assert durable["release_key"] == release_key
    assert durable["previous_release_key"] == previous_key
    assert durable["remote_bytes"] == 1500
    assert durable["remote_objects"] == 13


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
    pointer_reads = 0
    missing_key = min(release_keys - previous_keys)

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        commands.append(command)
        if command[1] == "copy" and "--files-from" in command:
            files = Path(command[command.index("--files-from") + 1])
            copied.extend(files.read_text(encoding="utf-8").splitlines())
            if "--missing-on-dst" in command:
                missing = Path(command[command.index("--missing-on-dst") + 1])
                missing.write_text(missing_key + "\n", encoding="utf-8")
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=previous_body if pointer_reads < 3 else release_body)
        return SimpleNamespace(stdout=previous_body)

    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: pytest.fail("verified delta must not full-scan R2"),
    )

    report = publish_static(tmp_path, "r2:redstm-archive", runner=run)

    assert [command[1] for command in commands] == [
        "cat",
        "cat",
        "copy",
        "copy",
        "check",
        "cat",
        "copyto",
        "cat",
    ]
    assert commands[1][2] == f"r2:redstm-archive/{previous_key}"
    assert commands[-2][3] == "r2:redstm-archive/release.json"
    assert set(copied) == release_keys - previous_keys
    assert report["mode"] == "delta"
    assert report["activation_pending_smoke"] is True
    assert report["ledger_written"] is True
    assert report["new_objects"] == 1
    assert report["new_bytes"] == (tmp_path / missing_key).stat().st_size
    assert report["previous_release_key"] == previous_key
    assert report["previous_release_verified"] is True
    durable = json.loads(ledger.read_text(encoding="utf-8"))
    assert durable["release_key"] == release_key
    assert durable["previous_release_key"] == previous_key
    assert not (tmp_path / ".publish-ledger.pending.json").exists()
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    assert json.loads(smoke_pending.read_text(encoding="utf-8"))["release_key"] == release_key

    commands.clear()

    def retry(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=release_body)

    retried = publish_static(tmp_path, "r2:redstm-archive", runner=retry)
    assert [command[1] for command in commands] == ["cat"]
    assert retried["mode"] == "noop"
    assert retried["ledger_recovered"] is False
    assert retried["activation_pending_smoke"] is True
    assert retried["previous_release_key"] == previous_key
    assert retried["previous_release_verified"] is True
    assert not (tmp_path / ".publish-ledger.pending.json").exists()
    assert smoke_pending.is_file()


def test_failed_pointer_copy_preserves_the_active_ledger_for_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    def fail_copy(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "cat" and command[2].endswith("/release.json"):
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "copyto":
            raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(stdout=b"")

    with pytest.raises(subprocess.CalledProcessError):
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=fail_copy,
        )

    assert json.loads(ledger.read_text(encoding="utf-8"))["release_key"] == previous_key
    pending = tmp_path / ".publish-ledger.pending.json"
    assert json.loads(pending.read_text(encoding="utf-8"))["release_key"] == release_key
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    assert json.loads(smoke_pending.read_text(encoding="utf-8"))["release_key"] == release_key

    pointer_reads = 0

    def retry(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=previous_body if pointer_reads < 3 else release_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        return SimpleNamespace(stdout=b"")

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=retry,
    )
    assert report["mode"] == "delta"
    assert report["activation_pending_smoke"] is True
    assert json.loads(ledger.read_text(encoding="utf-8"))["release_key"] == release_key
    assert not pending.exists()
    assert smoke_pending.is_file()


def test_pointer_success_with_interrupted_ledger_commit_is_recoverable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )
    original_write_ledger = publish_static_module._write_ledger

    def interrupt_final_ledger(*args: Any, **kwargs: Any) -> None:
        if kwargs.get("path") is None and args[2] == release_key:
            raise OSError("simulated ledger interruption")
        original_write_ledger(*args, **kwargs)

    monkeypatch.setattr(publish_static_module, "_write_ledger", interrupt_final_ledger)
    pointer_reads = 0

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=previous_body if pointer_reads < 3 else release_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        return SimpleNamespace(stdout=b"")

    interrupted = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=run,
    )
    assert interrupted["pointer_verified"] is True
    assert interrupted["ledger_written"] is False
    assert json.loads(ledger.read_text(encoding="utf-8"))["release_key"] == previous_key
    assert (tmp_path / ".publish-ledger.pending.json").is_file()
    assert (tmp_path / ".publish-smoke.pending.json").is_file()

    monkeypatch.setattr(publish_static_module, "_write_ledger", original_write_ledger)
    commands: list[list[str]] = []

    def recover(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout=release_body)

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=recover,
    )
    assert [command[1] for command in commands] == ["cat"]
    assert report["mode"] == "noop"
    assert report["ledger_recovered"] is True
    assert report["activation_pending_smoke"] is True
    assert json.loads(ledger.read_text(encoding="utf-8"))["release_key"] == release_key


def test_pending_ledger_survives_a_transient_pointer_read_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, release_body = _release(tmp_path)
    pending = tmp_path / ".publish-ledger.pending.json"
    pending.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )

    def unavailable(command: list[str], **_kwargs: object) -> SimpleNamespace:
        raise subprocess.CalledProcessError(1, command)

    with pytest.raises(IncrementalExportError) as failure:
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=unavailable,
        )

    assert failure.value.code == "incremental_publish_pointer_unavailable"
    assert pending.is_file()

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=lambda *_args, **_kwargs: SimpleNamespace(stdout=release_body),
    )

    assert report["mode"] == "noop"
    assert report["ledger_recovered"] is True
    assert not pending.exists()


def test_full_publish_also_stops_when_a_pending_pointer_cannot_be_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release_key, _release_body = _release(tmp_path)
    pending = tmp_path / ".publish-ledger.pending.json"
    pending_body = json.dumps(
        {
            "schema_version": 1,
            "remote": "r2:redstm-archive",
            "release_key": release_key,
            "previous_release_key": f"releases/{'b' * 64}.json",
            "remote_bytes": 1000,
            "remote_objects": 10,
        }
    )
    pending.write_text(pending_body, encoding="utf-8")
    monkeypatch.setattr(
        "scripts.publish_static.validate_release",
        lambda root, release: {"release_key": release_key, "post_count": 2},
    )

    def unavailable(command: list[str], **_kwargs: object) -> SimpleNamespace:
        raise subprocess.CalledProcessError(1, command)

    with pytest.raises(RuntimeError, match="pending publish ledger was preserved"):
        publish_static(tmp_path, "r2:redstm-archive", runner=unavailable)

    assert pending.read_text(encoding="utf-8") == pending_body


def test_delta_publish_rejects_a_corrupt_new_post_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    post = next((tmp_path / "posts" / "write").glob("1-b*.json.zst"))
    corrupted = bytearray(post.read_bytes())
    corrupted[0] ^= 1
    post.write_bytes(corrupted)

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "cat" and command[2].endswith("/release.json"):
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        pytest.fail(f"R2 mutation must not run after local corruption: {command}")

    with pytest.raises(ValueError, match="post object hash mismatch"):
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=run,
        )

    assert (tmp_path / "release.json").read_bytes() == release_body


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


def test_publish_refuses_to_overwrite_a_concurrently_changed_pointer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, _release_body, _ = _graph_release(tmp_path, "b")
    (tmp_path / ".publish-ledger.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    pointer_reads = 0
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=previous_body if pointer_reads == 1 else b"external")
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "copyto":
            pytest.fail("changed pointer must not be overwritten")
        return SimpleNamespace(stdout=b"")

    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )

    with pytest.raises(RuntimeError, match="pointer changed during publish"):
        publish_static(
            tmp_path,
            "r2:redstm-archive",
            verified_incremental=True,
            runner=run,
        )

    assert "copyto" not in [command[1] for command in commands]
    assert not (tmp_path / ".publish-ledger.pending.json").exists()


def test_activate_existing_release_only_writes_pointer(tmp_path: Path) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "size":
            return SimpleNamespace(stdout=b'{"count":12,"bytes":120}')
        return SimpleNamespace(stdout=body if command[1] == "cat" else b"")

    report = activate_remote_release(
        tmp_path,
        "r2:redstm-archive",
        release_key,
        runner=run,
    )

    assert [command[1] for command in commands] == [
        "cat",
        "cat",
        "cat",
        "copyto",
        "cat",
        "size",
    ]
    assert commands[0][2] == f"r2:redstm-archive/{release_key}"
    assert commands[3][2] == f"r2:redstm-archive/{release_key}"
    assert commands[3][3] == "r2:redstm-archive/release.json"
    assert report["mode"] == "activate"
    assert report["pointer_verified"] is True
    assert report["ledger_written"] is True
    ledger = json.loads((tmp_path / ".publish-ledger.json").read_text(encoding="utf-8"))
    assert ledger == {
        "previous_release_key": None,
        "release_key": release_key,
        "remote": "r2:redstm-archive",
        "remote_bytes": 120,
        "remote_objects": 12,
        "schema_version": 1,
    }
    assert _read_ledger(tmp_path, "r2:redstm-archive", release_key) == ledger


def test_activate_rollback_reuses_the_attempted_release_ledger(tmp_path: Path) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    attempted_key, attempted_body, _ = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": attempted_key,
                "previous_release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_bytes(ledger.read_bytes())
    commands: list[list[str]] = []
    pointer_reads = 0

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=attempted_body if pointer_reads < 3 else previous_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        return SimpleNamespace(stdout=b"")

    report = activate_remote_release(
        tmp_path,
        "r2:redstm-archive",
        previous_key,
        expected_current=attempted_key,
        runner=run,
    )

    assert [command[1] for command in commands] == ["cat", "cat", "cat", "copyto", "cat"]
    assert report["ledger_recovered"] is True
    durable = json.loads(ledger.read_text(encoding="utf-8"))
    assert durable["release_key"] == previous_key
    assert durable["previous_release_key"] == attempted_key
    assert durable["remote_bytes"] == 1000 + len(previous_body) - len(attempted_body)
    assert durable["remote_objects"] == 10
    assert not (tmp_path / ".publish-ledger.pending.json").exists()
    assert smoke_pending.is_file()


def test_activate_blocks_an_unrelated_transition_while_smoke_is_pending(
    tmp_path: Path,
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    attempted_key, attempted_body, _ = _graph_release(tmp_path, "b")
    smoke_pending = tmp_path / ".publish-smoke.pending.json"
    smoke_pending.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": attempted_key,
                "previous_release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            return SimpleNamespace(stdout=attempted_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "copyto":
            pytest.fail("pending smoke must block an unrelated activation")
        return SimpleNamespace(stdout=b"")

    with pytest.raises(RuntimeError, match="must be confirmed or rolled back"):
        activate_remote_release(
            tmp_path,
            "r2:redstm-archive",
            previous_key,
            runner=run,
        )

    assert "copyto" not in [command[1] for command in commands]
    assert smoke_pending.is_file()


def test_activate_rollback_uses_pending_attempt_and_survives_final_ledger_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    attempted_key, attempted_body, _ = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": previous_key,
                "previous_release_key": None,
                "remote_bytes": 900,
                "remote_objects": 7,
            }
        ),
        encoding="utf-8",
    )
    pending = tmp_path / ".publish-ledger.pending.json"
    pending.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": attempted_key,
                "previous_release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    original_write_ledger = publish_static_module._write_ledger

    def interrupt_final_ledger(*args: Any, **kwargs: Any) -> None:
        if kwargs.get("path") is None and args[2] == previous_key:
            raise OSError("simulated final ledger interruption")
        original_write_ledger(*args, **kwargs)

    monkeypatch.setattr(publish_static_module, "_write_ledger", interrupt_final_ledger)
    pointer_reads = 0

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=attempted_body if pointer_reads < 3 else previous_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        if command[1] == "size":
            pytest.fail("pending attempted ledger must avoid a full remote scan")
        return SimpleNamespace(stdout=b"")

    report = activate_remote_release(
        tmp_path,
        "r2:redstm-archive",
        previous_key,
        runner=run,
    )

    assert report["pointer_verified"] is True
    assert report["ledger_recovered"] is True
    assert report["ledger_written"] is False
    assert json.loads(ledger.read_text(encoding="utf-8"))["release_key"] == previous_key
    assert json.loads(pending.read_text(encoding="utf-8"))["release_key"] == previous_key


def test_publish_recovers_a_rolled_back_ledger_without_a_remote_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    previous_key, previous_body, _ = _graph_release(tmp_path, "a")
    release_key, release_body, _ = _graph_release(tmp_path, "b")
    ledger = tmp_path / ".publish-ledger.json"
    ledger.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "remote": "r2:redstm-archive",
                "release_key": release_key,
                "previous_release_key": previous_key,
                "remote_bytes": 1000,
                "remote_objects": 10,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "scripts.publish_static.validate_incremental_release",
        lambda root, release: {"release_key": release_key, "post_count": 1},
    )
    monkeypatch.setattr(
        "scripts.publish_static._r2_budget_preflight",
        lambda *args, **kwargs: pytest.fail("rollback recovery must stay bounded"),
    )
    commands: list[list[str]] = []
    pointer_reads = 0

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=previous_body if pointer_reads < 3 else release_body)
        if command[1] == "cat":
            return SimpleNamespace(stdout=previous_body)
        return SimpleNamespace(stdout=b"")

    report = publish_static(
        tmp_path,
        "r2:redstm-archive",
        verified_incremental=True,
        runner=run,
    )

    assert [command[1] for command in commands] == [
        "cat",
        "cat",
        "copy",
        "copy",
        "check",
        "cat",
        "copyto",
        "cat",
    ]
    assert report["mode"] == "delta"
    assert report["ledger_recovered"] is True
    assert report["new_bytes"] == report["new_objects"] == 0
    assert report["projected_remote_bytes"] == 1000
    durable = json.loads(ledger.read_text(encoding="utf-8"))
    assert durable["release_key"] == release_key
    assert durable["previous_release_key"] == previous_key


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


def test_activate_refuses_to_overwrite_a_concurrently_changed_pointer(tmp_path: Path) -> None:
    release_key, release_body = _release(tmp_path)
    pointer_reads = 0
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        nonlocal pointer_reads
        commands.append(command)
        if command[1] == "cat" and command[2].endswith("/release.json"):
            pointer_reads += 1
            return SimpleNamespace(stdout=b"current" if pointer_reads == 1 else b"external")
        if command[1] == "cat":
            return SimpleNamespace(stdout=release_body)
        if command[1] == "copyto":
            pytest.fail("changed pointer must not be overwritten")
        return SimpleNamespace(stdout=b"")

    with pytest.raises(RuntimeError, match="pointer changed during activation"):
        activate_remote_release(
            tmp_path,
            "r2:redstm-archive",
            release_key,
            runner=run,
        )

    assert [command[1] for command in commands] == ["cat", "cat", "cat"]


def test_activate_keeps_pointer_rollback_success_when_ledger_refresh_fails(
    tmp_path: Path,
) -> None:
    release_key, body = _release(tmp_path)
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        commands.append(command)
        if command[1] == "size":
            raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(stdout=body if command[1] == "cat" else b"")

    report = activate_remote_release(
        tmp_path,
        "r2:redstm-archive",
        release_key,
        runner=run,
    )

    assert [command[1] for command in commands] == [
        "cat",
        "cat",
        "cat",
        "copyto",
        "cat",
        "size",
    ]
    assert report["pointer_verified"] is True
    assert report["ledger_written"] is False
    assert not (tmp_path / ".publish-ledger.json").exists()


def test_full_budget_replaces_the_existing_pointer_and_deduplicates_missing_rows(
    tmp_path: Path,
) -> None:
    (tmp_path / "new.bin").write_bytes(b"12345")

    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "size":
            return SimpleNamespace(stdout=b'{"count":10,"bytes":1000}')
        if command[1] == "copy":
            missing = Path(command[command.index("--missing-on-dst") + 1])
            missing.write_text("new.bin\nnew.bin\n", encoding="utf-8")
            return SimpleNamespace(stdout=b"")
        pytest.fail(f"unexpected rclone command: {command}")

    report = _r2_budget_preflight(
        tmp_path,
        "r2:redstm-archive",
        pointer_bytes=20,
        previous_pointer_bytes=12,
        runner=run,
    )

    assert report["new_bytes"] == 5
    assert report["new_objects"] == 1
    assert report["projected_remote_bytes"] == 1013
    assert report["projected_remote_objects"] == 11


def test_full_budget_rejects_non_posix_missing_paths(tmp_path: Path) -> None:
    def run(command: list[str], **_kwargs: object) -> SimpleNamespace:
        if command[1] == "size":
            return SimpleNamespace(stdout=b'{"count":0,"bytes":0}')
        missing = Path(command[command.index("--missing-on-dst") + 1])
        missing.write_text("..\\outside\n", encoding="utf-8")
        return SimpleNamespace(stdout=b"")

    with pytest.raises(RuntimeError, match="invalid rclone object key"):
        _r2_budget_preflight(
            tmp_path,
            "r2:redstm-archive",
            pointer_bytes=1,
            runner=run,
        )


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
