from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_REQUIRED_TABLES = {"boards", "comments", "posts"}


def _quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _row_dict(
    connection: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()
) -> dict[str, Any]:
    row = connection.execute(sql, params).fetchone()
    return {} if row is None else dict(row)


def _length_stats(values: list[int], *, rows: int) -> dict[str, int | float | None]:
    values.sort()

    def percentile(value: float) -> int | None:
        if not values:
            return None
        return values[min(len(values) - 1, math.ceil(len(values) * value) - 1)]

    total = sum(values)
    return {
        "rows": rows,
        "nulls": rows - len(values),
        "nonempty": sum(value > 0 for value in values),
        "total": total,
        "average": round(total / len(values), 2) if values else None,
        "p50": percentile(0.50),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
        "max": values[-1] if values else None,
    }


def _query_plan(
    connection: sqlite3.Connection, sql: str, params: tuple[Any, ...]
) -> list[dict[str, Any]]:
    return [
        {"id": row[0], "parent": row[1], "detail": row[3]}
        for row in connection.execute(f"EXPLAIN QUERY PLAN {sql}", params)
    ]


def _benchmark(
    connection: sqlite3.Connection,
    sql: str,
    params: tuple[Any, ...],
    *,
    repeats: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    timings: list[float] = []
    row_count = 0
    try:
        plan = _query_plan(connection, sql, params)
        for _ in range(repeats):
            deadline = time.perf_counter() + timeout_seconds
            connection.set_progress_handler(
                lambda: int(time.perf_counter() >= deadline),
                10_000,
            )
            started = time.perf_counter()
            rows = connection.execute(sql, params).fetchall()
            timings.append((time.perf_counter() - started) * 1000)
            row_count = len(rows)
    except sqlite3.DatabaseError as exc:
        return {"error": str(exc)}
    finally:
        connection.set_progress_handler(None, 0)

    warm = timings[1:] or timings
    return {
        "rows_returned": row_count,
        "first_ms": round(timings[0], 3),
        "warm_median_ms": round(statistics.median(warm), 3),
        "runs_ms": [round(value, 3) for value in timings],
        "plan": plan,
    }


def _search_term(author: str | None, title: str | None) -> str | None:
    candidates = re.findall(r"[^\W_]{2,}", f"{author or ''} {title or ''}")
    return max(candidates, key=len) if candidates else None


def _benchmarks(
    connection: sqlite3.Connection,
    tables: set[str],
    board_id: str,
    post_id: int,
    comment_post_id: int,
    comment_board_id: str,
    search_author: str | None,
    title: str | None,
    *,
    repeats: int,
    timeout_seconds: float,
) -> dict[str, Any]:
    queries: dict[str, tuple[str, tuple[Any, ...]]] = {
        "global_post_list": (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category, p.is_aa,
                   p.views, p.created_at, p.comment_count, b.name AS board_name
            FROM posts p LEFT JOIN boards b ON p.board_id = b.id
            ORDER BY p.created_at DESC, p.id DESC LIMIT 50
            """,
            (),
        ),
        "board_post_list": (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category, p.is_aa,
                   p.views, p.created_at, p.comment_count, b.name AS board_name
            FROM posts p LEFT JOIN boards b ON p.board_id = b.id
            WHERE p.board_id = ?
            ORDER BY p.created_at DESC, p.id DESC LIMIT 50
            """,
            (board_id,),
        ),
        "post_detail": (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category, p.content_html,
                   p.content_text, p.is_aa, p.views, p.created_at, p.comment_count,
                   b.name AS board_name
            FROM posts p LEFT JOIN boards b ON p.board_id = b.id
            WHERE p.id = ? AND p.board_id = ?
            """,
            (post_id, board_id),
        ),
        "post_comments": (
            """
            SELECT id, author, content, created_at, parent_id, depth
            FROM comments WHERE post_id = ? AND board_id = ?
            ORDER BY id ASC LIMIT 500
            """,
            (comment_post_id, comment_board_id),
        ),
    }

    if {"collections", "collection_episodes"} <= tables:
        queries["collection_list"] = (
            """
            SELECT id, board_id, collection_type, title, episode_count,
                   total_views, total_comments, last_created_at
            FROM collections
            ORDER BY last_created_at DESC LIMIT 50
            """,
            (),
        )

    term = _search_term(search_author, title)
    if "posts_fts" in tables and term:
        fts_query = f'"{term.replace(chr(34), chr(34) * 2)}"*'
        queries["metadata_fts_legacy"] = (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category,
                   snippet(posts_fts, -1, '<mark>', '</mark>', '...', 32) AS snippet,
                   COUNT(*) OVER() AS total
            FROM posts_fts fts JOIN posts p ON fts.rowid = p.rowid
            WHERE posts_fts MATCH ?
            ORDER BY p.id DESC LIMIT 50
            """,
            (fts_query,),
        )
        queries["metadata_fts_page"] = (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category,
                   snippet(posts_fts, -1, '<mark>', '</mark>', '...', 32) AS snippet
            FROM posts_fts fts JOIN posts p ON fts.rowid = p.rowid
            WHERE posts_fts MATCH ?
            ORDER BY p.id DESC LIMIT 50
            """,
            (fts_query,),
        )
        queries["metadata_fts_count"] = (
            "SELECT COUNT(*) FROM posts_fts WHERE posts_fts MATCH ?",
            (fts_query,),
        )
        like_term = f"%{term}%"
        queries["metadata_like_fallback"] = (
            """
            SELECT p.id, p.board_id, p.title, p.author, p.category,
                   COUNT(*) OVER() AS total
            FROM posts p
            WHERE p.title LIKE ? OR p.author LIKE ?
            ORDER BY p.id DESC LIMIT 50
            """,
            (like_term, like_term),
        )

    return {
        name: _benchmark(
            connection,
            sql,
            params,
            repeats=repeats,
            timeout_seconds=timeout_seconds,
        )
        for name, (sql, params) in queries.items()
    }


def profile_legacy_database(
    path: Path,
    *,
    benchmark_repeats: int = 3,
    query_timeout_seconds: float = 30,
) -> dict[str, Any]:
    database_path = path.expanduser().resolve(strict=True)
    before = database_path.stat()
    uri = f"{database_path.as_uri()}?mode=ro&immutable=1"

    with sqlite3.connect(uri, uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        table_names = [
            str(row[0])
            for row in connection.execute(
                """
                SELECT name FROM sqlite_master
                WHERE type='table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            )
        ]
        tables = set(table_names)
        missing = sorted(_REQUIRED_TABLES - tables)
        if missing:
            raise ValueError(f"missing legacy tables: {', '.join(missing)}")

        print("[legacy-profile] counting tables", file=sys.stderr)
        table_counts = {
            name: int(
                connection.execute(f"SELECT COUNT(*) FROM {_quote_identifier(name)}").fetchone()[0]
            )
            for name in table_names
        }

        print("[legacy-profile] scanning post field sizes", file=sys.stderr)
        lengths: dict[str, list[int]] = {
            "content_html_bytes": [],
            "content_text_bytes": [],
            "raw_html_bytes": [],
        }
        for row in connection.execute(
            """
            SELECT length(CAST(content_html AS BLOB)),
                   length(CAST(content_text AS BLOB)),
                   length(CAST(raw_html AS BLOB))
            FROM posts
            """
        ):
            for key, value in zip(lengths, row, strict=True):
                if value is not None:
                    lengths[key].append(int(value))
        post_field_sizes = {
            key: _length_stats(values, rows=table_counts["posts"])
            for key, values in lengths.items()
        }
        del lengths

        print("[legacy-profile] scanning comment field sizes", file=sys.stderr)
        comment_lengths = [
            int(row[0])
            for row in connection.execute("SELECT length(CAST(content AS BLOB)) FROM comments")
            if row[0] is not None
        ]
        comment_size_stats = _length_stats(comment_lengths, rows=table_counts["comments"])
        del comment_lengths

        board_rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT board_id, COUNT(*) AS posts, SUM(is_aa = 1) AS aa_posts,
                       MIN(created_at) AS first_created_at, MAX(created_at) AS last_created_at
                FROM posts GROUP BY board_id ORDER BY posts DESC
                """
            )
        ]
        busiest_board = str(board_rows[0]["board_id"])
        sample = connection.execute(
            """
            SELECT id, board_id, author, title FROM posts
            WHERE board_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
            """,
            (busiest_board,),
        ).fetchone()
        if sample is None:
            raise ValueError("legacy posts table is empty")
        comment_sample = connection.execute(
            """
            SELECT post_id, board_id, COUNT(*) AS comments
            FROM comments GROUP BY post_id, board_id
            ORDER BY comments DESC LIMIT 1
            """
        ).fetchone()
        comment_post_id = int(comment_sample["post_id"] if comment_sample else sample["id"])
        comment_board_id = str(comment_sample["board_id"] if comment_sample else sample["board_id"])
        top_author = connection.execute(
            """
            SELECT author, COUNT(*) AS posts FROM posts
            WHERE author IS NOT NULL AND author <> ''
            GROUP BY author ORDER BY posts DESC LIMIT 1
            """
        ).fetchone()

        duplicate_hashes = _row_dict(
            connection,
            """
            SELECT COUNT(*) AS groups, COALESCE(SUM(rows_in_group), 0) AS rows,
                   COALESCE(SUM(rows_in_group - 1), 0) AS redundant_rows
            FROM (
                SELECT COUNT(*) AS rows_in_group FROM posts
                WHERE content_hash IS NOT NULL AND content_hash <> ''
                GROUP BY content_hash HAVING COUNT(*) > 1
            )
            """,
        )
        duplicate_external_ids = _row_dict(
            connection,
            """
            SELECT COUNT(*) AS groups, COALESCE(SUM(rows_in_group), 0) AS rows,
                   COALESCE(SUM(rows_in_group - 1), 0) AS redundant_rows
            FROM (
                SELECT COUNT(*) AS rows_in_group FROM posts
                GROUP BY id HAVING COUNT(*) > 1
            )
            """,
        )
        quality = _row_dict(
            connection,
            """
            SELECT SUM(content_html IS NULL OR content_html = '') AS missing_content_html,
                   SUM(content_text IS NULL OR content_text = '') AS missing_content_text,
                   SUM(raw_html IS NULL OR raw_html = '') AS missing_raw_html,
                   SUM(content_hash IS NULL OR content_hash = '') AS missing_content_hash,
                   SUM(url IS NULL OR url = '') AS missing_url,
                   SUM(
                       attachments IS NOT NULL AND attachments NOT IN ('', '[]')
                   ) AS with_attachments,
                   MIN(created_at) AS first_created_at, MAX(created_at) AS last_created_at,
                   MIN(crawled_at) AS first_crawled_at, MAX(crawled_at) AS last_crawled_at
            FROM posts
            """,
        )
        post_date_formats = [
            dict(row)
            for row in connection.execute(
                """
                SELECT CASE
                    WHEN created_at IS NULL OR created_at = '' THEN 'missing'
                    WHEN created_at GLOB '????-??-?? ??:??*' THEN 'dash'
                    WHEN created_at GLOB '????.??.?? ??:??*' THEN 'dot'
                    ELSE 'other'
                END AS format, COUNT(*) AS rows
                FROM posts GROUP BY format ORDER BY rows DESC
                """
            )
        ]
        comment_rows = [
            dict(row)
            for row in connection.execute(
                """
                SELECT board_id, COUNT(*) AS comments,
                       SUM(parent_id IS NOT NULL) AS replies, MAX(depth) AS max_depth
                FROM comments GROUP BY board_id ORDER BY comments DESC
                """
            )
        ]
        relationships = {
            "posts_without_board": connection.execute(
                """
                SELECT COUNT(*) FROM posts p
                LEFT JOIN boards b ON b.id=p.board_id WHERE b.id IS NULL
                """
            ).fetchone()[0],
            "comments_without_board": connection.execute(
                """
                SELECT COUNT(*) FROM comments c
                LEFT JOIN boards b ON b.id=c.board_id WHERE b.id IS NULL
                """
            ).fetchone()[0],
            "comments_without_post": connection.execute(
                """
                SELECT COUNT(*) FROM comments c LEFT JOIN posts p
                ON p.id=c.post_id AND p.board_id=c.board_id WHERE p.rowid IS NULL
                """
            ).fetchone()[0],
        }
        if {"collection_episodes", "collections"} <= tables:
            relationships["collection_episodes_without_collection"] = connection.execute(
                """
                SELECT COUNT(*) FROM collection_episodes ce LEFT JOIN collections c
                ON c.id=ce.collection_id WHERE c.id IS NULL
                """
            ).fetchone()[0]
            relationships["collection_episodes_without_post"] = connection.execute(
                """
                SELECT COUNT(*) FROM collection_episodes ce LEFT JOIN posts p
                ON p.id=ce.post_id AND p.board_id=ce.board_id WHERE p.rowid IS NULL
                """
            ).fetchone()[0]

        states: dict[str, list[dict[str, Any]]] = {}
        for table, column in (
            ("post_queue", "status"),
            ("crawl_log", "status"),
            ("crawler_runs", "status"),
        ):
            if table in tables:
                states[table] = [
                    dict(row)
                    for row in connection.execute(
                        f"SELECT {_quote_identifier(column)} AS value, COUNT(*) AS rows "
                        f"FROM {_quote_identifier(table)} "
                        f"GROUP BY {_quote_identifier(column)} ORDER BY rows DESC"
                    )
                ]

        print("[legacy-profile] benchmarking viewer queries", file=sys.stderr)
        benchmarks = _benchmarks(
            connection,
            tables,
            busiest_board,
            int(sample["id"]),
            comment_post_id,
            comment_board_id,
            top_author["author"] if top_author is not None else sample["author"],
            sample["title"],
            repeats=benchmark_repeats,
            timeout_seconds=query_timeout_seconds,
        )

    after = database_path.stat()
    return {
        "generated_utc": datetime.now(UTC).isoformat(),
        "database": {
            "path": str(database_path),
            "size_bytes": before.st_size,
            "modified_utc_ns": before.st_mtime_ns,
            "unchanged": (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
            "sqlite_runtime": sqlite3.sqlite_version,
        },
        "table_counts": table_counts,
        "posts": {
            "quality": quality,
            "field_sizes": post_field_sizes,
            "duplicate_content_hashes": duplicate_hashes,
            "duplicate_external_ids": duplicate_external_ids,
            "created_at_formats": post_date_formats,
            "by_board": board_rows,
        },
        "comments": {"content_bytes": comment_size_stats, "by_board": comment_rows},
        "relationships": relationships,
        "state_values": states,
        "benchmark_sample": {
            "board_id": busiest_board,
            "post_id": int(sample["id"]),
            "comment_board_id": comment_board_id,
            "comment_post_id": comment_post_id,
            "search_term": _search_term(
                top_author["author"] if top_author is not None else sample["author"],
                sample["title"],
            ),
        },
        "viewer_query_benchmarks": benchmarks,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Profile the legacy DSOTM SQLite snapshot.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--benchmark-repeats", type=int, default=3)
    parser.add_argument("--query-timeout-seconds", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.benchmark_repeats < 1 or args.query_timeout_seconds <= 0:
        raise SystemExit("benchmark repeats and query timeout must be positive")
    profile = profile_legacy_database(
        args.database,
        benchmark_repeats=args.benchmark_repeats,
        query_timeout_seconds=args.query_timeout_seconds,
    )
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.tmp")
    temporary.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
