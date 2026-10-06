from __future__ import annotations

import os
from pathlib import Path

from scripts.retention import prune_warc

_DAY = 24 * 60 * 60


def _file(path: Path, size: int, age_days: float, now: float) -> Path:
    path.write_bytes(b"x" * size)
    os.utime(path, (now - age_days * _DAY, now - age_days * _DAY))
    return path


def test_orphan_partials_age_out_but_never_go_for_byte_budget(tmp_path: Path) -> None:
    now = 10_000 * _DAY
    old_partial = _file(tmp_path / "a.warc.gz.partial", 10, 90, now)
    fresh_partial = _file(tmp_path / "b.warc.gz.partial", 10_000, 2, now)
    kept = _file(tmp_path / "c.warc.gz", 10, 2, now)
    pruned = prune_warc(tmp_path, keep_days=60, max_bytes=1, now=now)
    assert not old_partial.exists()
    assert fresh_partial.exists()  # over budget, but may still be written
    assert not kept.exists()  # complete captures still honour the byte budget
    assert pruned.files == 2
