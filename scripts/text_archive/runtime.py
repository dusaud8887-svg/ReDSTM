from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from pathlib import Path

from filelock import FileLock, Timeout

from scripts.storage_policy import text_disk_floor_bytes

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
# Why each text step last deferred (step -> reason, time); read into the status document.
DEFERRALS_PATH = Path("/srv/redstm-text/deferrals.json")
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
    # The step names its own expected peak (a body fill stays near 300 MiB, a full crawl does
    # not); without one, or with an implausible one, the crawl peak is assumed.
    peak = _TYPEMOON_PEAK
    declared = lane.get("peak_mib")
    if isinstance(declared, int) and not isinstance(declared, bool) and 64 <= declared <= 620:
        peak = declared * _MIB
    current = max((_unit_memory(cgroup_root, unit) or 0) for unit in _TYPEMOON_UNITS)
    return max(0, peak - current)


def record_deferral(reason: str, path: Path) -> None:
    """Remember why a text step was deferred, for the status document (docs/18). Best-effort:
    a step that cannot write it still defers the same way."""
    main = sys.modules.get("__main__")
    spec = getattr(main, "__spec__", None)
    step = spec.name.rsplit(".", 1)[-1] if spec is not None and spec.name else "unknown"
    try:
        try:
            deferrals = json.loads(path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            deferrals = {}
        if not isinstance(deferrals, dict):
            deferrals = {}
        at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        deferrals[step] = {"reason": reason, "at": at}
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(deferrals, sort_keys=True), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        return


def _admit(
    stack: ExitStack,
    *,
    lock_wait_seconds: float,
    need_bytes: int,
    exclusive: bool,
    publish_lock: Path,
    lane_path: Path,
    operation_lock: Path,
    meminfo_path: Path,
    status_path: Path,
    cgroup_root: Path,
    root_path: Path,
) -> None:
    text_lock = FileLock(str(operation_lock))
    try:
        text_lock.acquire(timeout=lock_wait_seconds)
    except (Timeout, OSError) as exc:
        raise RuntimeWindowError("text_operation_busy") from exc
    if exclusive:
        stack.callback(text_lock.release)
    else:
        # Probe only: a light step (collector, Tunaground, media) does not start while a heavy
        # one (publisher, importer) runs. On the 1 GiB box all three at once starved the
        # publisher's rclone past its timeout every run (2026-10-09: IO pressure ~55%, steal
        # ~40%, swapping; Tunaground uploads fell 3,500 segments behind in five hours).
        text_lock.release()
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
        raise RuntimeWindowError("typemoon_memory_reserved" if reserve else "memory_below_floor")
    try:
        usage = shutil.disk_usage(root_path)
    except OSError as exc:
        raise RuntimeWindowError("disk_metrics_unavailable") from exc
    # Text keeps only a small reserve so the volume never fills completely.
    if usage.free < text_disk_floor_bytes(usage.total):
        raise RuntimeWindowError("disk_below_floor")


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
    deferrals_path: Path = DEFERRALS_PATH,
) -> Iterator[None]:
    """Yield to TypeMoon publishing and memory for one bounded operation."""
    with ExitStack() as stack:
        try:
            _admit(
                stack,
                lock_wait_seconds=lock_wait_seconds,
                need_bytes=need_bytes,
                exclusive=exclusive,
                publish_lock=publish_lock,
                lane_path=lane_path,
                operation_lock=operation_lock,
                meminfo_path=meminfo_path,
                status_path=status_path,
                cgroup_root=cgroup_root,
                root_path=root_path,
            )
        except RuntimeWindowError as error:
            record_deferral(str(error), deferrals_path)
            raise
        yield
