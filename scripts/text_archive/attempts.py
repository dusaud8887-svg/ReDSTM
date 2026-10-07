"""Per-batch import attempt records shared by the text and media importers.

Only validation rejects a batch. Operational failures keep it for retry with capped backoff,
so a failing head batch never blocks the independent batches behind it. The attempt is
counted before the work runs: an OOM kill or unit timeout never reaches an except clause,
and without that record the next run retried the same head batch with no backoff.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

BACKOFF_SECONDS = (300, 900, 1800, 3600)


def backoff_active(root: Path, batch_id: str) -> bool:
    try:
        record = json.loads((root / f"{batch_id}.json").read_text(encoding="utf-8"))
        return float(record["next_at"]) > time.time()
    except OSError, ValueError, KeyError, TypeError:
        return False


def previous(root: Path, batch_id: str) -> int:
    try:
        record = json.loads((root / f"{batch_id}.json").read_text(encoding="utf-8"))
        return int(record["attempts"])
    except OSError, ValueError, KeyError, TypeError:
        return 0


def write(root: Path, batch_id: str, attempts: int, reason: str) -> None:
    path = root / f"{batch_id}.json"
    delay = BACKOFF_SECONDS[min(attempts, len(BACKOFF_SECONDS)) - 1]
    root.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps({"attempts": attempts, "next_at": time.time() + delay, "reason": reason}),
        encoding="utf-8",
    )
    temporary.replace(path)


def begin(root: Path, batch_id: str) -> int:
    attempts = previous(root, batch_id) + 1
    write(root, batch_id, attempts, "import_started")
    return attempts


def record_failure(root: Path, batch_id: str, error: BaseException) -> dict[str, Any]:
    attempts = max(1, previous(root, batch_id))
    reason = f"import_failed:{type(error).__name__}"
    try:
        write(root, batch_id, attempts, reason)
    except OSError as exc:
        # An unwritable attempts root must not replace the original import error.
        reason += f";attempt_record_failed:{type(exc).__name__}"
    return {"status": "failed", "batch_id": batch_id, "reason": reason, "attempt": attempts}


def not_ready(root: Path, batch_id: str) -> None:
    """A batch that was not ready yet is not a failed attempt; undo begin()."""
    attempts = previous(root, batch_id) - 1
    if attempts > 0:
        write(root, batch_id, attempts, "import_not_ready")
    else:
        clear(root, batch_id)


def clear(root: Path, batch_id: str) -> None:
    (root / f"{batch_id}.json").unlink(missing_ok=True)
