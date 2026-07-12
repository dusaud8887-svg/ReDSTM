from __future__ import annotations

import hashlib
import sqlite3
from compression import zstd
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 4
APPLICATION_ID = 0x52445354  # RDST
BODY_COMPRESSION_LEVEL = 3

_SCHEMA_V1 = """
CREATE TABLE boards (
    board_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT,
    canonical_url TEXT NOT NULL UNIQUE,
    is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    reported_post_count INTEGER CHECK (reported_post_count >= 0),
    last_inventory_at TEXT
) STRICT;

CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(board_id),
    external_post_id INTEGER NOT NULL CHECK (external_post_id > 0),
    canonical_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT,
    category TEXT,
    created_at_source TEXT,
    created_at_raw TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_collected_at TEXT,
    availability TEXT NOT NULL DEFAULT 'unknown'
        CHECK (availability IN ('available', 'restricted', 'missing', 'deleted', 'unknown')),
    latest_version_id INTEGER REFERENCES post_versions(id) DEFERRABLE INITIALLY DEFERRED,
    views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
    comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
    is_aa INTEGER NOT NULL DEFAULT 0 CHECK (is_aa IN (0, 1)),
    UNIQUE (board_id, external_post_id)
) STRICT;

CREATE TABLE post_versions (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    raw_sha256 TEXT CHECK (raw_sha256 IS NULL OR length(raw_sha256) = 64),
    parser_version TEXT NOT NULL,
    capture_origin TEXT NOT NULL
        CHECK (capture_origin IN ('live', 'legacy_import', 'reparse')),
    body_html_zstd BLOB NOT NULL,
    body_text_zstd BLOB NOT NULL,
    comments_sha256 TEXT NOT NULL CHECK (length(comments_sha256) = 64),
    captured_at TEXT NOT NULL,
    warc_record_id TEXT,
    UNIQUE (post_id, content_sha256, comments_sha256)
) STRICT;

CREATE TABLE comments (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position > 0),
    source_comment_id TEXT,
    author TEXT,
    content_html TEXT NOT NULL,
    content_text TEXT NOT NULL,
    created_at_source TEXT,
    created_at_raw TEXT,
    parent_position INTEGER,
    depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
    PRIMARY KEY (post_id, position),
    FOREIGN KEY (post_id, parent_position)
        REFERENCES comments(post_id, position) DEFERRABLE INITIALLY DEFERRED,
    CHECK (parent_position IS NULL OR parent_position < position)
) STRICT;

CREATE TABLE crawl_runs (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sync', 'backfill', 'retry', 'inventory', 'import')),
    status TEXT NOT NULL
        CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    discovered INTEGER NOT NULL DEFAULT 0 CHECK (discovered >= 0),
    fetched INTEGER NOT NULL DEFAULT 0 CHECK (fetched >= 0),
    changed INTEGER NOT NULL DEFAULT 0 CHECK (changed >= 0),
    unchanged INTEGER NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
    failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
    summary_json TEXT NOT NULL DEFAULT '{}',
    CHECK ((status = 'running' AND finished_at IS NULL)
        OR (status <> 'running' AND finished_at IS NOT NULL))
) STRICT;

CREATE TABLE captures (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES crawl_runs(run_id),
    url TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('listing', 'post', 'asset')),
    post_id INTEGER REFERENCES posts(id),
    fetched_at TEXT NOT NULL,
    http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
    outcome TEXT NOT NULL CHECK (
        outcome IN ('stored', 'unchanged', 'restricted', 'missing', 'parse_failed', 'fetch_failed')
    ),
    etag TEXT,
    last_modified TEXT,
    raw_sha256 TEXT CHECK (raw_sha256 IS NULL OR length(raw_sha256) = 64),
    warc_file TEXT,
    warc_record_id TEXT,
    error_code TEXT
) STRICT;

CREATE TABLE crawl_frontier (
    board_id TEXT NOT NULL,
    external_post_id INTEGER NOT NULL CHECK (external_post_id > 0),
    url TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'running', 'retry', 'done', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT,
    last_error_code TEXT,
    last_attempt_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    PRIMARY KEY (board_id, external_post_id),
    CHECK (
        (state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
    )
) STRICT;

CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    board_id TEXT REFERENCES boards(board_id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (board_id, title)
) STRICT;

CREATE TABLE collection_entries (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position > 0),
    post_id INTEGER REFERENCES posts(id),
    source_external_post_id INTEGER,
    title TEXT,
    PRIMARY KEY (collection_id, position),
    UNIQUE (collection_id, post_id)
) STRICT;

CREATE TABLE bookmarks (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    note TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE reading_progress (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    scroll_position REAL NOT NULL DEFAULT 0 CHECK (scroll_position >= 0)
) STRICT;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX posts_board_created_idx
    ON posts(board_id, created_at_source DESC, external_post_id DESC);
CREATE INDEX posts_availability_idx ON posts(availability);
CREATE INDEX post_versions_post_captured_idx ON post_versions(post_id, captured_at DESC);
CREATE INDEX captures_post_fetched_idx ON captures(post_id, fetched_at DESC);
CREATE INDEX captures_run_idx ON captures(run_id);
CREATE INDEX crawl_frontier_claim_idx
    ON crawl_frontier(state, next_attempt_at, priority DESC, board_id, external_post_id);

CREATE TRIGGER posts_latest_version_insert
BEFORE INSERT ON posts
WHEN NEW.latest_version_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'latest version must be assigned after post insert');
END;

CREATE TRIGGER posts_latest_version_update
BEFORE UPDATE OF latest_version_id ON posts
WHEN NEW.latest_version_id IS NOT NULL
     AND NOT EXISTS (
         SELECT 1 FROM post_versions
         WHERE id = NEW.latest_version_id AND post_id = NEW.id
     )
BEGIN
    SELECT RAISE(ABORT, 'latest version belongs to another post');
END;
"""

_SCHEMA_V2 = """
CREATE INDEX captures_raw_sha256_idx
    ON captures(raw_sha256, url)
    WHERE raw_sha256 IS NOT NULL AND warc_file IS NOT NULL AND warc_record_id IS NOT NULL;
"""

_SCHEMA_V3 = """
ALTER TABLE boards ADD COLUMN inventory_next_page INTEGER NOT NULL DEFAULT 1
    CHECK (inventory_next_page >= 1);
"""

_SCHEMA_V4 = """
ALTER TABLE crawl_frontier ADD COLUMN expected_comment_count INTEGER
    CHECK (expected_comment_count >= 0);

UPDATE crawl_frontier
SET expected_comment_count = (
    SELECT post.comment_count
    FROM posts AS post
    WHERE post.board_id = crawl_frontier.board_id
      AND post.external_post_id = crawl_frontier.external_post_id
)
WHERE EXISTS (
    SELECT 1
    FROM posts AS post
    WHERE post.board_id = crawl_frontier.board_id
      AND post.external_post_id = crawl_frontier.external_post_id
);
"""


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    sql: str
    static_projection_compatible: bool

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.sql.encode()).hexdigest()


MIGRATIONS = (
    Migration(1, _SCHEMA_V1, False),
    Migration(2, _SCHEMA_V2, False),
    Migration(3, _SCHEMA_V3, False),
    Migration(4, _SCHEMA_V4, True),
)


def compress_body(value: str) -> bytes:
    return zstd.compress(value.encode(), level=BODY_COMPRESSION_LEVEL)


def decompress_body(value: bytes) -> str:
    return zstd.decompress(value).decode()


def connect_archive(path: str | Path, *, read_only: bool = False) -> sqlite3.Connection:
    archive_path = Path(path).expanduser().resolve()
    if read_only:
        connection = sqlite3.connect(f"{archive_path.as_uri()}?mode=ro", uri=True, timeout=5)
        connection.execute("PRAGMA query_only = ON")
    else:
        connection = sqlite3.connect(archive_path, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA trusted_schema = OFF")
    return connection


def initialize_archive(path: str | Path) -> None:
    archive_path = Path(path).expanduser().resolve()
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with connect_archive(archive_path) as connection:
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) STRICT
            """
        )
        applied = {
            int(row["version"]): str(row["sha256"])
            for row in connection.execute(
                "SELECT version, sha256 FROM schema_migrations ORDER BY version"
            )
        }
        known_versions = {migration.version for migration in MIGRATIONS}
        unknown = sorted(set(applied) - known_versions)
        if unknown:
            raise RuntimeError(f"archive has unknown migration versions: {unknown}")

        for migration in MIGRATIONS:
            existing_hash = applied.get(migration.version)
            if existing_hash is not None:
                if existing_hash != migration.sha256:
                    raise RuntimeError(
                        f"archive migration {migration.version} hash does not match source"
                    )
                continue
            script = f"""
            BEGIN IMMEDIATE;
            {migration.sql}
            INSERT INTO schema_migrations (version, sha256)
            VALUES ({migration.version}, '{migration.sha256}');
            PRAGMA user_version = {migration.version};
            COMMIT;
            """
            try:
                connection.executescript(script)
            except Exception:
                if connection.in_transaction:
                    connection.rollback()
                raise
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def validate_archive_for_release(
    connection: sqlite3.Connection,
    *,
    target_schema_version: int,
    target_migration_hashes: dict[int, str],
) -> None:
    if (
        type(target_schema_version) is not int
        or target_schema_version < 1
        or any(
            type(version) is not int
            or version < 1
            or not isinstance(sha256, str)
            or len(sha256) != 64
            for version, sha256 in target_migration_hashes.items()
        )
        or set(target_migration_hashes) != set(range(1, target_schema_version + 1))
    ):
        raise RuntimeError("rollback target migration metadata is invalid")

    if int(connection.execute("PRAGMA application_id").fetchone()[0]) != APPLICATION_ID:
        raise RuntimeError("canonical archive application id is invalid")
    user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    applied = {
        int(row["version"]): str(row["sha256"])
        for row in connection.execute("SELECT version, sha256 FROM schema_migrations")
    }
    if set(applied) != set(range(1, user_version + 1)):
        raise RuntimeError("canonical migration ledger is inconsistent")

    source_known = {migration.version: migration.sha256 for migration in MIGRATIONS}
    if any(source_known.get(version) != sha256 for version, sha256 in applied.items()):
        raise RuntimeError("canonical migration ledger does not match the current release")
    if user_version > target_schema_version or any(
        target_migration_hashes.get(version) != sha256 for version, sha256 in applied.items()
    ):
        raise RuntimeError(f"rollback release does not support canonical schema v{user_version}")

    if user_version >= 4:
        columns = [
            tuple(row)[1:]
            for row in connection.execute("PRAGMA table_xinfo(crawl_frontier)")
            if row[1] == "expected_comment_count"
        ]
        expected = [("expected_comment_count", "INTEGER", 0, None, 0, 0)]
        table_row = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'crawl_frontier'"
        ).fetchone()
        table_sql = " ".join(str(table_row[0]).split()).upper() if table_row is not None else ""
        check_clause = "EXPECTED_COMMENT_COUNT INTEGER CHECK (EXPECTED_COMMENT_COUNT >= 0)"
        if columns != expected or check_clause not in table_sql:
            raise RuntimeError("canonical schema v4 physical shape is invalid")


def require_archive_schema(path: str | Path) -> None:
    hashes = {migration.version: migration.sha256 for migration in MIGRATIONS}
    with closing(connect_archive(path, read_only=True)) as connection:
        user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if user_version != SCHEMA_VERSION:
            raise RuntimeError(
                f"canonical schema v{SCHEMA_VERSION} is required; "
                "run the explicit archive migration"
            )
        validate_archive_for_release(
            connection,
            target_schema_version=SCHEMA_VERSION,
            target_migration_hashes=hashes,
        )


def archive_health(path: str | Path) -> dict[str, Any]:
    with closing(connect_archive(path, read_only=True)) as connection:
        quick_check = [str(row[0]) for row in connection.execute("PRAGMA quick_check")]
        foreign_key_errors = [tuple(row) for row in connection.execute("PRAGMA foreign_key_check")]
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {
            "schema_version": int(connection.execute("PRAGMA user_version").fetchone()[0]),
            "application_id": int(connection.execute("PRAGMA application_id").fetchone()[0]),
            "quick_check": quick_check,
            "foreign_key_errors": foreign_key_errors,
            "table_count": len(tables),
        }
