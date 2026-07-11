from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from scripts.profile_sqlite import profile_database


def test_profile_database_is_read_only(tmp_path: Path) -> None:
    database_path = tmp_path / "sample.sqlite"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
        connection.execute("CREATE INDEX posts_title_idx ON posts(title)")
        connection.executemany("INSERT INTO posts(title) VALUES (?)", [("one",), ("two",)])

    before = database_path.stat()
    profile = profile_database(database_path, include_counts=True)
    after = database_path.stat()

    assert profile["sqlite"]["quick_check"] == ["ok"]
    assert profile["file"]["size_bytes"] == before.st_size
    assert len(profile["file"]["sha256"]) == 64
    assert profile["table_counts"]["posts"] == 2
    assert any(item["name"] == "posts" for item in profile["schema"])
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)


def test_profile_database_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        profile_database(tmp_path / "missing.sqlite")
