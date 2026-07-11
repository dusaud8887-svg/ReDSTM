from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from scrapy.http import HtmlResponse, Request

from crawler.middlewares import WarcCaptureMiddleware
from crawler.pipelines import NormalizedPost, normalize_captured_post
from crawler.spiders.typemoon import TypeMoonSpider


def _initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE posts (
            board_id TEXT NOT NULL,
            external_post_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            current_version_id INTEGER NOT NULL,
            PRIMARY KEY (board_id, external_post_id)
        );
        CREATE TABLE post_versions (
            id INTEGER PRIMARY KEY,
            board_id TEXT NOT NULL,
            external_post_id INTEGER NOT NULL,
            content_sha256 TEXT NOT NULL,
            comments_sha256 TEXT NOT NULL,
            body_html TEXT NOT NULL,
            body_text TEXT NOT NULL,
            warc_record_id TEXT,
            UNIQUE (board_id, external_post_id, content_sha256, comments_sha256)
        );
        CREATE TABLE comments (
            board_id TEXT NOT NULL,
            external_post_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            author TEXT,
            content_html TEXT NOT NULL,
            content_text TEXT NOT NULL,
            created_at_raw TEXT,
            PRIMARY KEY (board_id, external_post_id, position)
        );
        """
    )


def _project(connection: sqlite3.Connection, post: NormalizedPost) -> bool:
    connection.execute("BEGIN IMMEDIATE")
    inserted = connection.execute(
        """
        INSERT INTO post_versions(
            board_id, external_post_id, content_sha256, comments_sha256,
            body_html, body_text, warc_record_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (board_id, external_post_id, content_sha256, comments_sha256)
        DO NOTHING
        RETURNING id
        """,
        (
            post.board_id,
            post.external_post_id,
            post.content_sha256,
            post.comments_sha256,
            post.body_html,
            post.body_text,
            post.warc_record_id,
        ),
    ).fetchone()
    created = inserted is not None
    if inserted is None:
        inserted = connection.execute(
            """
            SELECT id FROM post_versions
            WHERE board_id = ? AND external_post_id = ?
              AND content_sha256 = ? AND comments_sha256 = ?
            """,
            (
                post.board_id,
                post.external_post_id,
                post.content_sha256,
                post.comments_sha256,
            ),
        ).fetchone()
    assert inserted is not None
    version_id = int(inserted[0])
    connection.execute(
        """
        INSERT INTO posts(board_id, external_post_id, title, current_version_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (board_id, external_post_id) DO UPDATE SET
            title = excluded.title,
            current_version_id = excluded.current_version_id
        """,
        (post.board_id, post.external_post_id, post.title, version_id),
    )
    if created:
        connection.execute(
            "DELETE FROM comments WHERE board_id = ? AND external_post_id = ?",
            (post.board_id, post.external_post_id),
        )
        connection.executemany(
            """
            INSERT INTO comments(
                board_id, external_post_id, position, author,
                content_html, content_text, created_at_raw
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    post.board_id,
                    post.external_post_id,
                    comment.position,
                    comment.author,
                    comment.content_html,
                    comment.content_text,
                    comment.created_at_raw,
                )
                for comment in post.comments
            ],
        )
    connection.commit()
    return created


def run_vertical_slice(
    fixture: Path,
    url: str,
    database: Path,
    warc: Path,
) -> dict[str, Any]:
    fixture = fixture.expanduser().resolve(strict=True)
    database = database.expanduser().resolve()
    warc = warc.expanduser().resolve()
    for output in (database, warc):
        if output.exists():
            raise FileExistsError(f"refusing to overwrite: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)

    spider = TypeMoonSpider()
    request = Request(url, meta={"redstm_capture": True})
    response = HtmlResponse(
        url,
        request=request,
        body=fixture.read_bytes(),
        encoding="utf-8",
        headers={"Content-Type": "text/html; charset=utf-8"},
    )
    middleware = WarcCaptureMiddleware(warc)
    middleware.spider_opened(spider)
    try:
        middleware.process_response(request, response)
    finally:
        middleware.spider_closed(spider, "finished")

    items = list(spider.parse_detail(response))
    if len(items) != 1 or items[0].get("outcome") != "stored":
        raise RuntimeError("fixture did not produce exactly one stored post")
    normalized = normalize_captured_post(items[0])
    with sqlite3.connect(database) as connection:
        _initialize(connection)
        first_created = _project(connection, normalized)
        second_created = _project(connection, normalized)
        counts = {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("posts", "post_versions", "comments")
        }
        quick_check = [row[0] for row in connection.execute("PRAGMA quick_check")]

    return {
        "fixture": str(fixture),
        "url": url,
        "database": str(database),
        "warc": str(warc),
        "warc_record_id": normalized.warc_record_id,
        "content_sha256": normalized.content_sha256,
        "comments_sha256": normalized.comments_sha256,
        "first_created": first_created,
        "second_created": second_created,
        "counts": counts,
        "quick_check": quick_check,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local Phase 0 crawler vertical slice.")
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--url", required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--warc", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    result = run_vertical_slice(args.fixture, args.url, args.database, args.warc)
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output is None:
        print(rendered, end="")
    else:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(f"{output.suffix}.tmp")
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
