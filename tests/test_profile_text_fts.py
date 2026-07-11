from __future__ import annotations

import sqlite3
from pathlib import Path

from scripts.profile_text_fts import profile_text_fts


def test_profile_text_fts_is_read_only_and_measures_both_tokenizers(tmp_path: Path) -> None:
    source = tmp_path / "source.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute(
            """
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY,
                board_id TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT,
                category TEXT,
                content_html TEXT NOT NULL,
                is_aa INTEGER NOT NULL
            )
            """
        )
        connection.executemany(
            "INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (1, "board", "첫 글", "저자", None, "<p>안녕 세계</p>", 0),
                (2, "board", "둘째", None, "AA", "<pre> A A </pre>", 1),
                (3, "other", "셋째", "저자", None, "<p>검색 본문</p>", 0),
                (
                    4,
                    "other",
                    "넷째",
                    "저자",
                    None,
                    "<style>style-secret</style><script>script-secret</script><p>보존</p>",
                    0,
                ),
            ],
        )

    source_before = source.stat()
    working = tmp_path / "sample.sqlite"
    result = profile_text_fts(source, working, sample_size=4)
    source_after = source.stat()

    assert result["sampling"] == {
        "method": (
            "equally spaced by SQLite rowid; identity retained as board_id + external_post_id"
        ),
        "population_rows": 4,
        "sample_rows": 4,
        "board_count": 2,
        "aa_rows": 1,
    }
    assert result["body_text"]["text_bytes"] > 0
    assert result["fts5"]["unicode61"]["index_bytes"] > 0
    assert result["fts5"]["trigram"]["index_bytes"] > 0
    with sqlite3.connect(working) as connection:
        body_text = connection.execute(
            "SELECT body_text FROM documents WHERE source_rowid = 4"
        ).fetchone()[0]
    assert body_text == "보존"
    assert (source_after.st_size, source_after.st_mtime_ns) == (
        source_before.st_size,
        source_before.st_mtime_ns,
    )
