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


@contextmanager
def operation_window(
    *,
    publish_lock: Path = Path("/srv/redstm/static/.publish.lock"),
    meminfo_path: Path = Path("/proc/meminfo"),
    status_path: Path = Path("/proc/self/status"),
    root_path: Path = Path("/"),
    run: object = subprocess.run,
) -> Iterator[None]:
    """Yield to TypeMoon publishing and resource pressure for one bounded operation."""
    with ExitStack() as stack:
        lock = FileLock(str(publish_lock))
        try:
            lock.acquire(timeout=0)
        except (Timeout, OSError) as exc:
            raise RuntimeWindowError("typemoon_publish_busy") from exc
        stack.callback(lock.release)

        runner = run
        if not callable(runner):
            raise RuntimeWindowError("systemd_check_unavailable")
        try:
            result = runner(
                ["systemctl", "is-active", "--quiet", "redstm-schedule.service"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeWindowError("systemd_check_unavailable") from exc
        if result.returncode == 0:
            raise RuntimeWindowError("typemoon_schedule_active")
        if result.returncode != 3:
            raise RuntimeWindowError("typemoon_schedule_state_unknown")

        try:
            available = _available_memory(meminfo_path.read_text(encoding="ascii"))
            resident = _resident_memory(status_path.read_text(encoding="ascii"))
        except OSError as exc:
            raise RuntimeWindowError("memory_metrics_unavailable") from exc
        # /proc/meminfo already excludes this process; add it back to estimate
        # host headroom before the bounded text service started.
        if available + resident < 350 * _MIB:
            raise RuntimeWindowError("memory_below_floor")
        try:
            free = shutil.disk_usage(root_path).free
        except OSError as exc:
            raise RuntimeWindowError("disk_metrics_unavailable") from exc
        if free < 40 * _GIB:
            raise RuntimeWindowError("disk_below_floor")
        yield
