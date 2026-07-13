from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

MAX_OUTBOX_BYTES = 10 * 1024 * 1024
MAX_OUTBOX_EVENTS = 10_000

_ACTIONS = {
    "sync-now",
    "full-catalog",
    "full-content",
    "retry-batch",
    "publish-if-changed",
    "pause-after-current",
    "resume-schedule",
}
_TERMINAL_STATES = {"succeeded", "partial", "failed"}
_PRIORITIES = {
    "event_batch": 50,
    "board_status": 60,
    "frontier_failures": 60,
    "heartbeat": 80,
    "run_start": 100,
    "run_finish": 100,
    "command_finish": 100,
}
_PATHS = {
    "heartbeat": re.compile(r"/api/v1/runner/heartbeat"),
    "board_status": re.compile(r"/api/v1/runner/boards/status"),
    "frontier_failures": re.compile(r"/api/v1/runner/frontier-failures"),
    "run_start": re.compile(r"/api/v1/runner/runs"),
    "event_batch": re.compile(r"/api/v1/runner/runs/[a-zA-Z0-9_.:-]{1,128}/events:batch"),
    "run_finish": re.compile(r"/api/v1/runner/runs/[a-zA-Z0-9_.:-]{1,128}/finish"),
    "command_finish": re.compile(r"/api/v1/runner/commands/[0-9a-f-]{36}/finish"),
}
_FORBIDDEN_KEYS = {
    "body",
    "cookie",
    "credential",
    "hostname",
    "ip",
    "password",
    "path",
    "secret",
    "title",
    "token",
    "url",
}
_LOCAL_PATH = re.compile(r"(?:[a-zA-Z]:\\|/(?:etc|home|opt|srv)/)")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS command_ledger (
    command_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'succeeded', 'partial', 'failed')),
    claimed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    run_id TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    args_json TEXT NOT NULL DEFAULT '{}',
    reported_at TEXT,
    report_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (report_state IN ('pending', 'delivered', 'permanently_rejected'))
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    dedupe_key TEXT UNIQUE,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
    event_count INTEGER NOT NULL CHECK (event_count > 0),
    priority INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS control_rejections (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rejected_count INTEGER NOT NULL CHECK (rejected_count > 0),
    last_code TEXT NOT NULL,
    last_rejected_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_due_idx
ON outbox(next_attempt_at, priority DESC, id);
"""


def _timestamp(now: datetime | None = None) -> str:
    return (
        (now or datetime.now(UTC))
        .astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _safe_payload(value: Any) -> bool:
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and key.lower() not in _FORBIDDEN_KEYS and _safe_payload(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return all(_safe_payload(item) for item in value)
    return not isinstance(value, str) or _LOCAL_PATH.search(value) is None


class OutboxFullError(RuntimeError):
    pass


class ControlStore:
    def __init__(
        self,
        path: Path,
        *,
        max_bytes: int = MAX_OUTBOX_BYTES,
        max_events: int = MAX_OUTBOX_EVENTS,
    ) -> None:
        if max_bytes < 1 or max_events < 1:
            raise ValueError("outbox limits must be positive")
        self.path = path.expanduser().resolve()
        self.max_bytes = max_bytes
        self.max_events = max_events
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._transaction() as connection:
            connection.executescript(_SCHEMA)
            columns = {
                str(row["name"]) for row in connection.execute("PRAGMA table_info(command_ledger)")
            }
            if "reported_at" not in columns:
                connection.execute("ALTER TABLE command_ledger ADD COLUMN reported_at TEXT")
            if "report_state" not in columns:
                connection.execute(
                    "ALTER TABLE command_ledger ADD COLUMN report_state TEXT NOT NULL "
                    "DEFAULT 'pending' CHECK (report_state IN "
                    "('pending', 'delivered', 'permanently_rejected'))"
                )
            if "args_json" not in columns:
                connection.execute(
                    "ALTER TABLE command_ledger ADD COLUMN args_json TEXT NOT NULL DEFAULT '{}'"
                )
                connection.execute(
                    "UPDATE command_ledger SET report_state = 'delivered' "
                    "WHERE reported_at IS NOT NULL"
                )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        # sqlite3's connection context manager only wraps a transaction; the runner is a
        # long-lived poller, so every connection must be closed or file descriptors leak.
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def record_claim(
        self,
        command_id: str,
        action: str,
        *,
        args: dict[str, Any] | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        try:
            canonical_id = str(UUID(command_id))
        except ValueError as error:
            raise ValueError("command id must be a UUID") from error
        if canonical_id != command_id.lower():
            raise ValueError("command id must be a canonical UUID")
        if action not in _ACTIONS:
            raise ValueError("command action is not allowed")
        timestamp = _timestamp(now)
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO command_ledger (
                    command_id, action, state, claimed_at, updated_at, args_json
                ) VALUES (?, ?, 'claimed', ?, ?, ?) ON CONFLICT(command_id) DO NOTHING
                """,
                (
                    command_id,
                    action,
                    timestamp,
                    timestamp,
                    json.dumps(args or {}, separators=(",", ":"), sort_keys=True),
                ),
            )
            row = connection.execute(
                "SELECT * FROM command_ledger WHERE command_id = ?", (command_id,)
            ).fetchone()
        assert row is not None
        if row["action"] != action:
            raise ValueError("command replay action mismatch")
        result = dict(row)
        result["args"] = json.loads(result.get("args_json", "{}"))
        return result

    def begin_command(
        self, command_id: str, *, run_id: str | None = None, now: datetime | None = None
    ) -> bool:
        with self._transaction() as connection:
            result = connection.execute(
                """
                UPDATE command_ledger SET state = 'running', run_id = ?, updated_at = ?
                WHERE command_id = ? AND state = 'claimed'
                """,
                (run_id, _timestamp(now), command_id),
            )
            began = result.rowcount == 1
        return began

    def finish_command(
        self,
        command_id: str,
        state: str,
        safe_code: str | None,
        *,
        result_payload: dict[str, Any] | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        if state not in _TERMINAL_STATES:
            raise ValueError("command terminal state is invalid")
        if safe_code is not None and not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", safe_code):
            raise ValueError("command result code is invalid")
        if result_payload is not None and not _safe_payload(result_payload):
            raise ValueError("command result contains a forbidden field or local path")
        result: dict[str, Any] = {"code": safe_code}
        if result_payload is not None:
            result["payload"] = result_payload
        result_json = json.dumps(result, separators=(",", ":"), sort_keys=True)
        if len(result_json.encode()) > 16 * 1024:
            raise ValueError("command result is too large")
        with self._transaction() as connection:
            connection.execute(
                """
                UPDATE command_ledger
                SET state = ?, result_json = ?, updated_at = ?, reported_at = NULL,
                    report_state = 'pending'
                WHERE command_id = ? AND state IN ('claimed', 'running')
                """,
                (state, result_json, _timestamp(now), command_id),
            )
            row = connection.execute(
                "SELECT * FROM command_ledger WHERE command_id = ?", (command_id,)
            ).fetchone()
        if row is None or row["state"] != state:
            raise ValueError("command cannot transition to terminal state")
        return dict(row)

    def pending_commands(self, *, limit: int = 50) -> list[dict[str, Any]]:
        if limit < 1 or limit > 50:
            raise ValueError("command page limit must be between 1 and 50")
        with self._transaction() as connection:
            rows = connection.execute(
                """
                SELECT * FROM command_ledger
                WHERE reported_at IS NULL AND report_state = 'pending'
                ORDER BY claimed_at, command_id LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_reported(self, command_id: str, *, now: datetime | None = None) -> None:
        with self._transaction() as connection:
            result = connection.execute(
                """
                UPDATE command_ledger SET reported_at = ?, report_state = 'delivered'
                WHERE command_id = ? AND state IN ('succeeded', 'partial', 'failed')
                  AND report_state = 'pending'
                """,
                (_timestamp(now), command_id),
            )
            updated = result.rowcount == 1
            row = connection.execute(
                "SELECT report_state FROM command_ledger WHERE command_id = ?", (command_id,)
            ).fetchone()
        if not updated and (row is None or row["report_state"] != "delivered"):
            raise ValueError("only terminal commands can be marked reported")

    def mark_report_rejected(self, command_id: str, *, now: datetime | None = None) -> None:
        with self._transaction() as connection:
            result = connection.execute(
                """
                UPDATE command_ledger
                SET reported_at = ?, report_state = 'permanently_rejected'
                WHERE command_id = ? AND state IN ('succeeded', 'partial', 'failed')
                  AND report_state = 'pending'
                """,
                (_timestamp(now), command_id),
            )
            updated = result.rowcount == 1
            row = connection.execute(
                "SELECT report_state FROM command_ledger WHERE command_id = ?", (command_id,)
            ).fetchone()
        if not updated and (row is None or row["report_state"] != "permanently_rejected"):
            raise ValueError("only pending terminal reports can be marked rejected")

    def command(self, command_id: str) -> dict[str, Any] | None:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM command_ledger WHERE command_id = ?", (command_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def enqueue(
        self,
        kind: str,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str,
        *,
        now: datetime | None = None,
    ) -> int:
        if kind not in _PRIORITIES or _PATHS[kind].fullmatch(path) is None:
            raise ValueError("outbox route is not allowed")
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{8,128}", idempotency_key) is None:
            raise ValueError("outbox idempotency key is invalid")
        if not _safe_payload(payload):
            raise ValueError("outbox payload contains a forbidden field or local path")
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        payload_bytes = len(encoded.encode("utf-8"))
        event_count = len(payload.get("events", [])) if kind == "event_batch" else 1
        if event_count < 1 or payload_bytes > 64 * 1024:
            raise ValueError("outbox payload is empty or too large")
        dedupe_key = self._dedupe_key(kind, payload)
        priority = _PRIORITIES[kind]
        with self._transaction() as connection:
            connection.execute("BEGIN IMMEDIATE")
            duplicate = connection.execute(
                "SELECT id FROM outbox WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if duplicate is not None:
                return int(duplicate["id"])
            if dedupe_key is not None:
                connection.execute("DELETE FROM outbox WHERE dedupe_key = ?", (dedupe_key,))
            self._make_room(connection, payload_bytes, event_count, priority)
            cursor = connection.execute(
                """
                INSERT INTO outbox (
                    idempotency_key, dedupe_key, kind, path, payload_json, payload_bytes,
                    event_count, priority, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    idempotency_key,
                    dedupe_key,
                    kind,
                    path,
                    encoded,
                    payload_bytes,
                    event_count,
                    priority,
                    _timestamp(now),
                ),
            )
            item_id = cursor.lastrowid
        if item_id is None:
            raise RuntimeError("outbox insert did not return an id")
        return item_id

    @staticmethod
    def _dedupe_key(kind: str, payload: dict[str, Any]) -> str | None:
        if kind == "heartbeat":
            return "heartbeat"
        if kind == "board_status" and isinstance(payload.get("board_id"), str):
            return f"board:{payload['board_id']}"
        return None

    def _make_room(
        self, connection: sqlite3.Connection, payload_bytes: int, event_count: int, priority: int
    ) -> None:
        if payload_bytes > self.max_bytes or event_count > self.max_events:
            raise OutboxFullError("outbox item exceeds its bounded capacity")
        while True:
            totals = connection.execute(
                "SELECT COALESCE(SUM(payload_bytes), 0) AS bytes, "
                "COALESCE(SUM(event_count), 0) AS events FROM outbox"
            ).fetchone()
            assert totals is not None
            if (
                int(totals["bytes"]) + payload_bytes <= self.max_bytes
                and int(totals["events"]) + event_count <= self.max_events
            ):
                return
            candidate = connection.execute(
                """
                SELECT id FROM outbox WHERE priority < 100 AND priority <= ?
                ORDER BY priority, id LIMIT 1
                """,
                (priority,),
            ).fetchone()
            if candidate is None:
                raise OutboxFullError("outbox is full of protected terminal events")
            connection.execute("DELETE FROM outbox WHERE id = ?", (candidate["id"],))

    def pending(self, *, limit: int = 50, now: datetime | None = None) -> list[dict[str, Any]]:
        if limit < 1 or limit > 50:
            raise ValueError("outbox page limit must be between 1 and 50")
        due_at = _timestamp(now)
        with self._transaction() as connection:
            rows = connection.execute(
                """
                SELECT * FROM outbox
                ORDER BY id LIMIT ?
                """,
                (limit,),
            ).fetchall()
        pending = []
        for row in rows:
            if row["next_attempt_at"] is not None and str(row["next_attempt_at"]) > due_at:
                break
            pending.append(dict(row))
        return pending

    def acknowledge(self, item_id: int) -> None:
        with self._transaction() as connection:
            connection.execute("DELETE FROM outbox WHERE id = ?", (item_id,))

    def reject(
        self,
        item_id: int,
        code: str,
        *,
        now: datetime | None = None,
    ) -> None:
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", code) is None:
            raise ValueError("control rejection code is invalid")
        with self._transaction() as connection:
            connection.execute("BEGIN IMMEDIATE")
            deleted = connection.execute("DELETE FROM outbox WHERE id = ?", (item_id,))
            if deleted.rowcount != 1:
                raise ValueError("outbox rejection item is missing")
            connection.execute(
                """
                INSERT INTO control_rejections (
                    id, rejected_count, last_code, last_rejected_at
                ) VALUES (1, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    rejected_count = control_rejections.rejected_count + 1,
                    last_code = excluded.last_code,
                    last_rejected_at = excluded.last_rejected_at
                """,
                (code, _timestamp(now)),
            )

    def record_rejection(self, code: str, *, now: datetime | None = None) -> None:
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", code) is None:
            raise ValueError("control rejection code is invalid")
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO control_rejections (
                    id, rejected_count, last_code, last_rejected_at
                ) VALUES (1, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    rejected_count = control_rejections.rejected_count + 1,
                    last_code = excluded.last_code,
                    last_rejected_at = excluded.last_rejected_at
                """,
                (code, _timestamp(now)),
            )

    def rejection(self) -> dict[str, Any] | None:
        with self._transaction() as connection:
            row = connection.execute("SELECT * FROM control_rejections WHERE id = 1").fetchone()
        return dict(row) if row is not None else None

    def defer(self, item_id: int, next_attempt_at: datetime) -> None:
        with self._transaction() as connection:
            connection.execute(
                "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
                (_timestamp(next_attempt_at), item_id),
            )

    def stats(self) -> dict[str, int]:
        with self._transaction() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS rows, COALESCE(SUM(payload_bytes), 0) AS bytes,
                       COALESCE(SUM(event_count), 0) AS events FROM outbox
                """
            ).fetchone()
        assert row is not None
        return {key: int(row[key]) for key in ("rows", "bytes", "events")}
