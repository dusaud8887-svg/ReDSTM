#!/usr/bin/env python3
"""Read-only aggregate profiling of *consistent standalone SQLite backup snapshots*.

No application imports, migrations, network, body reads, or source modifications.
Refuses non-empty WAL/journal sidecars: immutable mode must not ignore live changes.
Create a consistent backup using SQLite's backup facility first. Do NOT copy only
the main file from a live WAL database. This script cannot establish provenance of
a supplied backup; the operator is responsible for supplying a stable snapshot.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys
import time

VERSION = 1

def ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'

@contextmanager
def open_snapshot(path: Path):
    path = path.resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise ValueError("Non-empty WAL/journal found. Supply a consistent standalone backup.")
    before = (path.stat().st_size, path.stat().st_mtime_ns)
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    try:
        yield db
    finally:
        db.close()
        after = (path.stat().st_size, path.stat().st_mtime_ns)
        if before != after:
            raise RuntimeError("Snapshot changed during profiling; discard this report.")

def run_query(db, sql, parameters=(), seconds=15):
    deadline = time.monotonic() + seconds
    db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5000)
    try:
        return [dict(row) for row in db.execute(sql, parameters)]
    except sqlite3.OperationalError as exc:
        return {"status": "query_incomplete", "error": str(exc), "timeout_seconds": seconds}
    finally:
        db.set_progress_handler(None, 0)

def profile(path: Path, kind: str):
    with open_snapshot(path) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        columns = {}
        known = (
            ["posts", "collections", "collection_entries"] if kind == "typemoon" else
            ["text_archive_items", "text_novel_sources", "text_novel_chapters",
             "text_novel_work_groups", "text_novel_work_group_sources",
             "text_novel_work_aliases", "text_novel_link_candidates",
             "text_novel_identity_migrations"]
        )
        out = {"snapshot_name": path.name, "kind": kind,
               "sqlite_version": sqlite3.sqlite_version,
               "mode": "immutable standalone backup; query_only",
               "tables": {}, "metrics": {}, "warnings": []}
        for table in known:
            if table not in tables:
                out["warnings"].append(f"Missing table: {table}")
                continue
            cols = {row["name"] for row in db.execute(f"PRAGMA table_info({ident(table)})")}
            columns[table] = cols
            out["tables"][table] = {
                "columns": sorted(cols),
                "row_count": run_query(db, f"SELECT COUNT(*) AS n FROM {ident(table)}"),
            }

        def has(table, *names):
            return set(names) <= columns.get(table, set())

        def metric(name, sql):
            out["metrics"][name] = run_query(db, sql)

        if kind == "typemoon":
            if has("posts", "title", "author", "created_at_source", "category"):
                metric("metadata_coverage",
                    """SELECT COUNT(*) n,
                       SUM(CASE WHEN TRIM(COALESCE(title,''))<>'' THEN 1 ELSE 0 END) has_title,
                       SUM(CASE WHEN TRIM(COALESCE(author,''))<>'' THEN 1 ELSE 0 END) has_author_string,
                       SUM(CASE WHEN TRIM(COALESCE(created_at_source,''))<>'' THEN 1 ELSE 0 END) has_source_timestamp,
                       SUM(CASE WHEN TRIM(COALESCE(category,''))<>'' THEN 1 ELSE 0 END) has_category
                       FROM posts""")
            if has("posts", "availability"):
                metric("post_availability", "SELECT availability,COUNT(*) n FROM posts GROUP BY availability")
            if has("collections", "id", "kind") and has("collection_entries", "collection_id", "position"):
                metric("work_size_by_legacy_kind",
                    """SELECT kind,COUNT(*) works,MIN(n) min_entries,MAX(n) max_entries,
                       SUM(n) entries FROM
                       (SELECT c.kind,COUNT(ce.position) n FROM collections c
                        LEFT JOIN collection_entries ce ON ce.collection_id=c.id GROUP BY c.id,c.kind)
                       GROUP BY kind""")
            if has("collection_entries", "post_id", "collection_id"):
                metric("multi_collection_source_posts",
                    """SELECT COUNT(*) n FROM
                       (SELECT post_id FROM collection_entries WHERE post_id IS NOT NULL
                        GROUP BY post_id HAVING COUNT(DISTINCT collection_id)>1)""")
            if has("posts", "id") and has("collection_entries", "post_id"):
                metric("posts_without_legacy_membership",
                    """SELECT COUNT(*) n FROM posts p WHERE NOT EXISTS
                       (SELECT 1 FROM collection_entries ce WHERE ce.post_id=p.id)""")
        else:
            if has("text_archive_items", "lane", "author", "title", "canonical_work_id"):
                metric("item_metadata_by_lane",
                    """SELECT lane,COUNT(*) n,
                       SUM(CASE WHEN TRIM(COALESCE(author,''))<>'' THEN 1 ELSE 0 END) has_author_string,
                       SUM(CASE WHEN TRIM(COALESCE(title,''))<>'' THEN 1 ELSE 0 END) has_title,
                       SUM(CASE WHEN canonical_work_id IS NOT NULL THEN 1 ELSE 0 END) has_work_id
                       FROM text_archive_items GROUP BY lane""")
            if has("text_archive_items", "canonical_chapter_id", "lane"):
                metric("novel_chapter_id_namespaces",
                    """SELECT CASE
                         WHEN canonical_chapter_id LIKE 'novel_chapter:%' THEN 'novel_chapter:'
                         WHEN canonical_chapter_id LIKE 'novel:%' THEN 'novel:'
                         WHEN canonical_chapter_id IS NULL THEN 'NULL'
                         ELSE 'other' END namespace,COUNT(*) n
                       FROM text_archive_items WHERE lane='novel' GROUP BY namespace""")
            if has("text_novel_chapters", "status", "access"):
                metric("chapter_availability", "SELECT status,access,COUNT(*) n FROM text_novel_chapters GROUP BY status,access")
            if has("text_novel_chapters", "site", "source_work_id", "chapter_label", "chapter_kind"):
                metric("same_source_duplicate_labels",
                    """SELECT COUNT(*) sets,SUM(n) rows_in_sets FROM
                       (SELECT COUNT(*) n FROM text_novel_chapters
                        GROUP BY site,source_work_id,chapter_label,chapter_kind HAVING COUNT(*)>1)""")
            if has("text_novel_sources", "site", "source_work_id", "title") and has(
                    "text_novel_chapters", "site", "source_work_id", "chapter_label"):
                metric("source_title_equals_a_chapter_label_suspicion_only",
                    """SELECT COUNT(*) n FROM text_novel_sources s WHERE TRIM(s.title)<>''
                       AND EXISTS (SELECT 1 FROM text_novel_chapters c WHERE c.site=s.site
                         AND c.source_work_id=s.source_work_id AND c.chapter_label=s.title)""")
                out["warnings"].append(
                    "Title-equals-chapter-label is a suspicion count, NOT confirmed corruption.")
            if has("text_novel_work_group_sources", "canonical_work_id"):
                metric("source_count_per_group",
                    """SELECT n sources_per_group,COUNT(*) groups FROM
                       (SELECT canonical_work_id,COUNT(*) n FROM text_novel_work_group_sources
                        GROUP BY canonical_work_id) GROUP BY n ORDER BY n""")
            if has("text_novel_link_candidates", "status", "match_basis"):
                metric("link_decisions",
                    """SELECT status,match_basis,COUNT(*) n FROM text_novel_link_candidates
                       GROUP BY status,match_basis""")
            if has("text_novel_link_candidates", "left_site", "left_work_id", "match_basis", "status") and has(
                    "text_novel_work_group_sources", "site", "source_work_id", "canonical_work_id"):
                metric("weak_auto_links_touching_three_plus_source_groups",
                    """SELECT COUNT(*) n FROM text_novel_link_candidates c
                       JOIN text_novel_work_group_sources s
                         ON s.site=c.left_site AND s.source_work_id=c.left_work_id
                       WHERE c.status='auto_accepted'
                         AND c.match_basis='normalized_title_author+chapter_sequence'
                         AND (SELECT COUNT(*) FROM text_novel_work_group_sources x
                              WHERE x.canonical_work_id=s.canonical_work_id)>=3""")
                out["warnings"].append(
                    "Migration v3 rewrites old weak edge labels; absence of weak labels does not prove groups are repaired.")
            if has("text_novel_identity_migrations", "version", "completed_at"):
                metric("migration_markers", "SELECT version,completed_at FROM text_novel_identity_migrations ORDER BY version")
        out["warnings"].append("Aggregate profile is not a labeled precision/recall evaluation.")
        return out

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--typemoon-db", type=Path)
    p.add_argument("--text-db", type=Path)
    p.add_argument("--output", type=Path, help="New JSON path only; existing file is never overwritten.")
    args = p.parse_args()
    if not args.typemoon_db and not args.text_db:
        p.error("Provide at least one standalone backup snapshot.")
    report = {"schema_version": VERSION,
              "generated_at": datetime.now(timezone.utc).isoformat(),
              "production_database_examined_by_author": False, "profiles": []}
    for key, path in [("typemoon", args.typemoon_db), ("text", args.text_db)]:
        if path:
            report["profiles"].append(profile(path, key))
    content = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(content)
    else:
        sys.stdout.write(content)

if __name__ == "__main__":
    main()
