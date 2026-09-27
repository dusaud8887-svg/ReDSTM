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
