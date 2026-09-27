from pathlib import Path

from crawler.archive import archive_transaction, initialize_archive
from scripts.reconcile_works import reconcile_board


def test_reconcile_appends_only_unambiguous_later_chapter_and_replays_safely(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with archive_transaction(archive) as connection:
        connection.execute(
            """INSERT INTO boards
               (board_id, name, canonical_url, first_seen_at, last_seen_at)
               VALUES ('board', 'Board', 'https://example.com/board', '2026-01-01', '2026-01-01')"""
        )
        for post_id, title, author in (
            (1, "기나긴 작품 1화", "작가"),
            (2, "기나긴 작품 2화", "작가"),
            (3, "기나긴 작품 3화", "작가"),
            (4, "기나긴 작품 4화", None),
            (5, "기나긴 작품 1.5화", "작가"),
        ):
            connection.execute(
                """INSERT INTO posts
                   (id, board_id, external_post_id, canonical_url, title, author,
                    first_seen_at, last_seen_at, availability)
                   VALUES (?, 'board', ?, ?, ?, ?, '2026-01-01', '2026-01-01', 'available')""",
                (post_id, post_id, f"https://example.com/{post_id}", title, author),
            )
        connection.execute(
            """INSERT INTO collections
               (id, board_id, kind, title, created_at, updated_at)
               VALUES (99, 'board', 'legacy', '기나긴 작품', '2026-01-01', '2026-01-01')"""
        )
        connection.executemany(
            """INSERT INTO collection_entries
               (collection_id, position, post_id, source_external_post_id)
               VALUES (99, ?, ?, ?)""",
            [(1, 1, 1), (2, 2, 2)],
        )

    with archive_transaction(archive, read_only=True) as connection:
        assert reconcile_board(connection, "board")["changes"] == [
            {"collection_id": 99, "external_post_id": 3}
        ]
    with archive_transaction(archive) as connection:
        assert reconcile_board(connection, "board", apply=True)["applied"] == 1
        assert reconcile_board(connection, "board", apply=True)["applied"] == 0
        entries = list(
            connection.execute(
                """SELECT position, source_external_post_id FROM collection_entries
                   WHERE collection_id = 99 ORDER BY position"""
            )
        )
    assert [tuple(row) for row in entries] == [(1, 1), (2, 2), (3, 3)]


def test_reconcile_creates_missing_work_then_appends_future_chapter(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with archive_transaction(archive) as connection:
        connection.execute(
            """INSERT INTO boards
               (board_id,name,canonical_url,first_seen_at,last_seen_at)
               VALUES ('aa_19','19금 AA','https://example.com/aa','2026-01-01','2026-01-01')"""
        )
        for post_id, title in ((1, "긴 연재 제목 1화"), (2, "긴 연재 제목 2화")):
            connection.execute(
                """INSERT INTO posts
                   (id,board_id,external_post_id,canonical_url,title,author,
                    first_seen_at,last_seen_at,availability)
                   VALUES (?,'aa_19',?,?,?,'작가','2026-01-01','2026-01-01','available')""",
                (post_id, post_id, f"https://example.com/{post_id}", title),
            )
    with archive_transaction(archive, read_only=True) as connection:
        assert reconcile_board(connection, "aa_19")["new_collections"] == 1
        assert connection.execute("SELECT COUNT(*) FROM collections").fetchone()[0] == 0
    with archive_transaction(archive) as connection:
        assert reconcile_board(connection, "aa_19", apply=True)["created_collections"] == 1
        assert reconcile_board(connection, "aa_19", apply=True)["created_collections"] == 0
        connection.execute(
            """INSERT INTO posts
               (id,board_id,external_post_id,canonical_url,title,author,
                first_seen_at,last_seen_at,availability)
               VALUES (3,'aa_19',3,'https://example.com/3','긴 연재 제목 3화','작가',
                       '2026-01-02','2026-01-02','available')"""
        )
        assert reconcile_board(connection, "aa_19", apply=True)["applied"] == 1
        assert connection.execute("SELECT COUNT(*) FROM collections").fetchone()[0] == 1
        assert connection.execute("SELECT title FROM collections").fetchone()[0] == "긴 연재 제목"
        assert [
            row[0]
            for row in connection.execute(
                "SELECT source_external_post_id FROM collection_entries ORDER BY position"
            )
        ] == [1, 2, 3]
