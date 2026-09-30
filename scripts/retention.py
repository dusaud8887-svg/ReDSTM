"""Local retention for files that only accumulate: WARC captures and run reports (docs/10 §5.4).

WARC files are raw capture evidence; the canonical archive keeps every parsed version, so old
captures are kept for a window and within a byte budget, oldest first. Files touched within the
last day are never removed (an active run may still be writing).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

_DAY = 24 * 60 * 60
_MIN_AGE_SECONDS = _DAY


@dataclass(frozen=True)
class Pruned:
    files: int = 0
    bytes: int = 0

    def __add__(self, other: Pruned) -> Pruned:
        return Pruned(self.files + other.files, self.bytes + other.bytes)


def prune_files(
    paths: list[Path],
    *,
    keep_seconds: int,
    max_bytes: int | None = None,
    now: float | None = None,
) -> Pruned:
    """Remove files older than keep_seconds, then oldest first until under max_bytes."""
    current = time.time() if now is None else now
    entries = []
    for path in paths:
        try:
            stat = path.stat()
        except OSError:
            continue
        if path.is_file():
            entries.append((stat.st_mtime, stat.st_size, path))
    entries.sort()
    total = sum(size for _, size, _ in entries)
    removed = Pruned()
    for mtime, size, path in entries:
        age = current - mtime
        if age < _MIN_AGE_SECONDS:
            break
        over_budget = max_bytes is not None and total > max_bytes
        if age <= keep_seconds and not over_budget:
            continue
        try:
            path.unlink()
        except OSError:
            continue
        total -= size
        removed += Pruned(1, size)
    return removed


def prune_warc(
    directory: Path, *, keep_days: int, max_bytes: int, now: float | None = None
) -> Pruned:
    if not directory.is_dir():
        return Pruned()
    return prune_files(
        sorted(directory.glob("*.warc.gz")),
        keep_seconds=keep_days * _DAY,
        max_bytes=max_bytes,
        now=now,
    )


def prune_reports(directory: Path, *, keep_days: int, now: float | None = None) -> Pruned:
    if not directory.is_dir():
        return Pruned()
    files = [path for path in directory.rglob("*") if path.suffix in {".json", ".txt"}]
    return prune_files(files, keep_seconds=keep_days * _DAY, now=now)
