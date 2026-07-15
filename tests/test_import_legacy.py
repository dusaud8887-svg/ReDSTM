from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime
from pathlib import Path

from crawler.archive import connect_archive, decompress_body
from scripts.import_legacy import import_legacy, normalize_source_timestamp
from scripts.legacy_common import _KST
from scripts.verify_migration import verify_migration


def _legacy_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE boards (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT,
                post_count INTEGER, last_crawled_at TEXT, is_active INTEGER
            );
            CREATE TABLE posts (
                id INTEGER NOT NULL, board_id TEXT NOT NULL, url TEXT, title TEXT NOT NULL,
                author TEXT, category TEXT, content_html TEXT NOT NULL, is_aa INTEGER,
                views INTEGER, created_at TEXT, crawled_at TEXT,
                UNIQUE (id, board_id)
            );
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, board_id TEXT NOT NULL,
                author TEXT, content TEXT NOT NULL, created_at TEXT, parent_id INTEGER,
                depth INTEGER
            );
            CREATE TABLE collections (
                id INTEGER PRIMARY KEY, board_id TEXT NOT NULL, collection_type TEXT NOT NULL,
                title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE collection_episodes (
                id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL, post_id INTEGER NOT NULL,
                board_id TEXT NOT NULL, episode_number INTEGER
            );
            CREATE TABLE bookmarks (
                id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, board_id TEXT NOT NULL,
                title TEXT NOT NULL, note TEXT, tags TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE reading_history (
                id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, board_id TEXT NOT NULL,
                post_title TEXT, read_at TEXT NOT NULL, scroll_position REAL
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
            CREATE TABLE post_queue (
                id INTEGER NOT NULL, board_id TEXT NOT NULL, priority INTEGER, status TEXT,
                retry_count INTEGER, last_error TEXT, last_attempt_at TEXT,
                PRIMARY KEY (id, board_id)
            );
            INSERT INTO boards VALUES
                ('ss_temp01', 'Board 1', 'fanfic', 1, '2026.07.10 12:00', 1),
                ('ss_temp02', 'Board 2', 'fanfic', 1, '2026-07-10 12:00', 1);
            INSERT INTO posts VALUES
                (7, 'ss_temp01', 'legacy-url-1', 'First', 'alice', 'cat',
                 '<div><script>bad()</script><b>body 1</b></div>', 0, 11,
                 '2026.07.01 10:30', '2026.07.10 12:00'),
                (7, 'ss_temp02', 'legacy-url-2', 'Second', 'bob', NULL,
                 '<pre class="AA_Text">body 2</pre>', 1, 22,
                 '2026-07-02 11:40', '2026-07-10 12:00');
            INSERT INTO comments VALUES
                (101, 7, 'ss_temp01', 'one', '<p>root</p>', '2026.07.01 11:00', NULL, 0),
                (102, 7, 'ss_temp01', 'two', '<p>reply</p>', '2026.07.01 11:01', 101, 1),
                (103, 7, 'ss_temp01', 'empty', '<script>removed()</script>',
                 '2026.07.01 11:02', NULL, 0),
                (201, 99, 'ss_temp02', 'lost', '<p>orphan</p>', '2026.07.02 12:00', NULL, 0),
                (202, 99, 'ss_temp02', 'reply', '<p>orphan reply</p>',
                 '2026.07.02 12:01', 201, 1);
            INSERT INTO collections VALUES
                (1, 'ss_temp01', 'series', 'Series', '2026.07.01 10:00', '2026.07.02 10:00');
            INSERT INTO collection_episodes VALUES
                (1, 1, 7, 'ss_temp01', 1),
                (2, 1, 8, 'ss_temp01', 2);
            INSERT INTO bookmarks VALUES
                (1, 7, 'ss_temp01', 'First', 'note', '["tag"]', '2026.07.03 10:00');
            INSERT INTO reading_history VALUES
                (1, 9, 'ss_temp02', 'Missing history', '2026.07.04 10:00', 123.5);
            INSERT INTO settings VALUES ('theme', '"dark"', '2026.07.05 10:00');
            INSERT INTO post_queue VALUES
                (10, 'ss_temp01', 5, 'pending', 0, NULL, NULL),
                (11, 'ss_temp02', 1, 'failed', 2, 'timeout', '2026.07.06 10:00'),
                (12, 'ss_temp02', 1, 'auth_blocked', 1, 'auth', '2026.07.06 11:00');
            """
        )


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_normalize_source_timestamp_accepts_legacy_dot_and_dash_formats() -> None:
    assert normalize_source_timestamp("2026.07.01 10:30") == "2026-07-01T01:30:00+00:00"
    assert normalize_source_timestamp("2026-07-02 11:40") == "2026-07-02T02:40:00+00:00"
    assert normalize_source_timestamp("not-a-date") is None


def test_normalize_source_timestamp_resolves_two_digit_year_gnuboard_dates() -> None:
    # gnuboard's 2-digit year was previously unparseable (dropped to NULL); %y maps it into
    # the 2000s deterministically, and never mis-reads "26" as the year 1926.
    assert normalize_source_timestamp("26-07-15 14:30:05") == "2026-07-15T05:30:05+00:00"
    assert normalize_source_timestamp("24.01.02 09:10") == "2024-01-02T00:10:00+00:00"
    assert normalize_source_timestamp("26-07-15") == "2026-07-14T15:00:00+00:00"


def test_normalize_source_timestamp_anchors_year_less_and_time_only_forms_to_base() -> None:
    base = datetime(2026, 7, 15, 14, 30, tzinfo=_KST)
    # "MM-DD" earlier in the capture year stays in that year...
    assert normalize_source_timestamp("07-10 09:00", base=base) == "2026-07-10T00:00:00+00:00"
    # ...but a month past the capture date rolled over from the previous year.
    assert normalize_source_timestamp("12-31 23:00", base=base) == "2025-12-31T14:00:00+00:00"
    # Time-only comment stamps resolve to the capture day.
    assert normalize_source_timestamp("09:05", base=base) == "2026-07-15T00:05:00+00:00"
    # Without a base, year-less forms cannot be anchored and stay unresolved.
    assert normalize_source_timestamp("07-10 09:00") is None


def test_normalize_source_timestamp_resolves_korean_relative_expressions() -> None:
    base = datetime(2026, 7, 15, 14, 30, tzinfo=_KST)
    assert normalize_source_timestamp("어제", base=base) == "2026-07-14T05:30:00+00:00"
    assert normalize_source_timestamp("3일 전", base=base) == "2026-07-12T05:30:00+00:00"
    assert normalize_source_timestamp("2시간 전", base=base) == "2026-07-15T03:30:00+00:00"
    # A relative expression with no base still parses against the current moment (non-None),
    # and genuine junk stays None.
    assert normalize_source_timestamp("정체불명", base=base) is None


def test_normalize_source_timestamp_output_is_unchanged_for_existing_absolute_formats() -> None:
    # The deterministic fast path must be byte-identical to the pre-dateparser behavior so a
    # re-crawl does not rewrite every post's created_at_source (and churn projections).
    base = datetime(2026, 7, 15, 14, 30, tzinfo=_KST)
    for value in ("2026.07.01 10:30", "2026-07-02 11:40", "2026-07-03"):
        assert normalize_source_timestamp(value) == normalize_source_timestamp(value, base=base)


def test_import_legacy_is_idempotent_and_preserves_composite_identity(tmp_path: Path) -> None:
    source = tmp_path / "legacy.sqlite"
    target = tmp_path / "archive.sqlite"
    _legacy_database(source)
    source_hash = _sha256(source)

    first = import_legacy(source, target, batch_size=1, workers=2)
    second = import_legacy(source, target, batch_size=2)

    assert first["posts"] == 2
    assert first["comments"] == 3
    assert first["new_versions"] == 2
    assert first["empty_comments_replaced"] == 1
    assert first["auxiliary"] == {
        "collections": 1,
        "collection_entries": 2,
        "bookmarks": 1,
        "reading_progress": 1,
        "settings": 1,
        "frontier": 3,
        "orphan_comments": 2,
        "placeholder_posts": 3,
    }
    assert second["posts"] == 0
    assert second["resume_offset"] == 2
    assert second["new_versions"] == 0
    assert source_hash == _sha256(source)
    assert first["source_unchanged"] is True
    assert verify_migration(source, target)["ok"] is True

    with connect_archive(target) as connection:
        posts = connection.execute(
            """
            SELECT board_id, external_post_id, canonical_url, created_at_source,
                   latest_version_id, comment_count
            FROM posts WHERE availability = 'available' ORDER BY board_id
            """
        ).fetchall()
        assert [(row["board_id"], row["external_post_id"]) for row in posts] == [
            ("ss_temp01", 7),
            ("ss_temp02", 7),
        ]
        assert posts[0]["canonical_url"] == "https://www.typemoon.net/ss_temp01/7"
        assert posts[0]["created_at_source"] == "2026-07-01T01:30:00+00:00"
        assert posts[0]["comment_count"] == 3
        assert all(row["latest_version_id"] is not None for row in posts)

        versions = connection.execute(
            """
            SELECT capture_origin, raw_sha256, body_html_zstd, body_text_zstd
            FROM post_versions ORDER BY id
            """
        ).fetchall()
        assert len(versions) == 2
        assert all(row["capture_origin"] == "legacy_import" for row in versions)
        assert all(row["raw_sha256"] is None for row in versions)
        assert "<script" not in decompress_body(versions[0]["body_html_zstd"])
        assert decompress_body(versions[0]["body_text_zstd"]) == "body 1"

        comments = connection.execute(
            """
            SELECT position, source_comment_id, parent_position, depth
            FROM comments
            WHERE post_id = (SELECT id FROM posts WHERE board_id = 'ss_temp01'
                             AND external_post_id = 7)
            ORDER BY position
            """
        ).fetchall()
        assert [tuple(row) for row in comments] == [
            (1, "101", None, 0),
            (2, "102", 1, 1),
            (3, "103", None, 0),
        ]
        empty_comment = connection.execute(
            "SELECT content_html FROM comments WHERE source_comment_id = '103'"
        ).fetchone()
        assert empty_comment[0] == "<p>[Unavailable legacy comment]</p>"
        orphan_comments = connection.execute(
            """
            SELECT position, source_comment_id, parent_position, depth, content_text
            FROM comments
            WHERE post_id = (SELECT id FROM posts WHERE board_id = 'ss_temp02'
                             AND external_post_id = 99)
            ORDER BY position
            """
        ).fetchall()
        assert [tuple(row) for row in orphan_comments] == [
            (1, "201", None, 0, "orphan"),
            (2, "202", 1, 1, "orphan reply"),
        ]
        assert connection.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 5
        assert connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0] == 5
        assert connection.execute("SELECT COUNT(*) FROM collections").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM collection_entries").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM bookmarks").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM reading_progress").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM crawl_frontier").fetchone()[0] == 3
        assert (
            connection.execute(
                "SELECT state FROM crawl_frontier WHERE external_post_id = 12"
            ).fetchone()[0]
            == "dead"
        )
        missing = connection.execute(
            "SELECT COUNT(*) FROM posts WHERE availability = 'missing'"
        ).fetchone()[0]
        assert missing == 3
        assert connection.execute("SELECT COUNT(*) FROM crawl_runs").fetchone()[0] == 2
