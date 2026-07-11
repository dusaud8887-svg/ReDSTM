from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from scrapy import Selector

_REQUIRED_COLUMNS = {"id", "board_id", "title", "author", "category", "content_html", "is_aa"}


def _sample_rowids(connection: sqlite3.Connection, sample_size: int) -> tuple[int, list[int]]:
    rowids = [int(row[0]) for row in connection.execute("SELECT rowid FROM posts ORDER BY rowid")]
    population = len(rowids)
    if population == 0:
        raise ValueError("posts table is empty")
    wanted = min(sample_size, population)
    if wanted == 1:
        return population, [rowids[0]]
    return population, [
        rowids[round(index * (population - 1) / (wanted - 1))] for index in range(wanted)
    ]


def _sample_rows(connection: sqlite3.Connection, rowids: list[int]) -> list[sqlite3.Row]:
    rows: list[sqlite3.Row] = []
    for offset in range(0, len(rowids), 500):
        chunk = rowids[offset : offset + 500]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(
            connection.execute(
                f"""
                SELECT rowid AS source_rowid, id AS external_post_id,
                       board_id, title, author, category, content_html, is_aa
                FROM posts
                WHERE rowid IN ({placeholders})
                """,
                chunk,
            ).fetchall()
        )
    rows.sort(key=lambda row: int(row["source_rowid"]))
    return rows


def _body_text(content_html: str) -> str:
    selector = Selector(text=content_html, type="html")
    parts = selector.xpath("//text()[not(ancestor::script) and not(ancestor::style)]").getall()
    return "\n".join(parts).strip()


def _used_bytes(connection: sqlite3.Connection) -> int:
    page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
    page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
    freelist = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
    return (page_count - freelist) * page_size


def profile_text_fts(source: Path, working_database: Path, *, sample_size: int) -> dict[str, Any]:
    if sample_size < 1:
        raise ValueError("sample_size must be positive")
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"not a file: {source}")
    working_database = working_database.expanduser().resolve()
    if working_database.exists():
        raise FileExistsError(f"refusing to overwrite: {working_database}")
    working_database.parent.mkdir(parents=True, exist_ok=True)
    source_before = source.stat()

    uri = f"{source.as_uri()}?mode=ro&immutable=1"
    extraction_started = time.perf_counter()
    with sqlite3.connect(uri, uri=True) as source_connection:
        source_connection.row_factory = sqlite3.Row
        columns = {str(row[1]) for row in source_connection.execute("PRAGMA table_info(posts)")}
        missing = sorted(_REQUIRED_COLUMNS - columns)
        if missing:
            raise ValueError(f"posts table is missing columns: {', '.join(missing)}")
        population, selected_rowids = _sample_rowids(source_connection, sample_size)
        source_rows = _sample_rows(source_connection, selected_rowids)

    documents = []
    html_bytes = 0
    text_bytes = 0
    aa_rows = 0
    boards: set[str] = set()
    for row in source_rows:
        content_html = str(row["content_html"])
        body_text = _body_text(content_html)
        html_bytes += len(content_html.encode("utf-8"))
        text_bytes += len(body_text.encode("utf-8"))
        aa_rows += int(bool(row["is_aa"]))
        boards.add(str(row["board_id"]))
        documents.append(
            (
                int(row["source_rowid"]),
                str(row["board_id"]),
                int(row["external_post_id"]),
                str(row["title"]),
                row["author"],
                row["category"],
                body_text,
            )
        )
    extraction_seconds = time.perf_counter() - extraction_started

    with sqlite3.connect(working_database) as destination:
        destination.execute("PRAGMA journal_mode=DELETE")
        destination.execute("PRAGMA synchronous=OFF")
        destination.execute("PRAGMA temp_store=MEMORY")
        destination.execute(
            """
            CREATE TABLE documents (
                source_rowid INTEGER PRIMARY KEY,
                board_id TEXT NOT NULL,
                external_post_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                author TEXT,
                category TEXT,
                body_text TEXT NOT NULL
            )
            """
        )
        destination.executemany(
            """
            INSERT INTO documents(
                source_rowid, board_id, external_post_id, title, author, category, body_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            documents,
        )
        destination.commit()
        destination.execute("VACUUM")
        documents_bytes = _used_bytes(destination)

        indexes: dict[str, Any] = {}
        previous_bytes = documents_bytes
        for name, tokenizer in (("fts_unicode61", "unicode61"), ("fts_trigram", "trigram")):
            started = time.perf_counter()
            destination.execute(
                f"""
                CREATE VIRTUAL TABLE {name} USING fts5(
                    title, author, category, body_text,
                    content='', tokenize='{tokenizer}'
                )
                """
            )
            destination.execute(
                f"""
                INSERT INTO {name}(rowid, title, author, category, body_text)
                SELECT source_rowid, title, author, category, body_text FROM documents
                """
            )
            destination.execute(f"INSERT INTO {name}({name}) VALUES ('optimize')")
            destination.commit()
            destination.execute("VACUUM")
            total_bytes = _used_bytes(destination)
            index_bytes = total_bytes - previous_bytes
            indexes[tokenizer] = {
                "index_bytes": index_bytes,
                "bytes_per_body_text_byte": round(index_bytes / text_bytes, 4)
                if text_bytes
                else None,
                "build_seconds": round(time.perf_counter() - started, 3),
            }
            previous_bytes = total_bytes

    source_after = source.stat()
    if (source_after.st_size, source_after.st_mtime_ns) != (
        source_before.st_size,
        source_before.st_mtime_ns,
    ):
        raise RuntimeError("source database changed during profiling")

    return {
        "source": str(source),
        "working_database": str(working_database),
        "sqlite_runtime": sqlite3.sqlite_version,
        "sampling": {
            "method": (
                "equally spaced by SQLite rowid; identity retained as board_id + external_post_id"
            ),
            "population_rows": population,
            "sample_rows": len(documents),
            "board_count": len(boards),
            "aa_rows": aa_rows,
        },
        "body_text": {
            "html_bytes": html_bytes,
            "text_bytes": text_bytes,
            "text_to_html_ratio": round(text_bytes / html_bytes, 6) if html_bytes else None,
            "extraction_seconds": round(extraction_seconds, 3),
            "sample_database_bytes": documents_bytes,
        },
        "fts5": indexes,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure body text and FTS5 size on a legacy sample."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--working-database", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=2_000)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    result = profile_text_fts(args.source, args.working_database, sample_size=args.sample_size)
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
