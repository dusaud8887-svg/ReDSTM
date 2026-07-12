ALTER TABLE commands ADD COLUMN operation TEXT
  CHECK (operation IS NULL OR operation IN (
    'sync-now', 'full-catalog', 'full-content', 'retry-batch', 'publish-if-changed',
    'pause-after-current', 'resume-schedule'
  ));

ALTER TABLE board_status ADD COLUMN collection_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (collection_enabled IN (0, 1));
ALTER TABLE board_status ADD COLUMN outline_only INTEGER NOT NULL DEFAULT 0
  CHECK (outline_only >= 0);
ALTER TABLE board_status ADD COLUMN incremental_anchor_post_id INTEGER
  CHECK (incremental_anchor_post_id IS NULL OR incremental_anchor_post_id > 0);
ALTER TABLE board_status ADD COLUMN last_incremental_at TEXT;

ALTER TABLE runner_status ADD COLUMN active_post_id INTEGER
  CHECK (active_post_id IS NULL OR active_post_id > 0);

CREATE TABLE frontier_failures (
  board_id TEXT NOT NULL,
  external_post_id INTEGER NOT NULL CHECK (external_post_id > 0),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  error_code TEXT NOT NULL,
  last_attempt_at TEXT,
  sync_generation TEXT NOT NULL,
  PRIMARY KEY (board_id, external_post_id)
) STRICT;

CREATE INDEX frontier_failures_recent_idx
ON frontier_failures(last_attempt_at DESC, board_id, external_post_id);
