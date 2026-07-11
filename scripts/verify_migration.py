from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

from crawler.archive import archive_health, connect_archive
from scripts.legacy_common import build_legacy_post_item, normalize_legacy_post

_SOURCE_TABLES = {
    "boards": "boards",
    "posts": "posts",
    "comments": "comments",
    "collections": "collections",
    "collection_entries": "collection_episodes",
    "bookmarks": "bookmarks",
    "reading_progress": "reading_history",
    "settings": "settings",
    "frontier": "post_queue",
}
_TARGET_TABLES = {
    **_SOURCE_TABLES,
    "collection_entries": "collection_entries",
    "reading_progress": "reading_progress",
    "frontier": "crawl_frontier",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 << 20):
            digest.update(block)
    return digest.hexdigest()


def _counts(connection: sqlite3.Connection, tables: dict[str, str]) -> dict[str, int]:
    return {
        name: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        for name, table in tables.items()
    }


def _sample_rowids(connection: sqlite3.Connection, sample_size: int = 500) -> list[int]:
    rowids = [int(row[0]) for row in connection.execute("SELECT rowid FROM posts ORDER BY rowid")]
    wanted = min(sample_size, len(rowids))
    if wanted < 2:
        return rowids
    return [rowids[round(index * (len(rowids) - 1) / (wanted - 1))] for index in range(wanted)]


def verify_migration(
    source_path: Path,
    target_path: Path,
    *,
    expected_source_sha256: str | None = None,
) -> dict[str, Any]:
    source_path = source_path.expanduser().resolve(strict=True)
    target_path = target_path.expanduser().resolve(strict=True)
    if source_path == target_path:
        raise ValueError("source and target databases must differ")
    source_before = source_path.stat()

    print("[1/5] counting source and target rows", file=sys.stderr, flush=True)
    with (
        sqlite3.connect(f"{source_path.as_uri()}?mode=ro&immutable=1", uri=True) as source,
        connect_archive(target_path, read_only=True) as target,
    ):
        source_counts = _counts(source, _SOURCE_TABLES)
        target_counts = _counts(target, _TARGET_TABLES)
        legacy_versions = int(
            target.execute(
                "SELECT COUNT(*) FROM post_versions WHERE capture_origin = 'legacy_import'"
            ).fetchone()[0]
        )
        missing_latest_versions = int(
            target.execute(
                """
                SELECT COUNT(*) FROM posts
                WHERE availability <> 'missing' AND latest_version_id IS NULL
                """
            ).fetchone()[0]
        )

    issues = [
        f"{name}: source={count}, target={target_counts[name]}"
        for name, count in source_counts.items()
        if name != "posts" and target_counts[name] != count
    ]
    if legacy_versions != source_counts["posts"]:
        issues.append(
            f"legacy versions: source posts={source_counts['posts']}, target={legacy_versions}"
        )
    if missing_latest_versions:
        issues.append(f"available posts without latest version: {missing_latest_versions}")

    print("[2/5] comparing 500 deterministic source transformations", file=sys.stderr, flush=True)
    sample_errors: list[str] = []
    with (
        sqlite3.connect(f"{source_path.as_uri()}?mode=ro&immutable=1", uri=True) as source,
        connect_archive(target_path, read_only=True) as target,
    ):
        source.row_factory = sqlite3.Row
        for rowid in _sample_rowids(source):
            row = source.execute(
                """
                SELECT id, board_id, title, author, category, content_html,
                       is_aa, views, created_at, crawled_at
                FROM posts WHERE rowid = ?
                """,
                (rowid,),
            ).fetchone()
            assert row is not None
            item, _ = build_legacy_post_item(source, row)
            normalized, _ = normalize_legacy_post(item)
            migrated = target.execute(
                """
                SELECT p.title, p.author, p.category, p.created_at_raw, p.views,
                       p.comment_count, p.is_aa, v.content_sha256, v.comments_sha256
                FROM posts AS p
                JOIN post_versions AS v ON v.id = p.latest_version_id
                WHERE p.board_id = ? AND p.external_post_id = ?
                """,
                (normalized.board_id, normalized.external_post_id),
            ).fetchone()
            expected = (
                normalized.title,
                normalized.author,
                normalized.category,
                normalized.created_at_raw,
                normalized.views,
                len(normalized.comments),
                int(normalized.is_aa),
                normalized.content_sha256,
                normalized.comments_sha256,
            )
            if migrated is None or tuple(migrated) != expected:
                sample_errors.append(f"{normalized.board_id}/{normalized.external_post_id}")
    if sample_errors:
        examples = ", ".join(sample_errors[:10])
        issues.append(f"deterministic sample mismatches: {len(sample_errors)} ({examples})")

    print("[3/5] running SQLite quick_check and foreign_key_check", file=sys.stderr, flush=True)
    health = archive_health(target_path)
    if health["quick_check"] != ["ok"]:
        issues.append(f"quick_check: {health['quick_check']}")
    if health["foreign_key_errors"]:
        issues.append(f"foreign key errors: {len(health['foreign_key_errors'])}")

    print("[4/5] hashing immutable source", file=sys.stderr, flush=True)
    source_sha256 = _sha256(source_path)
    if expected_source_sha256 and source_sha256 != expected_source_sha256.lower():
        issues.append("source SHA-256 does not match expected value")

    print("[5/5] hashing canonical target", file=sys.stderr, flush=True)
    target_sha256 = _sha256(target_path)
    source_after = source_path.stat()
    if (source_before.st_size, source_before.st_mtime_ns) != (
        source_after.st_size,
        source_after.st_mtime_ns,
    ):
        issues.append("source database changed during verification")

    return {
        "ok": not issues,
        "issues": issues,
        "source": {
            "path": str(source_path),
            "bytes": source_before.st_size,
            "sha256": source_sha256,
            "counts": source_counts,
        },
        "target": {
            "path": str(target_path),
            "bytes": target_path.stat().st_size,
            "sha256": target_sha256,
            "counts": target_counts,
            "legacy_versions": legacy_versions,
            "placeholder_posts": target_counts["posts"] - source_counts["posts"],
            "deterministic_sample_size": min(500, source_counts["posts"]),
            "deterministic_sample_mismatches": len(sample_errors),
            "health": health,
        },
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a completed legacy migration.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--expected-source-sha256")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = verify_migration(
        args.source,
        args.target,
        expected_source_sha256=args.expected_source_sha256,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
