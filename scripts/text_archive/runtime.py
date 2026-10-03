from __future__ import annotations

import json
import re
import shutil
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path

from filelock import FileLock, Timeout

from scripts.storage_policy import disk_low_bytes

_MIB = 1024 * 1024
_GIB = 1024 * _MIB

# Memory policy on the shared 1 GB Oracle host (docs/18): TypeMoon comes first. While it runs a
# heavy step (the lane file below), the memory it may still grow into (its expected peak minus
# what it uses now) is reserved, and a text operation starts only when its own need plus a margin
# for the OS fits in what is left. When TypeMoon is idle the same rule applies with nothing
# reserved.
_TYPEMOON_UNITS = ("redstm-control.service", "redstm-schedule.service")
# Scrapy closes a batch at 560 MiB (MEMUSAGE_LIMIT_MB) plus the runner process; the unit hard
# stop is 700 MiB.
_TYPEMOON_PEAK = 620 * _MIB
# Written by scripts/control_runner.py while a heavy TypeMoon child runs; readable by text
# (other r) next to the publish lock it already reaches.
TYPEMOON_LANE_PATH = Path("/srv/redstm/static/.typemoon-lane.json")
_LANE_STALE_SECONDS = 180
_OS_MARGIN = 150 * _MIB
_DEFAULT_NEED = 150 * _MIB
# Heavy text steps (import, media, publish) run one at a time; the collector is light.
_TEXT_OPERATION_LOCK = Path("/srv/redstm-text/.operation.lock")


class RuntimeWindowError(RuntimeError):
    pass


def _available_memory(meminfo: str) -> int:
    match = re.search(r"^MemAvailable:\s+(\d+) kB$", meminfo, re.M)
    if match is None:
        raise RuntimeWindowError("memory_metrics_unavailable")
    return int(match.group(1)) * 1024


def _resident_memory(status: str) -> int:
    match = re.search(r"^VmRSS:\s+(\d+) kB$", status, re.M)
    if match is None:
        raise RuntimeWindowError("memory_metrics_unavailable")
    return int(match.group(1)) * 1024


def _unit_memory(cgroup_root: Path, unit: str) -> int | None:
    """Current memory of a running systemd unit, or None when it is not running."""
    unit_root = cgroup_root / "system.slice" / unit
    try:
        if not (unit_root / "cgroup.procs").read_text(encoding="ascii").strip():
            return None
        return int((unit_root / "memory.current").read_text(encoding="ascii").strip())
    except OSError, ValueError:
        return None


def typemoon_reserve(cgroup_root: Path, lane_path: Path, now: float | None = None) -> int:
    """Memory TypeMoon may still claim while it runs a heavy step.

    The control runner writes the lane file while a crawl, export or publish child runs and
    refreshes it every 30 s (docs/18). Its short every-minute poll and its outage backoff sleeps
    write nothing, so they no longer hold text back. A file text cannot read is taken as a
    heavy step at its start (the whole peak is reserved).
    """
    try:
        lane = json.loads(lane_path.read_text(encoding="utf-8"))
        updated = float(lane["updated_at"])
    except FileNotFoundError:
        return 0
    except OSError, ValueError, KeyError, TypeError:
        return _TYPEMOON_PEAK
    if (now if now is not None else time.time()) - updated > _LANE_STALE_SECONDS:
        return 0  # a runner that died without clearing it
    current = max((_unit_memory(cgroup_root, unit) or 0) for unit in _TYPEMOON_UNITS)
    return max(0, _TYPEMOON_PEAK - current)


@contextmanager
def operation_window(
    *,
    lock_wait_seconds: float = 0,
    need_bytes: int = _DEFAULT_NEED,
    exclusive: bool = False,
    publish_lock: Path = Path("/srv/redstm/static/.publish.lock"),
    lane_path: Path = TYPEMOON_LANE_PATH,
    operation_lock: Path = _TEXT_OPERATION_LOCK,
    meminfo_path: Path = Path("/proc/meminfo"),
    status_path: Path = Path("/proc/self/status"),
    cgroup_root: Path = Path("/sys/fs/cgroup"),
    root_path: Path = Path("/"),
) -> Iterator[None]:
    """Yield to TypeMoon publishing and memory for one bounded operation."""
    with ExitStack() as stack:
        if exclusive:
            text_lock = FileLock(str(operation_lock))
            try:
                text_lock.acquire(timeout=lock_wait_seconds)
            except (Timeout, OSError) as exc:
                raise RuntimeWindowError("text_operation_busy") from exc
            stack.callback(text_lock.release)
        # Probe only: text never holds TypeMoon's publish lock, or a text step could fail
        # TypeMoon's publish confirmation, which takes the lock without waiting.
        lock = FileLock(str(publish_lock))
        try:
            lock.acquire(timeout=lock_wait_seconds)
        except (Timeout, OSError) as exc:
            raise RuntimeWindowError("typemoon_publish_busy") from exc
        lock.release()

        reserve = typemoon_reserve(cgroup_root, lane_path)
        try:
            available = _available_memory(meminfo_path.read_text(encoding="ascii"))
            resident = _resident_memory(status_path.read_text(encoding="ascii"))
        except OSError as exc:
            raise RuntimeWindowError("memory_metrics_unavailable") from exc
        # /proc/meminfo already excludes this process; add it back to estimate the headroom
        # this bounded text operation started with.
        if available + resident - reserve < need_bytes + _OS_MARGIN:
            raise RuntimeWindowError(
                "typemoon_memory_reserved" if reserve else "memory_below_floor"
            )
        try:
            usage = shutil.disk_usage(root_path)
        except OSError as exc:
            raise RuntimeWindowError("disk_metrics_unavailable") from exc
        # Text stops at TypeMoon's warning level, so the space below it stays TypeMoon's.
        if usage.free < disk_low_bytes(usage.total):
            raise RuntimeWindowError("disk_below_floor")
        yield
