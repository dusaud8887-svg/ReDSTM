from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from uuid import UUID

from filelock import FileLock, Timeout

from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    RUNTIME_SCHEMA_POLICY,
    SCHEMA_VERSION,
)
from scripts.control_client import ControlClient
from scripts.deploy_oracle import (
    OracleTarget,
    build_archive,
    canonical_schema_status,
    deploy_release,
    migrate_canonical_schema,
    quality_gates,
    release_identity,
    rollback,
    status,
    status_from_archive,
)

CommandRunner = Callable[..., subprocess.CompletedProcess[Any]]
SmokeRunner = Callable[[str, str], dict[str, Any]]

_D1_DATABASE = "redstm-control"
_WRANGLER_VERSION = "4.120.0"
_GIT_SHA = re.compile(r"[0-9a-f]{40}")
_MIGRATION = re.compile(r"\b\d{4}_[a-zA-Z0-9_.-]+\.sql\b")
_MIGRATION_NAME = re.compile(r"\d{4}_[a-zA-Z0-9_.-]+\.sql")
_DESTRUCTIVE_D1_SQL = re.compile(
    r"\b(?:DROP|RENAME|TRUNCATE|UPDATE|REPLACE|VACUUM|REINDEX)\b|\bDELETE\s+FROM\b",
    re.IGNORECASE,
)
_ALTER_D1_SQL = re.compile(r"\bALTER\s+TABLE\b", re.IGNORECASE)
_ADDITIVE_ALTER_D1_SQL = re.compile(
    r"\bALTER\s+TABLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ADD\s+COLUMN\b",
    re.IGNORECASE,
)
_RELEASE_IDENTITY_FAILURES = {
    "working tree must be clean before deploy": "worktree_dirty",
    "git release identity is invalid": "git_release_invalid",
    "current branch must have a configured upstream before deploy": "git_upstream_missing",
    "configured upstream identity is invalid": "git_upstream_invalid",
    "HEAD must exactly match its configured upstream before deploy": "git_upstream_mismatch",
}


def _require_oracle_deploy_ready(schema: Mapping[str, object]) -> None:
    expected_migrations = [[item.version, item.sha256] for item in MIGRATIONS]
    if (
        schema.get("application_id") != APPLICATION_ID
        or schema.get("schema_version") != SCHEMA_VERSION
        or schema.get("migration_count") != len(MIGRATIONS)
        or schema.get("migrations") != expected_migrations
        or schema.get("schema_policy") != RUNTIME_SCHEMA_POLICY
        or schema.get("compatible") is not True
        or schema.get("exact") is not True
    ):
        raise ReleaseError("preflight", "canonical_schema_upgrade_pending")


class ReleaseError(RuntimeError):
    def __init__(self, stage: str, code: str) -> None:
        super().__init__(code)
        self.stage = stage
        self.code = code


def _node_command(runner: CommandRunner, name: str, *arguments: str) -> list[str]:
    if runner is not subprocess.run:
        return [name, *arguments]
    executable = shutil.which(name)
    if executable is None:
        raise ReleaseError("preflight", f"{name}_not_found")
    if name == "npx" and arguments[:1] == ("wrangler",):
        arguments = ("--no-install", f"wrangler@{_WRANGLER_VERSION}", *arguments[1:])
    return [executable, *arguments]


def _canonical_uuid(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        normalized = str(UUID(value))
    except ValueError:
        return None
    return normalized if normalized == value else None


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _cloudflare_environment() -> dict[str, str]:
    environment = {**os.environ, "CI": "1", "NO_COLOR": "1"}
    for name in (
        "TYPEMOON_ID",
        "TYPEMOON_PASSWORD",
        "REDSTM_ACCESS_CLIENT_ID",
        "REDSTM_ACCESS_CLIENT_SECRET",
        "REDSTM_HEALTHCHECK_URL",
        "REDSTM_CYCLE_HEALTHCHECK_URL",
        "REDSTM_RECOVERY_HEALTHCHECK_URL",
        "REDSTM_BACKUP_HEALTHCHECK_URL",
        "REDSTM_RESTORE_HEALTHCHECK_URL",
    ):
        environment.pop(name, None)
    return environment


def _ci_environment() -> dict[str, str]:
    environment = _cloudflare_environment()
    for name in (
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CF_API_TOKEN",
        "CF_API_KEY",
        "CF_API_EMAIL",
        "REDSTM_ORACLE_HOST",
        "REDSTM_ORACLE_USER",
        "REDSTM_ORACLE_KEY",
    ):
        environment.pop(name, None)
    return environment


def _without_application_secrets(runner: CommandRunner) -> CommandRunner:
    def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        kwargs.setdefault("env", _ci_environment())
        return runner(command, **kwargs)

    return run


def _json_result(
    command: list[str],
    *,
    cwd: Path,
    runner: CommandRunner,
) -> Any:
    result = runner(
        _node_command(runner, command[0], *command[1:])
        if command[0] in {"npm", "npx"}
        else command,
        cwd=cwd,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        text=True,
        env=_cloudflare_environment(),
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ReleaseError("status", "invalid_command_json") from error


def _deployment_snapshot(payload: Any) -> dict[str, str | None]:
    if not isinstance(payload, list) or not payload:
        raise ReleaseError("cloudflare_status", "deployment_history_missing")
    deployments = [item for item in payload if isinstance(item, dict)]
    if not deployments:
        raise ReleaseError("cloudflare_status", "deployment_history_invalid")
    latest = max(deployments, key=lambda item: str(item.get("created_on", "")))
    versions = latest.get("versions")
    active = (
        [item for item in versions if isinstance(item, dict) and item.get("percentage") == 100]
        if isinstance(versions, list)
        else []
    )
    deployment_id = latest.get("id")
    version_id = active[0].get("version_id") if len(active) == 1 else None
    if _canonical_uuid(deployment_id) is None or _canonical_uuid(version_id) is None:
        raise ReleaseError("cloudflare_status", "active_deployment_invalid")
    annotations = latest.get("annotations")
    message = annotations.get("workers/message") if isinstance(annotations, dict) else None
    return {
        "deployment_id": deployment_id,
        "version_id": version_id,
        "created_on": str(latest.get("created_on", "")),
        "message": message if isinstance(message, str) else None,
    }


def _cloudflare_deployment(edge: Path, runner: CommandRunner) -> dict[str, str | None]:
    return _deployment_snapshot(
        _json_result(["npx", "wrangler", "deployments", "list", "--json"], cwd=edge, runner=runner)
    )


def _version_snapshot(payload: Any) -> dict[str, str | None]:
    if not isinstance(payload, dict):
        raise ReleaseError("cloudflare_status", "worker_version_invalid")
    version_id = _canonical_uuid(payload.get("id"))
    annotations = payload.get("annotations")
    if version_id is None or not isinstance(annotations, dict):
        raise ReleaseError("cloudflare_status", "worker_version_invalid")
    tag = annotations.get("workers/tag")
    message = annotations.get("workers/message")
    return {
        "version_id": version_id,
        "tag": tag if isinstance(tag, str) else None,
        "message": message if isinstance(message, str) else None,
    }


def _cloudflare_version(
    edge: Path,
    version_id: str,
    runner: CommandRunner,
) -> dict[str, str | None]:
    normalized = _canonical_uuid(version_id)
    if normalized is None:
        raise ValueError("Worker version ID is invalid")
    try:
        version = _version_snapshot(
            _json_result(
                ["npx", "wrangler", "versions", "view", normalized, "--json"],
                cwd=edge,
                runner=runner,
            )
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ReleaseError("rollback_preflight", "worker_version_unavailable") from error
    if version["version_id"] != normalized:
        raise ReleaseError("rollback_preflight", "worker_version_identity_mismatch")
    return version


def _require_worker_release(
    version: Mapping[str, str | None],
    release: str,
    *,
    code: str,
) -> None:
    if (
        _GIT_SHA.fullmatch(release) is None
        or version.get("tag") != f"git-{release}"
        or version.get("message") != f"git:{release}"
    ):
        raise ReleaseError("rollback_preflight", code)


def _await_deployment(
    edge: Path,
    *,
    runner: CommandRunner,
    predicate: Callable[[Mapping[str, str | None]], bool],
    sleep: Callable[[float], None],
) -> dict[str, str | None]:
    for attempt in range(5):
        current = _cloudflare_deployment(edge, runner)
        if predicate(current):
            return current
        if attempt < 4:
            sleep(2)
    raise ReleaseError("cloudflare_status", "deployment_not_observed")


def _validate_additive_d1_migrations(edge: Path) -> None:
    migrations = edge / "migrations"
    paths = sorted(migrations.glob("*.sql"))
    if not paths or any(_MIGRATION_NAME.fullmatch(path.name) is None for path in paths):
        raise ReleaseError("preflight", "d1_migration_set_invalid")
    for path in paths:
        sql = path.read_text(encoding="utf-8")
        without_comments = re.sub(r"/\*.*?\*/|--[^\r\n]*", " ", sql, flags=re.DOTALL)
        if _DESTRUCTIVE_D1_SQL.search(without_comments):
            raise ReleaseError("preflight", "destructive_d1_migration")
        alters = list(_ALTER_D1_SQL.finditer(without_comments))
        additive_alters = list(_ADDITIVE_ALTER_D1_SQL.finditer(without_comments))
        if len(alters) != len(additive_alters):
            raise ReleaseError("preflight", "non_additive_d1_migration")


def edge_preflight(
    root: Path,
    *,
    runner: CommandRunner = subprocess.run,
) -> None:
    edge = root / "edge"
    _validate_additive_d1_migrations(edge)
    commands = [
        _node_command(runner, "npm", "ci"),
        _node_command(runner, "npm", "test"),
        _node_command(runner, "npm", "run", "check"),
        _node_command(runner, "npm", "run", "test:e2e"),
        _node_command(runner, "npm", "run", "test:d1"),
    ]
    for command in commands:
        runner(command, cwd=edge, check=True, env=_ci_environment())
    runner(
        _node_command(runner, "npx", "wrangler", "deploy", "--dry-run", "--strict"),
        cwd=edge,
        check=True,
        env=_ci_environment(),
    )


def _validate_remote_d1_integrity(edge: Path, runner: CommandRunner) -> None:
    try:
        runner(
            _node_command(runner, "npm", "run", "check:d1-remote"),
            cwd=edge,
            check=True,
            stdin=subprocess.DEVNULL,
            env=_cloudflare_environment(),
        )
    except subprocess.CalledProcessError as error:
        code = (
            "d1_active_command_conflict"
            if error.returncode == 2
            else "d1_integrity_preflight_failed"
        )
        raise ReleaseError("d1_migration", code) from error
    except (OSError, subprocess.SubprocessError) as error:
        raise ReleaseError("d1_migration", "d1_integrity_preflight_failed") from error


@contextmanager
def release_preflight(
    root: Path,
    *,
    runner: CommandRunner = subprocess.run,
) -> Iterator[tuple[Path, str]]:
    safe_runner = _without_application_secrets(runner)
    try:
        release = release_identity(root, runner=safe_runner)
    except RuntimeError as error:
        raise ReleaseError(
            "preflight",
            _RELEASE_IDENTITY_FAILURES.get(str(error), "release_identity_invalid"),
        ) from error
    except (OSError, subprocess.SubprocessError) as error:
        raise ReleaseError("preflight", "release_identity_command_failed") from error
    with TemporaryDirectory(prefix="redstm-release-worktree-") as temporary:
        snapshot = Path(temporary) / "source"
        safe_runner(
            ["git", "worktree", "add", "--detach", str(snapshot), release],
            cwd=root,
            check=True,
            stdin=subprocess.DEVNULL,
        )
        try:
            snapshot_release = safe_runner(
                ["git", "rev-parse", "--verify", "HEAD^{commit}"],
                cwd=snapshot,
                check=True,
                stdout=subprocess.PIPE,
                text=True,
            ).stdout.strip()
            if snapshot_release != release:
                raise ReleaseError("preflight", "release_snapshot_mismatch")
            quality_gates(snapshot, runner=safe_runner)
            edge_preflight(snapshot, runner=runner)
            yield snapshot, release
        finally:
            safe_runner(
                ["git", "worktree", "remove", "--force", str(snapshot)],
                cwd=root,
                check=False,
                stdin=subprocess.DEVNULL,
            )


def _machine_smoke(expected_git_sha: str, expected_worker_version: str) -> dict[str, Any]:
    return ControlClient.from_environment().release_smoke(
        expected_worker_version=expected_worker_version,
        expected_git_sha=expected_git_sha,
    )


def _validate_smoke_identity(
    report: Mapping[str, Any], expected_git_sha: str, expected_worker_version: str
) -> None:
    if (
        report.get("worker_git_sha") != expected_git_sha
        or report.get("worker_version_id") != expected_worker_version
        or not isinstance(report.get("checks"), dict)
        or report["checks"].get("worker_version") is not True
    ):
        raise ReleaseError("cloudflare_smoke", "worker_release_mismatch")


def _rollback_cloudflare(
    edge: Path,
    version_id: str,
    message: str,
    *,
    runner: CommandRunner,
    sleep: Callable[[float], None],
    expected_message: str | None = None,
    expected_active: Mapping[str, str | None] | None = None,
    force: bool = False,
) -> dict[str, str | None]:
    if _canonical_uuid(version_id) is None:
        raise ValueError("Worker version ID is invalid")
    current = _cloudflare_deployment(edge, runner)
    if expected_active is not None and any(
        current.get(name) != expected_active.get(name) for name in ("deployment_id", "version_id")
    ):
        raise ReleaseError("cloudflare_rollback", "active_worker_changed")
    if current["version_id"] == version_id and not force:
        return current
    if (
        current["version_id"] != version_id
        and expected_message is not None
        and current["message"] != expected_message
    ):
        raise ReleaseError("cloudflare_rollback", "active_worker_changed")
    deployment_before = current["deployment_id"]
    runner(
        _node_command(
            runner,
            "npx",
            "wrangler",
            "rollback",
            version_id,
            "--yes",
            "--message",
            message,
        ),
        cwd=edge,
        check=True,
        stdin=subprocess.DEVNULL,
        env=_cloudflare_environment(),
    )
    return _await_deployment(
        edge,
        runner=runner,
        predicate=lambda current: (
            current["version_id"] == version_id
            and (not force or current["deployment_id"] != deployment_before)
        ),
        sleep=sleep,
    )


def deploy_cloudflare(
    root: Path,
    release: str,
    *,
    runner: CommandRunner = subprocess.run,
    smoke: SmokeRunner = _machine_smoke,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    if _GIT_SHA.fullmatch(release) is None:
        raise ValueError("release identity is invalid")
    edge = root / "edge"
    previous = _cloudflare_deployment(edge, runner)
    message = f"git:{release}"
    _validate_remote_d1_integrity(edge, runner)
    try:
        runner(
            _node_command(
                runner,
                "npx",
                "wrangler",
                "d1",
                "migrations",
                "apply",
                _D1_DATABASE,
                "--remote",
            ),
            cwd=edge,
            check=True,
            stdin=subprocess.DEVNULL,
            env=_cloudflare_environment(),
        )
    except (OSError, subprocess.SubprocessError) as error:
        try:
            _validate_remote_d1_integrity(edge, runner)
        except ReleaseError as integrity_error:
            if integrity_error.code == "d1_active_command_conflict":
                raise integrity_error from error
        raise ReleaseError("d1_migration", "d1_migration_failed") from error
    try:
        runner(
            _node_command(
                runner,
                "npx",
                "wrangler",
                "deploy",
                "--strict",
                "--message",
                message,
                "--tag",
                f"git-{release}",
            ),
            cwd=edge,
            check=True,
            stdin=subprocess.DEVNULL,
            env=_cloudflare_environment(),
        )
        deployed = _await_deployment(
            edge,
            runner=runner,
            predicate=lambda current: (
                current["deployment_id"] != previous["deployment_id"]
                and current["message"] == message
            ),
            sleep=sleep,
        )
    except Exception as error:
        try:
            _rollback_cloudflare(
                edge,
                str(previous["version_id"]),
                f"Automatic rollback after unverified deploy for git:{release}",
                runner=runner,
                sleep=sleep,
                expected_message=message,
                force=True,
            )
        except Exception as rollback_error:
            raise ReleaseError(
                "worker_deploy", "deploy_unverified_rollback_failed"
            ) from rollback_error
        raise ReleaseError("worker_deploy", "deploy_unverified_rolled_back") from error
    try:
        deployed_version = str(deployed["version_id"])
        smoke_report = smoke(release, deployed_version)
        _validate_smoke_identity(smoke_report, release, deployed_version)
    except Exception as error:
        try:
            _rollback_cloudflare(
                edge,
                str(previous["version_id"]),
                f"Automatic rollback after failed smoke for git:{release}",
                runner=runner,
                sleep=sleep,
                expected_message=message,
                expected_active=deployed,
            )
        except Exception as rollback_error:
            raise ReleaseError(
                "cloudflare_smoke", "smoke_failed_rollback_failed"
            ) from rollback_error
        raise ReleaseError("cloudflare_smoke", "smoke_failed_rolled_back") from error
    return {
        "previous": previous,
        "deployed": deployed,
        "smoke": smoke_report,
    }


def _target(host: str | None, user: str | None, key: Path | None) -> OracleTarget:
    resolved_host = host or os.environ.get("REDSTM_ORACLE_HOST", "")
    resolved_user = user or os.environ.get("REDSTM_ORACLE_USER", "ubuntu")
    key_value = str(key) if key is not None else os.environ.get("REDSTM_ORACLE_KEY", "")
    if not resolved_host or not key_value:
        raise ValueError("Oracle host and SSH key are required")
    return OracleTarget(resolved_host, resolved_user, Path(key_value))


def _oracle_status_for_release(
    root: Path,
    target: OracleTarget,
    release: str,
    *,
    runner: CommandRunner,
) -> dict[str, Any]:
    try:
        return status(target, runner=runner)
    except OSError, subprocess.SubprocessError, RuntimeError:
        with TemporaryDirectory(prefix="redstm-oracle-status-") as temporary:
            archive = Path(temporary) / f"redstm-release-{release}.tar.gz"
            build_archive(root, release, archive, runner=runner)
            return status_from_archive(target, archive, runner=runner)


def deploy_oracle_application(
    root: Path,
    target: OracleTarget,
    release: str,
    *,
    install_mode: str = "install",
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    safe_runner = _without_application_secrets(runner)
    with TemporaryDirectory(prefix="redstm-oracle-release-") as temporary:
        archive = Path(temporary) / f"redstm-release-{release}.tar.gz"
        digest = build_archive(root, release, archive, runner=safe_runner)
        remote = deploy_release(
            target,
            release,
            archive,
            digest,
            None,
            install_mode=install_mode,
            runner=safe_runner,
        )
    if remote.get("current_release") != release:
        raise ReleaseError("oracle_status", "oracle_release_mismatch")
    return remote


def deploy_oracle_bridge(
    root: Path,
    target: OracleTarget,
    release: str,
    *,
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    if RUNTIME_SCHEMA_POLICY != "explicit-v1":
        raise ReleaseError("preflight", "canonical_bridge_policy_invalid")
    oracle = deploy_oracle_application(
        root, target, release, install_mode="install-bridge", runner=runner
    )
    try:
        schema = canonical_schema_status(target, runner=_without_application_secrets(runner))
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        raise ReleaseError("oracle_schema", "canonical_schema_status_failed") from error
    if schema["application_id"] != APPLICATION_ID:
        raise ReleaseError("oracle_schema", "canonical_application_id_mismatch")
    if schema["schema_policy"] != RUNTIME_SCHEMA_POLICY or schema["compatible"] is not True:
        raise ReleaseError("oracle_schema", "canonical_bridge_incompatible")
    if schema["schema_version"] >= SCHEMA_VERSION:
        raise ReleaseError("oracle_schema", "canonical_bridge_not_required")
    return {"oracle": oracle, "canonical": schema, "bridge_ready": True}


def migrate_oracle_canonical(
    target: OracleTarget,
    *,
    expected_current: str,
    expected_previous: str,
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    safe_runner = _without_application_secrets(runner)
    oracle = status(target, runner=safe_runner)
    if oracle.get("current_release") != expected_current:
        raise ReleaseError("oracle_schema", "canonical_current_release_changed")
    if oracle.get("previous_release") != expected_previous:
        raise ReleaseError("oracle_schema", "canonical_previous_release_changed")
    migration: dict[str, Any] | None = None
    migration_error: BaseException | None = None
    for attempt in range(2):
        try:
            migration = migrate_canonical_schema(
                target,
                expected_current=expected_current,
                expected_previous=expected_previous,
                runner=safe_runner,
            )
        except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
            migration_error = error
            retryable = (
                isinstance(error, OSError | subprocess.TimeoutExpired | RuntimeError)
                or isinstance(error, subprocess.CalledProcessError)
                and error.returncode == 255
            )
            if attempt == 0 and retryable:
                continue
            break
        else:
            break
    try:
        schema = canonical_schema_status(target, runner=safe_runner)
        _require_oracle_deploy_ready(schema)
    except ReleaseError:
        raise
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
        raise ReleaseError("oracle_schema", "canonical_schema_migration_failed") from (
            migration_error or error
        )
    if migration is None:
        raise ReleaseError("oracle_schema", "canonical_schema_migration_ambiguous") from (
            migration_error
        )
    return {"oracle": oracle, "migration": migration, "canonical": schema}


def deploy_all(
    root: Path,
    target: OracleTarget,
    release: str,
    *,
    runner: CommandRunner = subprocess.run,
    smoke: SmokeRunner = _machine_smoke,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    safe_runner = _without_application_secrets(runner)
    oracle_before = _oracle_status_for_release(root, target, release, runner=safe_runner)
    previous_release = oracle_before.get("current_release")
    cloudflare = deploy_cloudflare(root, release, runner=runner, smoke=smoke, sleep=sleep)
    try:
        oracle = deploy_oracle_application(root, target, release, runner=runner)
    except Exception as error:
        try:
            observed_oracle = status(target, runner=safe_runner)
        except Exception as status_error:
            raise ReleaseError(
                "oracle_deploy", "oracle_install_ambiguous_no_automatic_rollback"
            ) from status_error
        observed_release = observed_oracle.get("current_release")
        if observed_release == release:
            oracle = observed_oracle
        elif observed_release != previous_release:
            raise ReleaseError(
                "oracle_deploy", "oracle_install_ambiguous_no_automatic_rollback"
            ) from error
        else:
            try:
                _rollback_cloudflare(
                    root / "edge",
                    str(cloudflare["previous"]["version_id"]),
                    f"Automatic rollback after failed Oracle install for git:{release}",
                    runner=runner,
                    sleep=sleep,
                    expected_message=f"git:{release}",
                    expected_active=cloudflare["deployed"],
                )
            except Exception as rollback_error:
                raise ReleaseError(
                    "oracle_deploy", "oracle_install_failed_worker_rollback_failed"
                ) from rollback_error
            raise ReleaseError(
                "oracle_deploy", "oracle_install_failed_worker_rolled_back"
            ) from error
    try:
        deployed_version = str(cloudflare["deployed"]["version_id"])
        final_smoke = smoke(release, deployed_version)
        _validate_smoke_identity(final_smoke, release, deployed_version)
    except Exception as error:
        try:
            observed_oracle = status(target, runner=safe_runner)
        except Exception as status_error:
            raise ReleaseError(
                "final_smoke", "final_smoke_failed_status_ambiguous_no_automatic_rollback"
            ) from status_error
        observed_release = observed_oracle.get("current_release")
        if observed_release == release:
            if not isinstance(previous_release, str):
                raise ReleaseError(
                    "final_smoke", "final_smoke_failed_no_previous_no_automatic_rollback"
                ) from error
            if previous_release != release:
                try:
                    rollback(
                        target,
                        expected_current=release,
                        target_release=previous_release,
                        runner=safe_runner,
                    )
                    observed_oracle = status(target, runner=safe_runner)
                except Exception as rollback_error:
                    raise ReleaseError(
                        "final_smoke", "final_smoke_failed_oracle_rollback_failed"
                    ) from rollback_error
                if observed_oracle.get("current_release") != previous_release:
                    raise ReleaseError(
                        "final_smoke", "final_smoke_failed_oracle_rollback_mismatch"
                    ) from error
        elif observed_release != previous_release:
            raise ReleaseError(
                "final_smoke", "final_smoke_failed_external_oracle_change"
            ) from error

        try:
            _rollback_cloudflare(
                root / "edge",
                str(cloudflare["previous"]["version_id"]),
                f"Automatic rollback after failed final smoke for git:{release}",
                runner=runner,
                sleep=sleep,
                expected_message=f"git:{release}",
                expected_active=cloudflare["deployed"],
            )
        except Exception as worker_error:
            try:
                active_after_failure = _cloudflare_deployment(root / "edge", runner)
            except Exception as active_error:
                raise ReleaseError(
                    "final_smoke", "final_smoke_failed_worker_state_ambiguous"
                ) from active_error
            if active_after_failure.get("version_id") == cloudflare["previous"].get("version_id"):
                pass
            elif (
                isinstance(previous_release, str)
                and previous_release != release
                and active_after_failure.get("version_id") == deployed_version
            ):
                try:
                    rollback(
                        target,
                        expected_current=str(previous_release),
                        target_release=release,
                        runner=safe_runner,
                    )
                    restored_oracle = status(target, runner=safe_runner)
                    if restored_oracle.get("current_release") != release:
                        raise ReleaseError("oracle_rollback", "oracle_restore_mismatch")
                except Exception as restore_error:
                    raise ReleaseError(
                        "final_smoke",
                        "final_smoke_failed_worker_rollback_failed_oracle_restore_failed",
                    ) from restore_error
                raise ReleaseError(
                    "final_smoke",
                    "final_smoke_failed_worker_rollback_failed_oracle_restored",
                ) from worker_error
            elif active_after_failure.get("version_id") == deployed_version:
                raise ReleaseError(
                    "final_smoke", "final_smoke_failed_worker_rollback_failed"
                ) from worker_error
            else:
                raise ReleaseError(
                    "final_smoke", "final_smoke_failed_external_worker_change"
                ) from worker_error
        raise ReleaseError("final_smoke", "final_smoke_failed_coordinated_rollback") from error
    return {
        "cloudflare": cloudflare,
        "oracle_before": oracle_before,
        "oracle": oracle,
        "final_smoke": final_smoke,
    }


def coordinated_rollback(
    root: Path,
    target: OracleTarget,
    worker_version: str,
    oracle_release: str,
    *,
    runner: CommandRunner = subprocess.run,
    smoke: SmokeRunner = _machine_smoke,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    normalized_worker_version = _canonical_uuid(worker_version)
    if normalized_worker_version is None:
        raise ValueError("Worker version ID is invalid")
    if _GIT_SHA.fullmatch(oracle_release) is None:
        raise ValueError("Oracle release identity is invalid")

    edge = root / "edge"
    safe_runner = _without_application_secrets(runner)
    active = _cloudflare_deployment(edge, runner)
    target_version = _cloudflare_version(edge, normalized_worker_version, runner)
    oracle_before = status(target, runner=safe_runner)
    current_release = oracle_before.get("current_release")
    if not isinstance(current_release, str) or _GIT_SHA.fullmatch(current_release) is None:
        raise ReleaseError("rollback_preflight", "oracle_current_release_invalid")
    _require_worker_release(
        target_version,
        oracle_release,
        code="worker_oracle_target_mismatch",
    )
    if current_release != oracle_release:
        active_version = (
            target_version
            if active["version_id"] == normalized_worker_version
            else _cloudflare_version(edge, str(active["version_id"]), runner)
        )
        _require_worker_release(
            active_version,
            current_release,
            code="active_worker_oracle_mismatch",
        )
    guarded_active = _cloudflare_deployment(edge, runner)
    if any(
        guarded_active.get(name) != active.get(name) for name in ("deployment_id", "version_id")
    ):
        raise ReleaseError("rollback_preflight", "active_worker_changed")

    oracle = oracle_before
    oracle_changed = current_release != oracle_release
    if oracle_changed:
        try:
            rollback(
                target,
                expected_current=current_release,
                target_release=oracle_release,
                runner=safe_runner,
            )
        except Exception as error:
            try:
                oracle = status(target, runner=safe_runner)
            except Exception as status_error:
                raise ReleaseError(
                    "oracle_rollback", "oracle_rollback_state_ambiguous"
                ) from status_error
            observed_release = oracle.get("current_release")
            if observed_release == current_release:
                raise ReleaseError("oracle_rollback", "oracle_rollback_failed") from error
            if observed_release != oracle_release:
                raise ReleaseError("oracle_rollback", "oracle_rollback_external_change") from error
        else:
            oracle = status(target, runner=safe_runner)
            if oracle.get("current_release") != oracle_release:
                raise ReleaseError("oracle_rollback", "oracle_rollback_mismatch")
    try:
        worker = _rollback_cloudflare(
            edge,
            normalized_worker_version,
            f"Explicit coordinated rollback to git:{oracle_release}",
            runner=runner,
            sleep=sleep,
            expected_active=active,
        )
    except Exception as error:
        try:
            active_after_failure = _cloudflare_deployment(edge, runner)
        except Exception as active_error:
            raise ReleaseError(
                "cloudflare_rollback", "worker_rollback_state_ambiguous"
            ) from active_error
        if active_after_failure.get("version_id") == normalized_worker_version:
            worker = active_after_failure
        elif active_after_failure.get("version_id") != active.get("version_id"):
            raise ReleaseError("cloudflare_rollback", "worker_rollback_external_change") from error
        elif not oracle_changed:
            raise ReleaseError("cloudflare_rollback", "worker_rollback_failed") from error
        else:
            try:
                rollback(
                    target,
                    expected_current=oracle_release,
                    target_release=current_release,
                    runner=safe_runner,
                )
                restored = status(target, runner=safe_runner)
                if restored.get("current_release") != current_release:
                    raise ReleaseError("oracle_rollback", "oracle_restore_mismatch")
            except Exception as restore_error:
                raise ReleaseError(
                    "cloudflare_rollback", "worker_rollback_failed_oracle_restore_failed"
                ) from restore_error
            raise ReleaseError(
                "cloudflare_rollback", "worker_rollback_failed_oracle_restored"
            ) from error

    smoke_report = smoke(oracle_release, normalized_worker_version)
    _validate_smoke_identity(smoke_report, oracle_release, normalized_worker_version)
    return {
        "oracle_before": oracle_before,
        "active_worker_before": active,
        "target_worker": target_version,
        "oracle": oracle,
        "cloudflare": worker,
        "smoke": smoke_report,
    }


def release_status(
    root: Path,
    target: OracleTarget | None,
    *,
    runner: CommandRunner = subprocess.run,
) -> dict[str, Any]:
    safe_runner = _without_application_secrets(runner)
    head = safe_runner(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    migration_result = runner(
        _node_command(
            runner,
            "npx",
            "wrangler",
            "d1",
            "migrations",
            "list",
            _D1_DATABASE,
            "--remote",
        ),
        cwd=root / "edge",
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        text=True,
        env=_cloudflare_environment(),
    )
    return {
        "release": head,
        "cloudflare": {
            "deployment": _cloudflare_deployment(root / "edge", runner),
            "pending_migrations": sorted(set(_MIGRATION.findall(migration_result.stdout))),
        },
        "oracle": (
            _oracle_status_for_release(root, target, head, runner=safe_runner)
            if target is not None
            else None
        ),
    }


def _write_report(root: Path, report: dict[str, Any]) -> Path:
    directory = root / "artifacts" / "releases"
    directory.mkdir(parents=True, exist_ok=True)
    release = str(report.get("release", "unknown"))[:12]
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    path = directory / f"{timestamp}-{release}-{report['mode']}.json"
    partial = path.with_suffix(f"{path.suffix}.partial")
    partial.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(partial, path)
    return path


def _target_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host")
    parser.add_argument("--user")
    parser.add_argument("--key", type=Path)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Release ReDSTM across Cloudflare and Oracle.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("preflight")
    status_parser = commands.add_parser("status")
    _target_arguments(status_parser)
    commands.add_parser("deploy-cloudflare")
    deploy_parser = commands.add_parser("deploy")
    _target_arguments(deploy_parser)
    bridge_parser = commands.add_parser("deploy-oracle-bridge")
    _target_arguments(bridge_parser)
    migration_parser = commands.add_parser("migrate-canonical")
    _target_arguments(migration_parser)
    migration_parser.add_argument("--expected-current", required=True)
    migration_parser.add_argument("--expected-previous", required=True)
    rollback_parser = commands.add_parser("rollback")
    _target_arguments(rollback_parser)
    rollback_parser.add_argument("--worker-version", required=True)
    rollback_parser.add_argument("--oracle-release", required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    if args.command == "status":
        target = (
            _target(args.host, args.user, args.key)
            if args.host or args.key or os.environ.get("REDSTM_ORACLE_HOST")
            else None
        )
        print(json.dumps(release_status(root, target), indent=2, sort_keys=True))
        return 0

    started_at = _timestamp()
    release_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=False,
        stdout=subprocess.PIPE,
        text=True,
        env=_ci_environment(),
    )
    release = release_result.stdout.strip() if release_result.returncode == 0 else "unknown"
    mode = args.command
    try:
        lock_path = root / ".data" / "release.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(lock_path, timeout=0):
            if args.command == "rollback":
                target = _target(args.host, args.user, args.key)
                ControlClient.from_environment()
                result = coordinated_rollback(
                    root,
                    target,
                    args.worker_version,
                    args.oracle_release,
                )
            else:
                deploy_target: OracleTarget | None = None
                if args.command == "deploy-cloudflare":
                    ControlClient.from_environment()
                elif args.command in {"deploy", "deploy-oracle-bridge", "migrate-canonical"}:
                    if args.command == "deploy":
                        ControlClient.from_environment()
                    deploy_target = _target(args.host, args.user, args.key)
                with release_preflight(root) as (release_root, release):
                    if args.command == "preflight":
                        result = {"release": release}
                    elif args.command == "deploy-cloudflare":
                        result = deploy_cloudflare(release_root, release)
                    elif args.command == "deploy-oracle-bridge":
                        if deploy_target is None:
                            raise ReleaseError("preflight", "oracle_target_missing")
                        result = deploy_oracle_bridge(
                            release_root,
                            deploy_target,
                            release,
                        )
                    elif args.command == "migrate-canonical":
                        if deploy_target is None:
                            raise ReleaseError("preflight", "oracle_target_missing")
                        if release != args.expected_current:
                            raise ReleaseError("preflight", "canonical_migration_source_mismatch")
                        result = migrate_oracle_canonical(
                            deploy_target,
                            expected_current=args.expected_current,
                            expected_previous=args.expected_previous,
                        )
                    else:
                        if deploy_target is None:
                            raise ReleaseError("preflight", "oracle_target_missing")
                        try:
                            schema = canonical_schema_status(deploy_target)
                        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
                            raise ReleaseError(
                                "preflight", "canonical_schema_status_failed"
                            ) from error
                        _require_oracle_deploy_ready(schema)
                        result = deploy_all(
                            release_root,
                            deploy_target,
                            release,
                        )
        report = {
            "schema_version": 1,
            "ok": True,
            "mode": mode,
            "release": release,
            "started_at": started_at,
            "finished_at": _timestamp(),
            "result": result,
        }
    except Timeout:
        report = {
            "schema_version": 1,
            "ok": False,
            "mode": mode,
            "release": release,
            "started_at": started_at,
            "finished_at": _timestamp(),
            "failure": {"stage": "preflight", "code": "release_busy"},
        }
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        report = {
            "schema_version": 1,
            "ok": False,
            "mode": mode,
            "release": release,
            "started_at": started_at,
            "finished_at": _timestamp(),
            "failure": {
                "stage": error.stage if isinstance(error, ReleaseError) else "release",
                "code": error.code if isinstance(error, ReleaseError) else type(error).__name__,
            },
        }
    path = _write_report(root, report)
    print(json.dumps({**report, "report": str(path)}, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
