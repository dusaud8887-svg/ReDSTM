"""Disk thresholds shared by the TypeMoon runner and the text archive on one Oracle volume.

Keep 4 GiB for the OS and in-flight writes; warn one GiB before that reserve.
Text and TypeMoon share the same physical volume and stop threshold.
"""

from __future__ import annotations

_GIB = 1024**3


def _clamp(value: float, low: int, high: int) -> int:
    return int(min(high, max(low, value)))


def disk_low_bytes(total_bytes: int) -> int:
    """Warning level for TypeMoon."""
    return disk_stop_bytes(total_bytes) + _GIB


def text_disk_floor_bytes(total_bytes: int) -> int:
    """Use the same reserve for both archives (owner decision 2026-10-06)."""
    return disk_stop_bytes(total_bytes)


def disk_stop_bytes(total_bytes: int) -> int:
    """TypeMoon starts no new crawl chunk below this."""
    return 4 * _GIB


def warc_budget_bytes(total_bytes: int) -> int:
    """Raw capture evidence kept on disk (oldest files go first)."""
    return _clamp(total_bytes * 0.10, 2 * _GIB, 20 * _GIB)
