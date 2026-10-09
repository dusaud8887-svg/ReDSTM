-- Device sync (docs/24 §12.7, docs/00 ADR-016): the owner's reading records, one row per entry.
-- value is {at, data} or the tombstone {at, deleted: true}; deletions stay so an old device cannot
-- bring an entry back. server_rev is the owner's monotonically increasing change number.
CREATE TABLE user_sync (
  owner_id TEXT NOT NULL CHECK (length(owner_id) = 16),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 500),
  value TEXT NOT NULL,
  server_rev INTEGER NOT NULL CHECK (server_rev > 0),
  device_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
) STRICT;

CREATE INDEX user_sync_rev_idx ON user_sync(owner_id, server_rev);

-- The last change number handed out per owner.
CREATE TABLE user_sync_owners (
  owner_id TEXT PRIMARY KEY CHECK (length(owner_id) = 16),
  rev INTEGER NOT NULL CHECK (rev >= 0)
) STRICT;

-- Operations already applied, so a push retried after a lost answer changes nothing.
-- Pruned after 30 days by the scheduled maintenance.
CREATE TABLE user_sync_ops (
  owner_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, op_id)
) STRICT;

CREATE INDEX user_sync_ops_created_idx ON user_sync_ops(created_at);
