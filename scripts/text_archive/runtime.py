from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path

from filelock import FileLock, Timeout

_MIB = 1024 * 1024
_GIB = 1024 * _MIB

# Memory policy on the shared 1 GB Oracle host (docs/18): TypeMoon comes first. While one of its
# units runs, the memory it may still grow into (its expected peak minus what it uses now) is
# reserved, and a text operation starts only when its own need plus a margin for the OS fits in
# what is left. When TypeMoon is idle the same rule applies with nothing reserved.
_TYPEMOON_UNITS = ("redstm-control.service", "redstm-schedule.service")
# Scrapy closes a batch at 560 MiB (MEMUSAGE_LIMIT_MB) plus the runner process; the unit hard
# stop is 700 MiB.
_TYPEMOON_PEAK = 620 * _MIB
_OS_MARGIN = 150 * _MIB
_DEFAULT_NEED = 150 * _MIB
# Text writes stay off the disk the TypeMoon archive needs (its own stop is 20 GiB).
_DISK_FLOOR = 40 * _GIB
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


def _unit_active(runner: object, unit: str) -> bool:
    if not callable(runner):
        raise RuntimeWindowError("systemd_check_unavailable")
    try:
        result = runner(
            ["systemctl", "is-active", "--quiet", unit],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeWindowError("systemd_check_unavailable") from exc
    if result.returncode not in (0, 3):
        raise RuntimeWindowError("typemoon_state_unknown")
    return result.returncode == 0


def typemoon_reserve(cgroup_root: Path, run: object) -> int:
    """Memory a running TypeMoon unit may still claim. A unit that systemd reports active but
    whose cgroup cannot be read is assumed to be at its start (the whole peak is reserved)."""
    reserve = 0
    for unit in _TYPEMOON_UNITS:
        current = _unit_memory(cgroup_root, unit)
        if current is None and not _unit_active(run, unit):
            continue
        reserve = max(reserve, _TYPEMOON_PEAK - (current or 0))
    return max(0, reserve)


@contextmanager
def operation_window(
    *,
    lock_wait_seconds: float = 0,
    need_bytes: int = _DEFAULT_NEED,
    exclusive: bool = False,
    publish_lock: Path = Path("/srv/redstm/static/.publish.lock"),
    operation_lock: Path = _TEXT_OPERATION_LOCK,
    meminfo_path: Path = Path("/proc/meminfo"),
    status_path: Path = Path("/proc/self/status"),
    cgroup_root: Path = Path("/sys/fs/cgroup"),
    root_path: Path = Path("/"),
    run: object = subprocess.run,
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
        lock = FileLock(str(publish_lock))
        try:
            lock.acquire(timeout=lock_wait_seconds)
        except (Timeout, OSError) as exc:
            raise RuntimeWindowError("typemoon_publish_busy") from exc
        stack.callback(lock.release)

        reserve = typemoon_reserve(cgroup_root, run)
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
            free = shutil.disk_usage(root_path).free
        except OSError as exc:
            raise RuntimeWindowError("disk_metrics_unavailable") from exc
        if free < _DISK_FLOOR:
            raise RuntimeWindowError("disk_below_floor")
        yield
