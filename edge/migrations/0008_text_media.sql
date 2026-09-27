-- Arcalive images kept in R2 so text-archive bodies stop depending on expiring signed links.
-- path_key is the CDN path ("20230607sac/<hash>.webp"), identical across ac/ac-o/namu hosts.
CREATE TABLE text_media (
  path_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/webp', 'image/png', 'image/jpeg', 'image/gif')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  stored_at TEXT NOT NULL
) STRICT;

-- Posts whose images a reader opened but the archive does not hold yet. A browser extension
-- running in the reader's own logged-in Chrome drains it (see extension/redstm-arca-media).
CREATE TABLE text_media_queue (
  post_url TEXT PRIMARY KEY,
  paths TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX text_media_queue_pending_idx ON text_media_queue(status, requested_at);
