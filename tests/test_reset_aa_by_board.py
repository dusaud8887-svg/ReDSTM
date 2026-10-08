from pathlib import Path

from crawler.archive import archive_transaction, initialize_archive
from scripts.reset_aa_by_board import reset_aa


def test_reset_aa_follows_the_board_only_and_replays_as_a_no_op(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with archive_transaction(archive) as connection:
        for board in ("aa_a01", "write_free21", "aaron"):
            connection.execute(
                """INSERT INTO boards
                   (board_id, name, canonical_url, first_seen_at, last_seen_at)
                   VALUES (?, ?, ?, '2026-01-01', '2026-01-01')""",
                (board, board, f"https://example.com/{board}"),
            )
        for post_id, board, is_aa in (
            (1, "aa_a01", 0),
            (2, "aa_a01", 1),
            (3, "write_free21", 1),
            (4, "write_free21", 0),
            (5, "aaron", 1),
        ):
            connection.execute(
                """INSERT INTO posts
                   (id, board_id, external_post_id, canonical_url, title,
                    first_seen_at, last_seen_at, is_aa)
                   VALUES (?, ?, ?, ?, '글', '2026-01-01', '2026-01-01', ?)""",
                (post_id, board, post_id, f"https://example.com/{post_id}", is_aa),
            )

    with archive_transaction(archive, read_only=True) as connection:
        preview = reset_aa(connection)
    assert preview == {
        "applied": False,
        "to_aa": 1,
        "to_prose": 2,
        "boards": {
            "aa_a01": {"to_aa": 1, "to_prose": 0},
            "aaron": {"to_aa": 0, "to_prose": 1},
            "write_free21": {"to_aa": 0, "to_prose": 1},
        },
    }
    with archive_transaction(archive) as connection:
        assert reset_aa(connection, apply=True)["to_prose"] == 2
    with archive_transaction(archive, read_only=True) as connection:
        stored = dict(connection.execute("SELECT id, is_aa FROM posts ORDER BY id").fetchall())
        assert stored == {1: 1, 2: 1, 3: 0, 4: 0, 5: 0}
        assert reset_aa(connection)["boards"] == {}
