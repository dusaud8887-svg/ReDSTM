"""Terminal batch status, readable by the inbox account but written only by the importer."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path

_BATCH = re.compile(r"\d{8}T\d{6}Z-pc-[a-f0-9]{8}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")


def write_rejection_status(
    inbox_root: Path, batch_id: str, reason: str, *, dry_run: bool = False
) -> bool:
    if not _BATCH.fullmatch(batch_id):
        raise ValueError("invalid batch id")
    drop = inbox_root / "drop" / batch_id
    receipts = inbox_root / "receipts"
    if any(p.is_symlink() for p in (inbox_root, inbox_root / "drop", drop, receipts)):
        raise ValueError("symlink in status path")
    if not drop.is_dir():
        return False
    manifest_sha = None
    ready_path = drop / "ready.json"
    if ready_path.is_file() and not ready_path.is_symlink() and ready_path.stat().st_size <= 16384:
        try:
            ready = json.loads(ready_path.read_bytes())
        except ValueError, UnicodeError:
            ready = None
        if isinstance(ready, dict) and ready.get("batch_id") == batch_id:
            value = ready.get("manifest_sha256")
            if isinstance(value, str) and _HASH.fullmatch(value):
                manifest_sha = value
    # A damaged ready file can still be bound by the exact manifest bytes.
    manifest_path = drop / "manifest.json"
    if (
        manifest_sha is None
        and manifest_path.is_file()
        and not manifest_path.is_symlink()
        and manifest_path.stat().st_size <= 256 * 1024
    ):
        manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if manifest_sha is None:
        # Never invent a manifest binding. This case intentionally needs repair.
        return False
    target = receipts / f"{batch_id}.status.json"
    if target.is_symlink():
        raise ValueError("symlink status file")
    payload = {
        "schema": 1,
        "batch_status": "rejected",
        "batch_id": batch_id,
        "manifest_sha256": manifest_sha,
        "reason": str(reason)[:300],
        "detected_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    if target.exists():
        existing = json.loads(target.read_bytes())
        if not isinstance(existing, dict):
            raise ValueError("invalid existing status")
        if (
            existing.get("batch_id"),
            existing.get("manifest_sha256"),
            existing.get("batch_status"),
        ) != (batch_id, manifest_sha, "rejected"):
            raise ValueError("terminal batch status conflict")
        return True
    if dry_run:
        return True
    receipts.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".status-", dir=receipts)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == "posix":
            os.chown(temporary, -1, receipts.stat().st_gid)  # type: ignore[attr-defined]
        os.chmod(temporary, 0o640)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return True
