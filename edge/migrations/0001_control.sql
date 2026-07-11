PRAGMA foreign_keys = ON;

CREATE TABLE runner_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  runner_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'degraded', 'failed', 'paused')),
  heartbeat_at TEXT NOT NULL,
  next_scheduled_at TEXT,
  active_run_id TEXT,
  active_step TEXT,
  active_board_id TEXT,
  disk_free_bytes INTEGER CHECK (disk_free_bytes IS NULL OR disk_free_bytes >= 0),
  safe_warning_code TEXT
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN (
    'sync-now', 'retry-batch', 'publish-if-changed',
    'pause-after-current', 'resume-schedule'
  )),
  args_json TEXT NOT NULL DEFAULT '{}',
  requested_by_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'claimed', 'cancelled', 'expired', 'succeeded', 'partial', 'failed'
  )),
  claimed_at TEXT,
  claim_expires_at TEXT,
  claim_attempts INTEGER NOT NULL DEFAULT 0 CHECK (claim_attempts >= 0),
  runner_id TEXT,
  finished_at TEXT,
  run_id TEXT,
  safe_message TEXT
) STRICT;

CREATE INDEX commands_claim_idx ON commands(state, expires_at, requested_at);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual-sync', 'retry', 'publish')),
  source TEXT NOT NULL CHECK (source IN ('systemd', 'command')),
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'partial', 'failed')),
  requested_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  changed_posts INTEGER NOT NULL DEFAULT 0 CHECK (changed_posts >= 0),
  failed_posts INTEGER NOT NULL DEFAULT 0 CHECK (failed_posts >= 0),
  boards_ok INTEGER NOT NULL DEFAULT 0 CHECK (boards_ok >= 0),
  boards_failed INTEGER NOT NULL DEFAULT 0 CHECK (boards_failed >= 0),
  release_id TEXT,
  safe_summary_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX runs_started_idx ON runs(started_at DESC, run_id DESC);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  step TEXT NOT NULL,
  state TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  counters_json TEXT NOT NULL DEFAULT '{}',
  safe_message TEXT,
  PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE TABLE board_status (
  board_id TEXT PRIMARY KEY,
  last_scanned_at TEXT,
  last_outcome TEXT,
  discovered INTEGER NOT NULL DEFAULT 0 CHECK (discovered >= 0),
  changed INTEGER NOT NULL DEFAULT 0 CHECK (changed >= 0),
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
  retry INTEGER NOT NULL DEFAULT 0 CHECK (retry >= 0),
  dead INTEGER NOT NULL DEFAULT 0 CHECK (dead >= 0),
  warning_code TEXT
) STRICT;
