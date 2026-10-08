from pathlib import Path

from crawler.archive import archive_transaction, initialize_archive
from scripts.backfill_source_dates import backfill


def test_backfill_anchors_relative_raw_dates_at_the_last_collection(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with archive_transaction(archive) as connection:
        connection.execute(
            """INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
               VALUES ('aa_19', 'b', 'https://example.com', '2026-01-01', '2026-01-01')"""
        )
        for post_id, raw, source in (
            (1, "24시간 56분전", None),
            (2, "알 수 없음", None),
            (3, "32분전", "2026-01-01T00:00:00+00:00"),
        ):
            connection.execute(
                """INSERT INTO posts (id, board_id, external_post_id, canonical_url, title,
                   created_at_source, created_at_raw, first_seen_at, last_seen_at,
                   last_collected_at)
                   VALUES (?, 'aa_19', ?, ?, 't', ?, ?, '2026-10-08T00:00:00+00:00',
                           '2026-10-08T00:00:00+00:00', '2026-10-08T00:00:00+00:00')""",
                (post_id, post_id, f"https://example.com/{post_id}", source, raw),
            )

    with archive_transaction(archive, read_only=True) as connection:
        assert backfill(connection) == {"applied": False, "resolved": 1, "unresolved": 1}
    with archive_transaction(archive) as connection:
        backfill(connection, apply=True)
    with archive_transaction(archive, read_only=True) as connection:
        stored = dict(connection.execute("SELECT id, created_at_source FROM posts").fetchall())
    assert stored == {
        1: "2026-10-06T23:04:00+00:00",
        2: None,
        3: "2026-01-01T00:00:00+00:00",
    }
