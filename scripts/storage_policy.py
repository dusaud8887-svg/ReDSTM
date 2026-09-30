"""Disk thresholds shared by the TypeMoon runner and the text archive on one Oracle volume.

The fixed 40 GiB warning / 20 GiB stop only made sense on a large boot volume: on a small one the
warning never cleared and text work (which waits at the warning level) never ran. Defaults now
scale with the volume and keep the old values as the ceiling.
"""

from __future__ import annotations

_GIB = 1024**3


def _clamp(value: float, low: int, high: int) -> int:
    return int(min(high, max(low, value)))


def disk_low_bytes(total_bytes: int) -> int:
    """Warning level for TypeMoon; text work stops here so TypeMoon keeps the rest."""
    return _clamp(total_bytes * 0.20, 5 * _GIB, 40 * _GIB)


def disk_stop_bytes(total_bytes: int) -> int:
    """TypeMoon starts no new crawl chunk below this."""
    return _clamp(total_bytes * 0.10, 3 * _GIB, 20 * _GIB)


def warc_budget_bytes(total_bytes: int) -> int:
    """Raw capture evidence kept on disk (oldest files go first)."""
    return _clamp(total_bytes * 0.10, 2 * _GIB, 20 * _GIB)
