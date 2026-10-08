"""Find posts whose current version came from a cut-off detail response and queue them again.

From 2026-08-18 (f65ab0a) until d561e6e (2026-10-05) a detail response that broke off after
the article element was stored as a normal version. The WARC keeps those raw bytes, so a
current version whose response never reached ``</html>`` is a cut-off capture. Recollecting
it is safe now: an incomplete response no longer replaces the stored version.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from warcio.archiveiterator import ArchiveIterator  # type: ignore[import-untyped]

from crawler.archive import archive_transaction

_SALVAGE_SINCE = "2026-08-18"
_TAIL_BYTES = 4096


def _complete(payload: bytes) -> bool:
    if payload[:2] == b"\x1f\x8b":
        payload = gzip.decompress(payload)
    return b"</html>" in payload[-_TAIL_BYTES:].lower()


def current_captures(
    connection: sqlite3.Connection, *, since: str
) -> dict[str, dict[str, tuple[str, int]]]:
    """{warc_file: {record_id: (board_id, external_post_id)}} of current versions since."""
    by_file: dict[str, dict[str, tuple[str, int]]] = defaultdict(dict)
    for row in connection.execute(
        """SELECT p.board_id, p.external_post_id, v.warc_record_id, c.warc_file
           FROM posts AS p
           JOIN post_versions AS v ON v.id = p.latest_version_id
           JOIN captures AS c ON c.warc_record_id = v.warc_record_id AND c.post_id = p.id
           WHERE v.capture_origin = 'live' AND v.captured_at >= ?
             AND c.warc_file IS NOT NULL""",
        (since,),
    ):
        by_file[str(row["warc_file"])][str(row["warc_record_id"])] = (
            str(row["board_id"]),
            int(row["external_post_id"]),
        )
    return by_file


def find_truncated(
    by_file: dict[str, dict[str, tuple[str, int]]],
) -> tuple[list[tuple[str, int]], dict[str, int]]:
    truncated: list[tuple[str, int]] = []
    checked = unreadable = 0
    for warc_file, records in sorted(by_file.items()):
        path = Path(warc_file)
        if not path.is_file():
            unreadable += len(records)
            continue
        seen: set[str] = set()
        with path.open("rb") as stream:
            for record in ArchiveIterator(stream):
                record_id = record.rec_headers.get_header("WARC-Record-ID")
                if record.rec_type != "response" or record_id not in records:
                    continue
                seen.add(record_id)
                checked += 1
                if not _complete(record.content_stream().read()):
                    truncated.append(records[record_id])
        unreadable += len(records) - len(seen)
    return sorted(set(truncated)), {"checked": checked, "unreadable": unreadable}


def requeue(connection: sqlite3.Connection, posts: list[tuple[str, int]]) -> int:
    cursor = connection.executemany(
        """UPDATE crawl_frontier
           SET state = 'pending', attempts = 0, next_attempt_at = NULL, last_error_code = NULL,
               lease_token = NULL, lease_expires_at = NULL
           WHERE board_id = ? AND external_post_id = ? AND state <> 'running'""",
        posts,
    )
    return int(cursor.rowcount)


def main() -> None:
    parser = argparse.ArgumentParser(description="Queue posts stored from cut-off responses.")
    parser.add_argument("--archive", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--since", default=_SALVAGE_SINCE)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with archive_transaction(args.archive, read_only=True) as connection:
        by_file = current_captures(connection, since=args.since)
    truncated, counts = find_truncated(by_file)
    report: dict[str, object] = {
        "since": args.since,
        **counts,
        "truncated": len(truncated),
        "boards": {
            board: sum(1 for b, _ in truncated if b == board)
            for board in sorted({b for b, _ in truncated})
        },
        "sample": [f"{board}/{post}" for board, post in truncated[:20]],
        "requeued": 0,
    }
    if args.apply and truncated:
        with archive_transaction(args.archive) as connection:
            report["requeued"] = requeue(connection, truncated)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
