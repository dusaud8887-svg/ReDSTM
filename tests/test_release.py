from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    RUNTIME_SCHEMA_POLICY,
    SCHEMA_VERSION,
)
from scripts.deploy_oracle import OracleTarget
from scripts.release import (
    ReleaseError,
    _deployment_snapshot,
    _node_command,
    _oracle_status_for_release,
    _require_oracle_deploy_ready,
    _rollback_cloudflare,
    _target,
    _validate_additive_d1_migrations,
    _validate_remote_d1_integrity,
    _write_report,
    coordinated_rollback,
    deploy_all,
    deploy_cloudflare,
    deploy_oracle_application,
    deploy_oracle_bridge,
    edge_preflight,
    migrate_oracle_canonical,
    release_preflight,
)


def test_oracle_deploy_requires_the_exact_canonical_schema() -> None:
    with pytest.raises(ReleaseError, match="canonical_schema_upgrade_pending"):
        _require_oracle_deploy_ready(
            {
                "application_id": APPLICATION_ID,
                "migration_count": len(MIGRATIONS) - 1,
                "schema_version": SCHEMA_VERSION - 1,
            }
        )
    _require_oracle_deploy_ready(
        {
            "application_id": APPLICATION_ID,
            "compatible": True,
            "exact": True,
            "migration_count": len(MIGRATIONS),
            "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
            "schema_policy": RUNTIME_SCHEMA_POLICY,
            "schema_version": SCHEMA_VERSION,
        }
    )


_DEPLOYMENT_OLD = "11111111-1111-4111-8111-111111111111"
_WORKER_OLD = "22222222-2222-4222-8222-222222222222"
_DEPLOYMENT_NEW = "33333333-3333-4333-8333-333333333333"
_WORKER_NEW = "44444444-4444-4444-8444-444444444444"
_DEPLOYMENT_ROLLBACK = "55555555-5555-4555-8555-555555555555"
_WORKER_OTHER = "66666666-6666-4666-8666-666666666666"


def _deployment(
    deployment_id: str, version_id: str, created_on: str, message: str
) -> dict[str, Any]:
    return {
        "id": deployment_id,
        "created_on": created_on,
        "annotations": {"workers/message": message},
        "versions": [{"version_id": version_id, "percentage": 100}],
    }


def _version(version_id: str, release: str) -> dict[str, Any]:
    return {
        "id": version_id,
        "annotations": {
            "workers/tag": f"git-{release}",
            "workers/message": f"git:{release}",
        },
    }


def _version_snapshot(version_id: str, release: str) -> dict[str, str]:
    return {
        "version_id": version_id,
        "tag": f"git-{release}",
        "message": f"git:{release}",
    }


def test_deployment_snapshot_selects_latest_full_traffic_version() -> None:
    old = _deployment(_DEPLOYMENT_OLD, _WORKER_OLD, "2026-07-12T00:00:00Z", "old")
    new = _deployment(_DEPLOYMENT_NEW, _WORKER_NEW, "2026-07-12T01:00:00Z", "new")

    assert _deployment_snapshot([new, old]) == {
        "deployment_id": _DEPLOYMENT_NEW,
        "version_id": _WORKER_NEW,
        "created_on": "2026-07-12T01:00:00Z",
        "message": "new",
    }


def test_node_command_resolves_windows_command_shims_only_for_real_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("scripts.release.shutil.which", lambda name: rf"C:\Tools\{name}.CMD")

    def fake_runner(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[Any]:
        return subprocess.CompletedProcess([], 0)

    assert _node_command(subprocess.run, "npx", "wrangler", "--version") == [
        r"C:\Tools\npx.CMD",
        "--no-install",
        "wrangler@4.110.0",
        "--version",
    ]
    assert _node_command(fake_runner, "npx", "wrangler") == [
        "npx",
        "wrangler",
    ]


def test_edge_preflight_runs_e2e_local_migrations_and_strict_dry_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    environments: list[dict[str, str]] = []
    monkeypatch.setenv("TYPEMOON_PASSWORD", "source-secret")
    monkeypatch.setenv("REDSTM_ACCESS_CLIENT_SECRET", "access-secret")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "deploy-secret")
    monkeypatch.setenv("REDSTM_ORACLE_HOST", "production.example")
    monkeypatch.setenv("REDSTM_ORACLE_USER", "ubuntu")
    monkeypatch.setenv("REDSTM_ORACLE_KEY", "C:/production/oracle.key")
    migrations = tmp_path / "edge" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_initial.sql").write_text(
        "CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT;\n",
        encoding="utf-8",
    )

    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        commands.append(command)
        environments.append(dict(kwargs["env"]))
        return subprocess.CompletedProcess(command, 0)

    edge_preflight(tmp_path, runner=run)

    assert commands[:4] == [
        ["npm", "ci"],
        ["npm", "test"],
        ["npm", "run", "check"],
        ["npm", "run", "test:e2e"],
    ]
    assert commands[4] == ["npm", "run", "test:d1"]
    assert commands[5] == ["npx", "wrangler", "deploy", "--dry-run", "--strict"]
    assert all("TYPEMOON_PASSWORD" not in environment for environment in environments)
    assert all("REDSTM_ACCESS_CLIENT_SECRET" not in environment for environment in environments)
    assert all("CLOUDFLARE_API_TOKEN" not in environment for environment in environments)
    assert all("REDSTM_ORACLE_HOST" not in environment for environment in environments)
    assert all("REDSTM_ORACLE_USER" not in environment for environment in environments)
    assert all("REDSTM_ORACLE_KEY" not in environment for environment in environments)


def test_release_preflight_runs_quality_gates_in_an_exact_commit_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = "a" * 40
    commands: list[list[str]] = []
    gated: list[Path] = []

    monkeypatch.setattr("scripts.release.release_identity", lambda *_args, **_kwargs: release)
    monkeypatch.setattr("scripts.release.quality_gates", lambda root, **_kwargs: gated.append(root))
    monkeypatch.setattr(
        "scripts.release.edge_preflight", lambda root, **_kwargs: gated.append(root)
    )

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        if command[:3] == ["git", "worktree", "add"]:
            Path(command[-2]).mkdir(parents=True)
        stdout = release + "\n" if command[:3] == ["git", "rev-parse", "--verify"] else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    with release_preflight(tmp_path, runner=run) as (snapshot, observed_release):
        assert observed_release == release
        assert snapshot != tmp_path
        assert gated == [snapshot, snapshot]

    assert any(command[:3] == ["git", "worktree", "remove"] for command in commands)


def test_release_preflight_reports_a_stable_dirty_worktree_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "scripts.release.release_identity",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("working tree must be clean before deploy")
        ),
    )

    with pytest.raises(ReleaseError) as failure:
        with release_preflight(tmp_path):
            pytest.fail("dirty worktree must fail before creating a release snapshot")

    assert failure.value.stage == "preflight"
    assert failure.value.code == "worktree_dirty"


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE commands;",
        "ALTER TABLE commands RENAME TO old_commands;",
        "DELETE FROM commands;",
        "UPDATE commands SET state = 'failed';",
    ],
)
def test_edge_preflight_rejects_non_additive_d1_migrations(tmp_path: Path, sql: str) -> None:
    migrations = tmp_path / "edge" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "0001_initial.sql").write_text(
        "CREATE TABLE commands (id INTEGER PRIMARY KEY) STRICT;\n",
        encoding="utf-8",
    )
    (migrations / "0002_breaking.sql").write_text(sql + "\n", encoding="utf-8")

    with pytest.raises(ReleaseError, match="d1_migration"):
        edge_preflight(
            tmp_path,
            runner=lambda *_args, **_kwargs: pytest.fail(
                "migration policy must fail before external commands"
            ),
        )


def test_repository_d1_migrations_are_additive() -> None:
    root = Path(__file__).resolve().parents[1]

    _validate_additive_d1_migrations(root / "edge")


@pytest.mark.parametrize(
    ("return_code", "safe_code"),
    [(2, "d1_active_command_conflict"), (1, "d1_integrity_preflight_failed")],
)
def test_remote_d1_integrity_has_stable_failure_codes(
    tmp_path: Path, return_code: int, safe_code: str
) -> None:
    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        raise subprocess.CalledProcessError(return_code, command)

    with pytest.raises(ReleaseError) as captured:
        _validate_remote_d1_integrity(tmp_path, run)
    assert captured.value.stage == "d1_migration"
    assert captured.value.code == safe_code


def test_cloudflare_deploy_migrates_then_smokes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    environments: list[dict[str, str]] = []
    deployed = False
    release = "a" * 40
    monkeypatch.setenv("REDSTM_ACCESS_CLIENT_SECRET", "access-secret")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "deploy-secret")

    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        nonlocal deployed
        commands.append(command)
        environments.append(dict(kwargs["env"]))
        if command[2:4] == ["deployments", "list"]:
            payload = [
                _deployment(
                    _DEPLOYMENT_NEW if deployed else _DEPLOYMENT_OLD,
                    _WORKER_NEW if deployed else _WORKER_OLD,
                    "2026-07-12T01:00:00Z" if deployed else "2026-07-12T00:00:00Z",
                    f"git:{release}" if deployed else "old",
                )
            ]
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))
        if command[2] == "deploy":
            deployed = True
        return subprocess.CompletedProcess(command, 0, stdout="")

    report = deploy_cloudflare(
        tmp_path,
        release,
        runner=run,
        smoke=lambda git_sha, worker_version: {
            "worker_git_sha": git_sha,
            "worker_version_id": worker_version,
            "checks": {"worker_version": True, "r2_release": True, "d1_schema": True},
        },
        sleep=lambda _seconds: None,
    )

    migrate_index = next(i for i, command in enumerate(commands) if "migrations" in command)
    deploy_index = next(i for i, command in enumerate(commands) if command[2] == "deploy")
    assert migrate_index < deploy_index
    tag_index = commands[deploy_index].index("--tag")
    assert commands[deploy_index][tag_index + 1] == f"git-{release}"
    assert report["previous"]["version_id"] == _WORKER_OLD
    assert report["deployed"]["version_id"] == _WORKER_NEW
    assert all(
        environment["CLOUDFLARE_API_TOKEN"] == "deploy-secret" for environment in environments
    )
    assert all("REDSTM_ACCESS_CLIENT_SECRET" not in environment for environment in environments)


def test_cloudflare_smoke_failure_rolls_back_explicit_version(tmp_path: Path) -> None:
    commands: list[list[str]] = []
    state = "old"
    release = "a" * 40

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        nonlocal state
        commands.append(command)
        if command[2:4] == ["deployments", "list"]:
            values = {
                "old": (_DEPLOYMENT_OLD, _WORKER_OLD, "old"),
                "new": (_DEPLOYMENT_NEW, _WORKER_NEW, f"git:{release}"),
                "rolled-back": (_DEPLOYMENT_ROLLBACK, _WORKER_OLD, "rollback"),
            }
            deployment_id, version_id, message = values[state]
            payload = [_deployment(deployment_id, version_id, "2026-07-12T01:00:00Z", message)]
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))
        if command[2] == "deploy":
            state = "new"
        if command[2] == "rollback":
            state = "rolled-back"
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(ReleaseError, match="smoke_failed_rolled_back"):
        deploy_cloudflare(
            tmp_path,
            release,
            runner=run,
            smoke=lambda *_args: {
                "worker_git_sha": "f" * 40,
                "worker_version_id": _WORKER_OLD,
                "checks": {"worker_version": True},
            },
            sleep=lambda _seconds: None,
        )

    rollback_command = next(command for command in commands if command[2] == "rollback")
    assert rollback_command[3] == _WORKER_OLD
    assert "--yes" in rollback_command


def test_cloudflare_lost_deploy_response_restores_the_previous_version(tmp_path: Path) -> None:
    commands: list[list[str]] = []
    state = "old"
    release = "a" * 40

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        nonlocal state
        commands.append(command)
        if command[2:4] == ["deployments", "list"]:
            values = {
                "old": (_DEPLOYMENT_OLD, _WORKER_OLD, "old"),
                "new": (_DEPLOYMENT_NEW, _WORKER_NEW, f"git:{release}"),
            }
            deployment_id, version_id, message = values[state]
            payload = [_deployment(deployment_id, version_id, "2026-07-12T01:00:00Z", message)]
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))
        if command[2] == "deploy":
            state = "new"
            raise subprocess.CalledProcessError(1, command)
        if command[2] == "rollback":
            state = "old"
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(ReleaseError, match="deploy_unverified_rolled_back"):
        deploy_cloudflare(tmp_path, release, runner=run, sleep=lambda _seconds: None)

    assert state == "old"
    assert any(command[2:3] == ["rollback"] for command in commands)


def test_cloudflare_delayed_lost_deploy_is_superseded_by_an_explicit_rollback(
    tmp_path: Path,
) -> None:
    commands: list[list[str]] = []
    release = "a" * 40
    status_reads = 0
    rollback_issued = False

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        nonlocal rollback_issued, status_reads
        commands.append(command)
        if command[2:4] == ["deployments", "list"]:
            status_reads += 1
            if status_reads <= 2:
                deployment = _deployment(
                    _DEPLOYMENT_OLD,
                    _WORKER_OLD,
                    "2026-07-12T00:00:00Z",
                    "old",
                )
            elif rollback_issued and status_reads == 3:
                deployment = _deployment(
                    _DEPLOYMENT_NEW,
                    _WORKER_NEW,
                    "2026-07-12T00:00:01Z",
                    f"git:{release}",
                )
            else:
                deployment = _deployment(
                    _DEPLOYMENT_ROLLBACK,
                    _WORKER_OLD,
                    "2026-07-12T00:00:02Z",
                    "rollback",
                )
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps([deployment]))
        if command[2] == "deploy":
            raise subprocess.CalledProcessError(1, command)
        if command[2] == "rollback":
            rollback_issued = True
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(ReleaseError, match="deploy_unverified_rolled_back"):
        deploy_cloudflare(tmp_path, release, runner=run, sleep=lambda _seconds: None)

    assert rollback_issued is True
    assert status_reads == 4
    assert any(command[2:3] == ["rollback"] for command in commands)


def test_cloudflare_automatic_rollback_refuses_an_unrelated_active_worker(
    tmp_path: Path,
) -> None:
    state = "old"
    release = "a" * 40

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        nonlocal state
        if command[2:4] == ["deployments", "list"]:
            values = {
                "old": (_DEPLOYMENT_OLD, _WORKER_OLD, "old"),
                "other": (_DEPLOYMENT_ROLLBACK, _WORKER_OTHER, "git:" + "f" * 40),
            }
            deployment_id, version_id, message = values[state]
            payload = [_deployment(deployment_id, version_id, "2026-07-12T01:00:00Z", message)]
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))
        if command[2] == "deploy":
            state = "other"
            raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0, stdout="")

    with pytest.raises(ReleaseError, match="deploy_unverified_rollback_failed"):
        deploy_cloudflare(tmp_path, release, runner=run, sleep=lambda _seconds: None)

    assert state == "other"


def test_cloudflare_rollback_is_idempotent_when_target_is_already_active(
    tmp_path: Path,
) -> None:
    commands: list[list[str]] = []
    version = _WORKER_OLD

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        commands.append(command)
        payload = [_deployment(_DEPLOYMENT_OLD, version, "2026-07-12T01:00:00Z", "rollback")]
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))

    report = _rollback_cloudflare(
        tmp_path,
        version,
        "retry",
        runner=run,
        sleep=lambda _seconds: None,
    )

    assert report["version_id"] == version
    assert not any(command[2:3] == ["rollback"] for command in commands)


def test_cloudflare_rollback_refuses_a_changed_active_deployment(tmp_path: Path) -> None:
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        commands.append(command)
        payload = [
            _deployment(
                _DEPLOYMENT_NEW,
                _WORKER_NEW,
                "2026-07-12T01:00:00Z",
                "external change",
            )
        ]
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))

    with pytest.raises(ReleaseError, match="active_worker_changed"):
        _rollback_cloudflare(
            tmp_path,
            _WORKER_OLD,
            "retry",
            runner=run,
            sleep=lambda _seconds: None,
            expected_active={
                "deployment_id": _DEPLOYMENT_OLD,
                "version_id": _WORKER_NEW,
            },
        )

    assert not any(command[2:3] == ["rollback"] for command in commands)


def test_coordinated_rollback_rejects_an_unpaired_target_before_oracle_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    oracle_mutations: list[object] = []

    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": current_release},
    )
    monkeypatch.setattr(
        "scripts.release.rollback",
        lambda *_args, **_kwargs: oracle_mutations.append(True),
    )

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        payload: object
        if command[2:4] == ["deployments", "list"]:
            payload = [
                _deployment(
                    _DEPLOYMENT_NEW,
                    _WORKER_NEW,
                    "2026-07-12T01:00:00Z",
                    f"git:{current_release}",
                )
            ]
        elif command[2:4] == ["versions", "view"]:
            release = "b" * 40 if command[4] == _WORKER_OLD else current_release
            payload = _version(command[4], release)
        else:
            pytest.fail(f"unexpected command: {command}")
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))

    with pytest.raises(ReleaseError, match="worker_oracle_target_mismatch"):
        coordinated_rollback(
            tmp_path,
            target,
            _WORKER_OLD,
            target_release,
            runner=run,
            smoke=lambda *_args: pytest.fail("smoke must not run"),
        )

    assert oracle_mutations == []


def test_coordinated_rollback_requires_the_requested_worker_version_to_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: pytest.fail("Oracle must not be read before target validation"),
    )

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        payload: object
        if command[2:4] == ["deployments", "list"]:
            payload = [
                _deployment(
                    _DEPLOYMENT_NEW,
                    _WORKER_NEW,
                    "2026-07-12T01:00:00Z",
                    "current",
                )
            ]
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))
        raise subprocess.CalledProcessError(1, command)

    with pytest.raises(ReleaseError, match="worker_version_unavailable"):
        coordinated_rollback(
            tmp_path,
            target,
            _WORKER_OLD,
            "a" * 40,
            runner=run,
            smoke=lambda *_args: pytest.fail("smoke must not run"),
        )


def test_coordinated_rollback_repairs_worker_only_release_skew(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    target_release = "a" * 40
    active_release = "c" * 40
    active = {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW}
    deployments = iter([active, active])
    oracle_mutations: list[bool] = []
    worker_rollbacks: list[str] = []

    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment", lambda *_args, **_kwargs: next(deployments)
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_version",
        lambda _edge, version, _runner: _version_snapshot(
            version, target_release if version == _WORKER_OLD else active_release
        ),
    )
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": target_release},
    )
    monkeypatch.setattr(
        "scripts.release.rollback",
        lambda *_args, **_kwargs: oracle_mutations.append(True),
    )

    def worker_rollback(
        _edge: Path, version: str, _message: str, **_kwargs: object
    ) -> dict[str, str]:
        worker_rollbacks.append(version)
        return {"deployment_id": _DEPLOYMENT_ROLLBACK, "version_id": version}

    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        worker_rollback,
    )

    report = coordinated_rollback(
        tmp_path,
        target,
        _WORKER_OLD,
        target_release,
        runner=lambda *_args, **_kwargs: pytest.fail("runner must be mocked"),
        smoke=lambda release, version: {
            "worker_git_sha": release,
            "worker_version_id": version,
            "checks": {"worker_version": True},
        },
    )

    assert oracle_mutations == []
    assert worker_rollbacks == [_WORKER_OLD]
    assert report["cloudflare"]["version_id"] == _WORKER_OLD


def test_coordinated_rollback_verifies_both_pairs_then_guards_and_smokes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    oracle_current = [current_release]
    worker_current = [_WORKER_NEW]
    events: list[str] = []

    def oracle_status(*_args: object, **_kwargs: object) -> dict[str, str]:
        events.append("oracle:status")
        return {"current_release": oracle_current[0]}

    def oracle_rollback(*_args: object, **kwargs: object) -> None:
        assert kwargs["expected_current"] == oracle_current[0]
        events.append("oracle:rollback")
        oracle_current[0] = str(kwargs["target_release"])

    monkeypatch.setattr("scripts.release.status", oracle_status)
    monkeypatch.setattr("scripts.release.rollback", oracle_rollback)

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[Any]:
        payload: object
        if command[2:4] == ["deployments", "list"]:
            deployment_id = (
                _DEPLOYMENT_NEW if worker_current[0] == _WORKER_NEW else _DEPLOYMENT_ROLLBACK
            )
            payload = [
                _deployment(
                    deployment_id,
                    worker_current[0],
                    "2026-07-12T01:00:00Z",
                    "rollback",
                )
            ]
        elif command[2:4] == ["versions", "view"]:
            events.append(f"worker:version:{command[4]}")
            release = target_release if command[4] == _WORKER_OLD else current_release
            payload = _version(command[4], release)
        elif command[2] == "rollback":
            events.append("worker:rollback")
            worker_current[0] = command[3]
            return subprocess.CompletedProcess(command, 0, stdout="")
        else:
            pytest.fail(f"unexpected command: {command}")
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(payload))

    report = coordinated_rollback(
        tmp_path,
        target,
        _WORKER_OLD,
        target_release,
        runner=run,
        smoke=lambda release, version: {
            "worker_git_sha": release,
            "worker_version_id": version,
            "checks": {"worker_version": True},
        },
        sleep=lambda _seconds: None,
    )

    assert events.index(f"worker:version:{_WORKER_OLD}") < events.index("oracle:rollback")
    assert events.index(f"worker:version:{_WORKER_NEW}") < events.index("oracle:rollback")
    assert oracle_current == [target_release]
    assert worker_current == [_WORKER_OLD]
    assert report["smoke"]["worker_git_sha"] == target_release


def test_coordinated_rollback_reconciles_a_lost_oracle_response_at_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    oracle_current = [current_release]
    active = {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW}
    deployments = iter([active, active])
    worker_rollbacks: list[str] = []

    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment", lambda *_args, **_kwargs: next(deployments)
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_version",
        lambda _edge, version, _runner: _version_snapshot(
            version, target_release if version == _WORKER_OLD else current_release
        ),
    )
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": oracle_current[0]},
    )

    def oracle_rollback(*_args: object, **_kwargs: object) -> None:
        oracle_current[0] = target_release
        raise RuntimeError("lost response")

    def worker_rollback(
        _edge: Path, version: str, _message: str, **_kwargs: object
    ) -> dict[str, str]:
        worker_rollbacks.append(version)
        return {"deployment_id": _DEPLOYMENT_ROLLBACK, "version_id": version}

    monkeypatch.setattr("scripts.release.rollback", oracle_rollback)
    monkeypatch.setattr("scripts.release._rollback_cloudflare", worker_rollback)

    report = coordinated_rollback(
        tmp_path,
        target,
        _WORKER_OLD,
        target_release,
        runner=lambda *_args, **_kwargs: pytest.fail("runner must be mocked"),
        smoke=lambda release, version: {
            "worker_git_sha": release,
            "worker_version_id": version,
            "checks": {"worker_version": True},
        },
    )

    assert oracle_current == [target_release]
    assert worker_rollbacks == [_WORKER_OLD]
    assert report["oracle"]["current_release"] == target_release


@pytest.mark.parametrize(
    ("observed_release", "safe_code"),
    [
        ("c" * 40, "oracle_rollback_failed"),
        ("f" * 40, "oracle_rollback_external_change"),
    ],
)
def test_coordinated_rollback_stops_after_a_failed_oracle_transition(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    observed_release: str,
    safe_code: str,
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    active = {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW}
    deployments = iter([active, active])
    statuses = iter([current_release, observed_release])

    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment", lambda *_args, **_kwargs: next(deployments)
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_version",
        lambda _edge, version, _runner: _version_snapshot(
            version, target_release if version == _WORKER_OLD else current_release
        ),
    )
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": next(statuses)},
    )
    monkeypatch.setattr(
        "scripts.release.rollback",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("rollback failed")),
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda *_args, **_kwargs: pytest.fail("Worker must not change"),
    )

    with pytest.raises(ReleaseError) as raised:
        coordinated_rollback(
            tmp_path,
            target,
            _WORKER_OLD,
            target_release,
            runner=lambda *_args, **_kwargs: pytest.fail("runner must be mocked"),
            smoke=lambda *_args: pytest.fail("smoke must not run"),
        )

    assert raised.value.code == safe_code


def test_coordinated_rollback_accepts_a_target_worker_observed_after_cli_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    oracle_current = [current_release]
    deployments = iter(
        [
            {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW},
            {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW},
            {"deployment_id": _DEPLOYMENT_ROLLBACK, "version_id": _WORKER_OLD},
        ]
    )

    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment", lambda *_args, **_kwargs: next(deployments)
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_version",
        lambda _edge, version, _runner: _version_snapshot(
            version, target_release if version == _WORKER_OLD else current_release
        ),
    )
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": oracle_current[0]},
    )

    def oracle_rollback(*_args: object, **kwargs: object) -> None:
        assert kwargs["expected_current"] == oracle_current[0]
        oracle_current[0] = str(kwargs["target_release"])

    monkeypatch.setattr("scripts.release.rollback", oracle_rollback)
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("lost response")),
    )

    report = coordinated_rollback(
        tmp_path,
        target,
        _WORKER_OLD,
        target_release,
        runner=lambda *_args, **_kwargs: pytest.fail("runner must be mocked"),
        smoke=lambda release, version: {
            "worker_git_sha": release,
            "worker_version_id": version,
            "checks": {"worker_version": True},
        },
    )

    assert oracle_current == [target_release]
    assert report["cloudflare"]["version_id"] == _WORKER_OLD


def test_coordinated_rollback_rechecks_active_before_oracle_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current_release = "c" * 40
    target_release = "a" * 40
    deployments = iter(
        [
            {"deployment_id": _DEPLOYMENT_NEW, "version_id": _WORKER_NEW},
            {"deployment_id": _DEPLOYMENT_ROLLBACK, "version_id": _WORKER_OTHER},
        ]
    )
    oracle_mutations: list[bool] = []

    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment", lambda *_args, **_kwargs: next(deployments)
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_version",
        lambda _edge, version, _runner: _version_snapshot(
            version, target_release if version == _WORKER_OLD else current_release
        ),
    )
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": current_release},
    )
    monkeypatch.setattr(
        "scripts.release.rollback",
        lambda *_args, **_kwargs: oracle_mutations.append(True),
    )

    with pytest.raises(ReleaseError, match="active_worker_changed"):
        coordinated_rollback(
            tmp_path,
            target,
            _WORKER_OLD,
            target_release,
            runner=lambda *_args, **_kwargs: pytest.fail("runner must be mocked"),
            smoke=lambda *_args: pytest.fail("smoke must not run"),
        )

    assert oracle_mutations == []


def test_coordinated_rollback_strictly_rejects_a_non_uuid_before_reads(
    tmp_path: Path,
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)

    with pytest.raises(ValueError, match="Worker version ID"):
        coordinated_rollback(
            tmp_path,
            target,
            "1" * 36,
            "a" * 40,
            runner=lambda *_args, **_kwargs: pytest.fail("no read may run"),
        )


def test_full_release_does_not_double_rollback_oracle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    worker_rollbacks: list[str] = []
    oracle_rollbacks: list[bool] = []
    old = "b" * 40

    monkeypatch.setattr(
        "scripts.release.status", lambda *_args, **_kwargs: {"current_release": old}
    )
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )
    monkeypatch.setattr(
        "scripts.release.deploy_oracle_application",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("install failed")),
    )
    monkeypatch.setattr(
        "scripts.release.rollback", lambda *_args, **_kwargs: oracle_rollbacks.append(True)
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda _edge, version, _message, **_kwargs: worker_rollbacks.append(version),
    )

    with pytest.raises(ReleaseError, match="oracle_install_failed_worker_rolled_back"):
        deploy_all(tmp_path, target, "a" * 40)

    assert oracle_rollbacks == []
    assert worker_rollbacks == [_WORKER_OLD]


def test_oracle_install_error_is_reconciled_when_remote_is_the_target_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    oracle_rollbacks: list[bool] = []
    worker_rollbacks: list[str] = []

    monkeypatch.setattr(
        "scripts.release.status", lambda *_args, **_kwargs: {"current_release": release}
    )
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )
    monkeypatch.setattr(
        "scripts.release.deploy_oracle_application",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("reconcile failed")),
    )
    monkeypatch.setattr(
        "scripts.release.rollback", lambda *_args, **_kwargs: oracle_rollbacks.append(True)
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda _edge, version, _message, **_kwargs: worker_rollbacks.append(version),
    )

    report = deploy_all(
        tmp_path,
        target,
        release,
        smoke=lambda git_sha, worker_version: {
            "worker_git_sha": git_sha,
            "worker_version_id": worker_version,
            "checks": {"worker_version": True},
        },
    )

    assert oracle_rollbacks == []
    assert worker_rollbacks == []
    assert report["oracle"]["current_release"] == release


def test_oracle_install_error_with_an_external_current_sha_stops_without_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    statuses = iter([{"current_release": "b" * 40}, {"current_release": "c" * 40}])
    worker_rollbacks: list[str] = []
    oracle_rollbacks: list[bool] = []

    monkeypatch.setattr("scripts.release.status", lambda *_args, **_kwargs: next(statuses))
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )
    monkeypatch.setattr(
        "scripts.release.deploy_oracle_application",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("ambiguous install")),
    )
    monkeypatch.setattr(
        "scripts.release.rollback", lambda *_args, **_kwargs: oracle_rollbacks.append(True)
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda _edge, version, _message, **_kwargs: worker_rollbacks.append(version),
    )

    with pytest.raises(ReleaseError, match="oracle_install_ambiguous_no_automatic_rollback"):
        deploy_all(tmp_path, target, release)

    assert oracle_rollbacks == []
    assert worker_rollbacks == []


def test_full_release_rolls_oracle_back_to_the_observed_predeploy_sha(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    old = "b" * 40
    release = "a" * 40
    statuses = iter(
        [
            {"current_release": old},
            {"current_release": release},
            {"current_release": old},
        ]
    )
    oracle_rollbacks: list[dict[str, object]] = []
    worker_rollbacks: list[str] = []

    monkeypatch.setattr("scripts.release.status", lambda *_args, **_kwargs: next(statuses))
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )
    monkeypatch.setattr(
        "scripts.release.deploy_oracle_application",
        lambda *_args, **_kwargs: {"current_release": release},
    )
    monkeypatch.setattr(
        "scripts.release.rollback",
        lambda *_args, **kwargs: oracle_rollbacks.append(kwargs),
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda _edge, version, _message, **_kwargs: worker_rollbacks.append(version),
    )

    with pytest.raises(ReleaseError, match="final_smoke_failed_coordinated_rollback"):
        deploy_all(
            tmp_path,
            target,
            release,
            smoke=lambda *_args: (_ for _ in ()).throw(RuntimeError("final smoke failed")),
        )

    assert len(oracle_rollbacks) == 1
    assert oracle_rollbacks[0]["expected_current"] == release
    assert oracle_rollbacks[0]["target_release"] == old
    assert worker_rollbacks == [_WORKER_OLD]


@pytest.mark.parametrize(
    ("restore_fails", "safe_code"),
    [
        (False, "final_smoke_failed_worker_rollback_failed_oracle_restored"),
        (True, "final_smoke_failed_worker_rollback_failed_oracle_restore_failed"),
    ],
)
def test_final_smoke_worker_rollback_failure_reports_oracle_compensation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    restore_fails: bool,
    safe_code: str,
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    old = "b" * 40
    release = "a" * 40
    oracle_current = [old]
    oracle_targets: list[str] = []

    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: {"current_release": oracle_current[0]},
    )
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )

    def install(*_args: object, **_kwargs: object) -> dict[str, str]:
        oracle_current[0] = release
        return {"current_release": release}

    def oracle_rollback(*_args: object, **kwargs: object) -> None:
        requested = str(kwargs["target_release"])
        oracle_targets.append(requested)
        if restore_fails and requested == release:
            raise RuntimeError("restore failed")
        assert kwargs["expected_current"] == oracle_current[0]
        oracle_current[0] = requested

    monkeypatch.setattr("scripts.release.deploy_oracle_application", install)
    monkeypatch.setattr("scripts.release.rollback", oracle_rollback)
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("Worker rollback failed")),
    )
    monkeypatch.setattr(
        "scripts.release._cloudflare_deployment",
        lambda *_args, **_kwargs: {"version_id": _WORKER_NEW},
    )

    with pytest.raises(ReleaseError, match=safe_code):
        deploy_all(
            tmp_path,
            target,
            release,
            smoke=lambda *_args: (_ for _ in ()).throw(RuntimeError("final smoke failed")),
        )

    assert oracle_targets == [old, release]
    assert oracle_current == ([old] if restore_fails else [release])


def test_first_oracle_release_failure_rolls_worker_back_without_toggling_oracle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    statuses = iter([{"current_release": None}, {"current_release": None}])
    oracle_rollbacks: list[bool] = []
    worker_rollbacks: list[str] = []

    monkeypatch.setattr("scripts.release.status", lambda *_args, **_kwargs: next(statuses))
    monkeypatch.setattr(
        "scripts.release.deploy_cloudflare",
        lambda *_args, **_kwargs: {
            "previous": {"version_id": _WORKER_OLD},
            "deployed": {"version_id": _WORKER_NEW},
        },
    )
    monkeypatch.setattr(
        "scripts.release.deploy_oracle_application",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("install failed")),
    )
    monkeypatch.setattr(
        "scripts.release.rollback", lambda *_args, **_kwargs: oracle_rollbacks.append(True)
    )
    monkeypatch.setattr(
        "scripts.release._rollback_cloudflare",
        lambda _edge, version, _message, **_kwargs: worker_rollbacks.append(version),
    )

    with pytest.raises(ReleaseError, match="oracle_install_failed_worker_rolled_back"):
        deploy_all(tmp_path, target, release)

    assert oracle_rollbacks == []
    assert worker_rollbacks == [_WORKER_OLD]


def test_target_requires_explicit_host_and_key(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("REDSTM_ORACLE_HOST", "REDSTM_ORACLE_USER", "REDSTM_ORACLE_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="host and SSH key"):
        _target(None, None, None)


def test_oracle_deploy_reuses_the_installers_verified_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    verified = {"current_release": release, "control_active": True}

    def build(
        _root: Path,
        _release: str,
        destination: Path,
        **_kwargs: object,
    ) -> str:
        destination.write_bytes(b"archive")
        return "b" * 64

    monkeypatch.setattr("scripts.release.build_archive", build)
    monkeypatch.setattr("scripts.release.deploy_release", lambda *_args, **_kwargs: verified)
    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: pytest.fail("verified deploy status must be reused"),
    )

    assert deploy_oracle_application(tmp_path, target, release) == verified


def test_bridge_deploy_proves_the_canonical_was_not_auto_migrated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    oracle = {"current_release": release, "previous_release": "b" * 40}
    schema = {
        "application_id": APPLICATION_ID,
        "compatible": True,
        "exact": False,
        "migration_count": len(MIGRATIONS) - 1,
        "migrations": [[item.version, item.sha256] for item in MIGRATIONS[:-1]],
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "schema_version": SCHEMA_VERSION - 1,
    }
    monkeypatch.setattr("scripts.release.deploy_oracle_application", lambda *_a, **_k: oracle)
    monkeypatch.setattr("scripts.release.canonical_schema_status", lambda *_a, **_k: schema)

    assert deploy_oracle_bridge(tmp_path, target, release) == {
        "oracle": oracle,
        "canonical": schema,
        "bridge_ready": True,
    }


def test_canonical_migration_requires_the_exact_remote_release_pair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current = "a" * 40
    previous = "b" * 40
    oracle = {"current_release": current, "previous_release": previous}
    migration = {"state": "migrated", "schema_version": SCHEMA_VERSION}
    schema = {
        "application_id": APPLICATION_ID,
        "compatible": True,
        "exact": True,
        "migration_count": len(MIGRATIONS),
        "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "schema_version": SCHEMA_VERSION,
    }
    monkeypatch.setattr("scripts.release.status", lambda *_a, **_k: oracle)
    monkeypatch.setattr("scripts.release.migrate_canonical_schema", lambda *_a, **_k: migration)
    monkeypatch.setattr("scripts.release.canonical_schema_status", lambda *_a, **_k: schema)

    assert migrate_oracle_canonical(
        target,
        expected_current=current,
        expected_previous=previous,
    ) == {"oracle": oracle, "migration": migration, "canonical": schema}

    with pytest.raises(ReleaseError, match="canonical_previous_release_changed"):
        migrate_oracle_canonical(
            target,
            expected_current=current,
            expected_previous="c" * 40,
        )


def test_canonical_migration_rejects_two_lost_responses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current = "a" * 40
    previous = "b" * 40
    schema = {
        "application_id": APPLICATION_ID,
        "compatible": True,
        "exact": True,
        "migration_count": len(MIGRATIONS),
        "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "schema_version": SCHEMA_VERSION,
    }
    attempts = 0

    def lost_response(*_args: object, **_kwargs: object) -> dict[str, Any]:
        nonlocal attempts
        attempts += 1
        raise OSError("response lost")

    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_a, **_k: {"current_release": current, "previous_release": previous},
    )
    monkeypatch.setattr("scripts.release.migrate_canonical_schema", lost_response)
    monkeypatch.setattr("scripts.release.canonical_schema_status", lambda *_a, **_k: schema)

    with pytest.raises(ReleaseError) as raised:
        migrate_oracle_canonical(target, expected_current=current, expected_previous=previous)

    assert attempts == 2
    assert raised.value.code == "canonical_schema_migration_ambiguous"


def test_canonical_migration_does_not_repeat_a_deterministic_remote_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    current = "a" * 40
    previous = "b" * 40
    attempts = 0

    def doctor_failed(*_args: object, **_kwargs: object) -> dict[str, Any]:
        nonlocal attempts
        attempts += 1
        raise subprocess.CalledProcessError(2, ["ssh", "migrate-canonical"])

    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_a, **_k: {"current_release": current, "previous_release": previous},
    )
    monkeypatch.setattr("scripts.release.migrate_canonical_schema", doctor_failed)
    monkeypatch.setattr(
        "scripts.release.canonical_schema_status",
        lambda *_a, **_k: {
            "application_id": APPLICATION_ID,
            "compatible": True,
            "exact": True,
            "migration_count": len(MIGRATIONS),
            "migrations": [[item.version, item.sha256] for item in MIGRATIONS],
            "schema_policy": RUNTIME_SCHEMA_POLICY,
            "schema_version": SCHEMA_VERSION,
        },
    )

    with pytest.raises(ReleaseError) as raised:
        migrate_oracle_canonical(target, expected_current=current, expected_previous=previous)

    assert attempts == 1
    assert raised.value.code == "canonical_schema_migration_ambiguous"


def test_oracle_status_falls_back_to_the_commit_bound_installer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = tmp_path / "oracle.key"
    key.write_text("test", encoding="utf-8")
    target = OracleTarget("oracle.example", "ubuntu", key)
    release = "a" * 40
    built: list[str] = []

    monkeypatch.setattr(
        "scripts.release.status",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("old installer")),
    )

    def build(
        _root: Path,
        requested_release: str,
        destination: Path,
        **_kwargs: object,
    ) -> str:
        built.append(requested_release)
        destination.write_bytes(b"archive")
        return "b" * 64

    monkeypatch.setattr("scripts.release.build_archive", build)
    monkeypatch.setattr(
        "scripts.release.status_from_archive",
        lambda *_args, **_kwargs: {"current_release": "c" * 40},
    )

    report = _oracle_status_for_release(
        tmp_path,
        target,
        release,
        runner=lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0),
    )

    assert report["current_release"] == "c" * 40
    assert built == [release]


def test_release_report_is_atomic_and_secret_free_by_construction(tmp_path: Path) -> None:
    report = {
        "schema_version": 1,
        "ok": False,
        "mode": "deploy",
        "release": "a" * 40,
        "failure": {"stage": "cloudflare_smoke", "code": "smoke_failed_rolled_back"},
    }

    path = _write_report(tmp_path, report)

    assert json.loads(path.read_text(encoding="utf-8")) == report
    assert not path.with_suffix(f"{path.suffix}.partial").exists()
