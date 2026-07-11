from __future__ import annotations

from pathlib import Path

from crawler.archive import compress_body, connect_archive, initialize_archive
from scripts.inventory_images import inventory_images


def test_inventory_images_counts_unique_urls_without_network(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('board', 'Board', 'https://www.typemoon.net/board', 'now', 'now')
            """
        )
        for post_id, body in (
            (1, '<img src="/data/a.png"><img src="https://img.example/x.png">'),
            (2, '<img src="/data/a.png">'),
        ):
            cursor = connection.execute(
                """
                INSERT INTO posts (
                    board_id, external_post_id, canonical_url, title, first_seen_at, last_seen_at
                ) VALUES ('board', ?, ?, 'title', 'now', 'now')
                """,
                (post_id, f"https://www.typemoon.net/board/{post_id}"),
            )
            post_row_id = cursor.lastrowid
            version = connection.execute(
                """
                INSERT INTO post_versions (
                    post_id, content_sha256, parser_version, capture_origin,
                    body_html_zstd, body_text_zstd, comments_sha256, captured_at
                ) VALUES (?, ?, 'test', 'live', ?, ?, ?, 'now')
                """,
                (
                    post_row_id,
                    str(post_id) * 64,
                    compress_body(body),
                    compress_body(""),
                    "c" * 64,
                ),
            ).lastrowid
            connection.execute(
                "UPDATE posts SET latest_version_id = ? WHERE id = ?", (version, post_row_id)
            )

    report = inventory_images(archive)

    assert report["post_count"] == 2
    assert report["posts_with_images"] == 2
    assert report["reference_count"] == 3
    assert report["unique_url_count"] == 2
    assert report["same_origin_unique_count"] == 1
    assert report["external_unique_count"] == 1
    assert report["images"][0]["occurrences"] in {1, 2}
