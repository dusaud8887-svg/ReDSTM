"""Operational status of the text archive, published next to its releases (docs/18).

The text services have R2 write access to their own bucket but no Access credentials, so
they cannot report into the TypeMoon control plane (D1). Instead the publisher writes one
small, mutable ``published/status/text.json`` after each run; the Worker serves it at
``/api/v1/text/status`` and ``/ops`` shows it in its own section. Nothing here is added to
or summed with the TypeMoon counters.

The status says what is known and when: PC deliveries (received, rejected, waiting in the
drop), the Oracle collector's queue and per-source cooldowns, and what is published.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.text_archive.runtime import DEFERRALS_PATH, operation_window

_STATUS_KEY = "published/status/text.json"
_TEXT_BATCH = re.compile(r"\d{8}T\d{6}Z-pc-[a-f0-9]{8}\Z")
_MEDIA_BATCH = re.compile(r"\d{8}T\d{6}Z-media-[a-f0-9]{8}\Z")
_ERROR_CHARS = 160


def _iso(epoch: int | float | None) -> str | None:
    if not epoch:
        return None
    return (
        datetime.fromtimestamp(float(epoch), UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _table_exists(db: sqlite3.Connection, name: str) -> bool:
    return bool(
        db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    )


def _counts(db: sqlite3.Connection, query: str, *args: object) -> dict[str, int]:
    return {str(key): int(value) for key, value in db.execute(query, args)}


def _drop_state(inbox_root: Path) -> dict[str, int]:
    """Committed batches still waiting in the 2 GiB drop, and terminal rejections."""
    drop, receipts = inbox_root / "drop", inbox_root / "receipts"
    waiting = {"text": 0, "media": 0}
    rejected = {"text": 0, "media": 0}
    if drop.is_dir() and not drop.is_symlink():
        for entry in drop.iterdir():
            lane = (
                "text"
                if _TEXT_BATCH.fullmatch(entry.name)
                else "media"
                if _MEDIA_BATCH.fullmatch(entry.name)
                else None
            )
            if lane is None or not (entry / "ready.json").is_file():
                continue
            status_path = receipts / f"{entry.name}.status.json"
            if status_path.exists() and _batch_status(status_path) == "rejected":
                # A receipt_repair sidecar is not a rejection.
                rejected[lane] += 1
            elif not (receipts / f"{entry.name}.json").exists():
                waiting[lane] += 1
    return {
        "text_waiting": waiting["text"],
        "media_waiting": waiting["media"],
        "text_rejected_in_drop": rejected["text"],
        "media_rejected_in_drop": rejected["media"],
    }


def _batch_status(path: Path) -> str:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        # Unreadable status: count it as before rather than hide a rejection.
        return "rejected"
    status = value.get("batch_status") if isinstance(value, dict) else None
    return status if isinstance(status, str) else "rejected"


def _deferrals(path: Path) -> dict[str, dict[str, str]]:
    """Each step's last deferral (runtime.record_deferral), reduced to known short fields."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(step)[:32]: {"reason": str(entry["reason"])[:64], "at": str(entry["at"])[:32]}
        for step, entry in raw.items()
        if isinstance(entry, dict) and "reason" in entry and "at" in entry
    }


def _import_retries(roots: tuple[Path, ...], clock: float) -> dict[str, Any]:
    """Batches waiting out an import backoff, and why (attempts.py records, no batch IDs)."""
    waiting = 0
    reasons: dict[str, int] = {}
    for root in roots:
        for path in root.glob("*.json") if root.is_dir() else ():
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                active = float(record["next_at"]) > clock
                reason = str(record.get("reason") or "")[:_ERROR_CHARS]
            except OSError, ValueError, KeyError, TypeError:
                continue
            if active:
                waiting += 1
                reasons[reason] = reasons.get(reason, 0) + 1
    top = sorted(reasons.items(), key=lambda item: (-item[1], item[0]))[:3]
    return {"backing_off": waiting, "reasons": dict(top)}


def build_status(
    db_path: Path,
    inbox_root: Path,
    *,
    now: float | None = None,
    deferrals_path: Path = DEFERRALS_PATH,
    attempts_roots: tuple[Path, ...] = (
        Path("/srv/redstm-text/import-attempts"),
        Path("/srv/redstm-text/media-attempts"),
    ),
) -> dict[str, Any]:
    """A bounded summary; no bodies, titles, paths or credentials."""
    generated = datetime.now(UTC) if now is None else datetime.fromtimestamp(now, UTC)
    status: dict[str, Any] = {
        "schema": 1,
        "generated_at": generated.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "drop": _drop_state(inbox_root),
        "deferrals": _deferrals(deferrals_path),
        # Repeated import failures for /ops (2026-10-09 review: imported → published lag,
        # the oldest waiting batch and repeated failure reasons were not visible).
        "imports": _import_retries(attempts_roots, generated.timestamp()),
    }
    if not db_path.is_file():
        status["database"] = "missing"
        return status
    db = sqlite3.connect(f"{db_path.absolute().as_uri()}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        lanes: dict[str, Any] = {}
        for lane in ("novel", "arcalive", "manual", "tuna"):
            row = db.execute(
                """SELECT COUNT(*) AS items,MAX(imported_at) AS last_imported_at,
                          SUM(p.key IS NOT NULL) AS published,
                          MAX(p.verified_at) AS last_published_at
                   FROM text_archive_items i LEFT JOIN text_archive_publications p
                     ON p.key='item:'||i.identity AND p.sha256=i.content_sha256
                   WHERE i.lane=?""",
                (lane,),
            ).fetchone()
            lanes[lane] = {
                "items": int(row["items"] or 0),
                "published": int(row["published"] or 0),
                "last_imported_at": row["last_imported_at"],
                "last_published_at": row["last_published_at"],
            }
        status["lanes"] = lanes
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_tuna_threads'"
        ).fetchone():
            status["tuna"] = {
                "threads": {
                    str(row[0]): int(row[1])
                    for row in db.execute(
                        "SELECT status,COUNT(*) FROM text_tuna_threads GROUP BY status"
                    )
                },
                "pending_threads": int(
                    db.execute(
                        "SELECT COUNT(*) FROM text_tuna_threads "
                        "WHERE status='active' AND next_seq<response_count"
                    ).fetchone()[0]
                ),
            }
        pc = db.execute(
            """SELECT COUNT(*) AS batches,MAX(imported_at) AS last_batch_at,
                      SUM(revision=2) AS published_batches,
                      MIN(CASE WHEN revision=1 THEN imported_at END) AS oldest_unpublished_at
               FROM text_archive_batches"""
        ).fetchone()
        status["pc"] = {
            "batches": int(pc["batches"] or 0),
            "published_batches": int(pc["published_batches"] or 0),
            "last_batch_at": pc["last_batch_at"],
            # Imported (receipt revision 1) but not yet published: the oldest shows the lag.
            "oldest_unpublished_at": pc["oldest_unpublished_at"],
            "held_conflicts": int(
                db.execute(
                    "SELECT COUNT(*) FROM text_archive_conflicts WHERE batch_id NOT LIKE 'oracle:%'"
                ).fetchone()[0]
            ),
        }
        if _table_exists(db, "text_archive_media"):
            media = db.execute(
                """SELECT COUNT(*) AS images,COALESCE(SUM(bytes),0) AS bytes,
                          MAX(stored_at) AS last_stored_at FROM text_archive_media"""
            ).fetchone()
            status["media"] = {
                "images": int(media["images"] or 0),
                "bytes": int(media["bytes"] or 0),
                "last_stored_at": media["last_stored_at"],
            }
        collector: dict[str, Any] = {
            "chapters": _counts(
                db, "SELECT site||':'||status,COUNT(*) FROM text_novel_chapters GROUP BY 1"
            ),
            "oracle_conflicts": int(
                db.execute(
                    "SELECT COUNT(*) FROM text_archive_conflicts WHERE batch_id LIKE 'oracle:%'"
                ).fetchone()[0]
            ),
        }
        if _table_exists(db, "text_collector_queue"):
            collector["queue"] = _counts(
                db,
                """SELECT source||':'||kind||':'||status,COUNT(*) FROM text_collector_queue
                   GROUP BY 1""",
            )
        if _table_exists(db, "text_collector_hosts"):
            # blocked stores the cooldown's end, or legacy 1. Either is over once it is not
            # still ahead of this report, which is also when rotation resumes.
            clock = generated.timestamp()
            collector["hosts"] = {
                str(row["source"]): {
                    "host": str(row["host"]),
                    "failures": int(row["failures"]),
                    "blocked": int(row["blocked"] or 0) > clock,
                }
                for row in db.execute("SELECT * FROM text_collector_hosts ORDER BY source")
            }
        collector["groups"] = [
            {
                "group": str(row["group_id"]),
                "last_request_at": _iso(row["last_request_at"]),
                "cooldown_until": _iso(row["cooldown_until"]),
                "last_status": row["last_status"],
                "last_source": str(row["last_source"] or ""),
                "last_error": str(row["last_error"] or "")[:_ERROR_CHARS],
            }
            for row in db.execute("SELECT * FROM text_collector_groups ORDER BY group_id")
        ]
        status["collector"] = collector
    finally:
        db.close()
    return status


def publish_status(
    db_path: Path,
    inbox_root: Path,
    build_root: Path,
    *,
    remote: str = "r2text:redstm-text-archive",
    rclone_config: str = "/etc/redstm-text/rclone.conf",
    runner: Any = subprocess.run,
) -> dict[str, Any]:
    """Upload the status document and read it back. Mutable by design (not versioned)."""
    status = build_status(db_path, inbox_root)
    body = (json.dumps(status, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode()
    build_root.mkdir(parents=True, exist_ok=True)
    local = build_root / "status-text.json"
    local.write_bytes(body)
    with operation_window(lock_wait_seconds=30):
        runner(
            ["rclone", "--config", rclone_config, "copyto", str(local), f"{remote}/{_STATUS_KEY}"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        readback = runner(
            ["rclone", "--config", rclone_config, "cat", f"{remote}/{_STATUS_KEY}"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        ).stdout
    if readback != body:
        raise OSError("text status readback mismatch")
    return {"status": "published", "bytes": len(body)}


PC_STATE_NAME = "publish-status.json"


def _novel_snapshot(receipts_root: Path) -> dict[str, Any] | None:
    pointer_path = receipts_root / "availability" / "novel" / "current.json"
    try:
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
        manifest_path = receipts_root / str(pointer["manifest_key"]).removeprefix("receipts/")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        written = pointer_path.stat().st_mtime
    except OSError, ValueError, KeyError, TypeError:
        return None
    return {
        "snapshot_id": str(pointer.get("snapshot_id", ""))[:64],
        "item_count": int(manifest.get("item_count") or 0),
        "written_at": _iso(written),
    }


def build_pc_state(
    db_path: Path,
    receipts_root: Path,
    *,
    outcome: str,
    reason: str = "",
    previous: dict[str, Any] | None = None,
    now: float | None = None,
    deferrals_path: Path = DEFERRALS_PATH,
) -> dict[str, Any]:
    """What Newtomi needs to tell "not published yet" from "lost": the last publish run and
    why it waited, the batches imported but not yet published (revision 1), and the novel
    availability snapshot it reads. Ids, counts and times only."""
    at = datetime.now(UTC) if now is None else datetime.fromtimestamp(now, UTC)
    at_text = at.isoformat(timespec="seconds").replace("+00:00", "Z")
    last_success = (previous or {}).get("last_success_at")
    state: dict[str, Any] = {
        "schema": 1,
        "last_run": {"at": at_text, "outcome": outcome, "reason": reason[:120]},
        "last_success_at": at_text if outcome == "published" else last_success,
        "deferrals": _deferrals(deferrals_path),
        "novel_snapshot": _novel_snapshot(receipts_root),
    }
    if not db_path.is_file():
        state["pending"] = None
        return state
    db = sqlite3.connect(f"{db_path.absolute().as_uri()}?mode=ro", uri=True, timeout=30)
    try:
        count, items = db.execute(
            """SELECT COUNT(*),COALESCE(SUM(json_array_length(receipt_json,'$.items')),0)
               FROM text_archive_batches WHERE revision<2"""
        ).fetchone()
        oldest = db.execute(
            """SELECT batch_id,imported_at FROM text_archive_batches WHERE revision<2
               ORDER BY imported_at,batch_id LIMIT 1"""
        ).fetchone()
    finally:
        db.close()
    state["pending"] = {
        "batches": int(count),
        "items": int(items),
        "oldest_batch_id": oldest[0] if oldest else None,
        "oldest_imported_at": oldest[1] if oldest else None,
    }
    return state


def write_pc_state(
    db_path: Path,
    receipts_root: Path,
    *,
    outcome: str,
    reason: str = "",
    now: float | None = None,
    deferrals_path: Path = DEFERRALS_PATH,
) -> Path:
    """Replace receipts/publish-status.json (read by the inbox SFTP group, 0640) atomically.
    Written on every publisher run, including deferred and failed ones."""
    target = receipts_root / PC_STATE_NAME
    try:
        previous = json.loads(target.read_text(encoding="utf-8"))
    except OSError, ValueError:
        previous = None
    state = build_pc_state(
        db_path,
        receipts_root,
        outcome=outcome,
        reason=reason,
        previous=previous if isinstance(previous, dict) else None,
        now=now,
        deferrals_path=deferrals_path,
    )
    body = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode()
    receipts_root.mkdir(parents=True, exist_ok=True)
    temporary = receipts_root / f".{PC_STATE_NAME}.tmp"
    temporary.write_bytes(body)
    temporary.chmod(0o640)
    if os.name == "posix":
        os.chown(temporary, -1, receipts_root.stat().st_gid)  # type: ignore[attr-defined]
    temporary.replace(target)
    return target
