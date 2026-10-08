import io
from pathlib import Path

from warcio.statusandheaders import StatusAndHeaders  # type: ignore[import-untyped]
from warcio.warcwriter import WARCWriter  # type: ignore[import-untyped]

from crawler.archive import archive_transaction, initialize_archive
from scripts.requeue_truncated import current_captures, find_truncated, requeue

_COMPLETE = b"<html><body><article>full</article><footer>end</footer></body></html>\n"
_CUT = b"<html><body><article>half of the st"


def _warc(path: Path, bodies: dict[int, bytes]) -> dict[int, str]:
    ids: dict[int, str] = {}
    with path.open("wb") as stream:
        writer = WARCWriter(stream, gzip=True)
        for post_id, body in bodies.items():
            record = writer.create_warc_record(
                f"https://www.typemoon.net/write_free21/{post_id}",
                "response",
                payload=io.BytesIO(body),
                http_headers=StatusAndHeaders(
                    "200 OK", [("Content-Type", "text/html")], protocol="HTTP/1.1"
                ),
            )
            writer.write_record(record)
            ids[post_id] = record.rec_headers.get_header("WARC-Record-ID")
    return ids


def test_only_current_versions_cut_off_in_the_window_are_requeued(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    warc = tmp_path / "sync.warc.gz"
    # 1 complete, 2 cut off, 3 cut off before the window, 4 cut off but superseded.
    ids = _warc(warc, {1: _COMPLETE, 2: _CUT, 3: _CUT, 4: _CUT})
    with archive_transaction(archive) as connection:
        connection.execute(
            """INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
               VALUES ('write_free21', 'b', 'https://example.com', '2026-01-01', '2026-01-01')"""
        )
        connection.execute(
            """INSERT INTO crawl_runs (run_id, kind, status, started_at)
               VALUES ('r', 'sync', 'running', '2026-09-01')"""
        )
        for post_id, captured_at, current in (
            (1, "2026-09-01T00:00:00Z", True),
            (2, "2026-09-01T00:00:00Z", True),
            (3, "2026-08-01T00:00:00Z", True),
            (4, "2026-09-01T00:00:00Z", False),
        ):
            connection.execute(
                """INSERT INTO posts (id, board_id, external_post_id, canonical_url, title,
                   first_seen_at, last_seen_at) VALUES (?, 'write_free21', ?, ?, 't', ?, ?)""",
                (post_id, post_id, f"https://example.com/{post_id}", captured_at, captured_at),
            )
            connection.execute(
                """INSERT INTO post_versions (id, post_id, content_sha256, parser_version,
                   capture_origin, body_html_zstd, body_text_zstd, comments_sha256,
                   captured_at, warc_record_id)
                   VALUES (?, ?, ?, 'p', 'live', x'', x'', ?, ?, ?)""",
                (post_id, post_id, "a" * 64, "b" * 64, captured_at, ids[post_id]),
            )
            if current:
                connection.execute(
                    "UPDATE posts SET latest_version_id = ? WHERE id = ?", (post_id, post_id)
                )
            connection.execute(
                """INSERT INTO captures (run_id, url, entity_type, post_id, fetched_at,
                   http_status, outcome, warc_file, warc_record_id)
                   VALUES ('r', ?, 'post', ?, ?, 200, 'stored', ?, ?)""",
                (f"https://example.com/{post_id}", post_id, captured_at, str(warc), ids[post_id]),
            )
            connection.execute(
                """INSERT INTO crawl_frontier (board_id, external_post_id, url, state, attempts)
                   VALUES ('write_free21', ?, ?, 'done', 3)""",
                (post_id, f"https://example.com/{post_id}"),
            )

    with archive_transaction(archive, read_only=True) as connection:
        by_file = current_captures(connection, since="2026-08-18")
    truncated, counts = find_truncated(by_file)
    assert truncated == [("write_free21", 2)]
    assert counts == {"checked": 2, "unreadable": 0}

    with archive_transaction(archive) as connection:
        assert requeue(connection, truncated) == 1
    with archive_transaction(archive, read_only=True) as connection:
        states = dict(
            connection.execute(
                "SELECT external_post_id, state || ':' || attempts FROM crawl_frontier"
            ).fetchall()
        )
    assert states == {1: "done:3", 2: "pending:0", 3: "done:3", 4: "done:3"}


def test_a_missing_warc_counts_as_unreadable_not_truncated(tmp_path: Path) -> None:
    truncated, counts = find_truncated({str(tmp_path / "gone.warc.gz"): {"<id>": ("b", 1)}})
    assert truncated == [] and counts == {"checked": 0, "unreadable": 1}
