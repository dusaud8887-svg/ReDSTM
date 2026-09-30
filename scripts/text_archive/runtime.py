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
_MEMORY_FLOOR = 350 * _MIB
_COMMAND_MEMORY_FLOOR = 600 * _MIB


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
    lock_wait_seconds: float = 0,
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
            lock.acquire(timeout=lock_wait_seconds)
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
        # A TypeMoon command (redstm-control.service: 본문 채우기, 전체 목차…) may run for hours,
        # so text work continues beside it, but only with room for the crawl's peak on the
        # 1 GB host; an OOM kill there ends the command as runner_failed.
        try:
            command = runner(
                ["systemctl", "is-active", "--quiet", "redstm-control.service"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeWindowError("systemd_check_unavailable") from exc
        floor = _COMMAND_MEMORY_FLOOR if command.returncode == 0 else _MEMORY_FLOOR

        try:
            available = _available_memory(meminfo_path.read_text(encoding="ascii"))
            resident = _resident_memory(status_path.read_text(encoding="ascii"))
        except OSError as exc:
            raise RuntimeWindowError("memory_metrics_unavailable") from exc
        # /proc/meminfo already excludes this process; add it back to estimate
        # host headroom before the bounded text service started.
        if available + resident < floor:
            below_command = floor == _COMMAND_MEMORY_FLOOR
            raise RuntimeWindowError(
                "memory_below_command_floor" if below_command else "memory_below_floor"
            )
        try:
            free = shutil.disk_usage(root_path).free
        except OSError as exc:
            raise RuntimeWindowError("disk_metrics_unavailable") from exc
        if free < 40 * _GIB:
            raise RuntimeWindowError("disk_below_floor")
        yield
