CREATE INDEX commands_retention_idx
ON commands(state, finished_at) WHERE finished_at IS NOT NULL;

CREATE INDEX runs_retention_idx
ON runs(state, finished_at) WHERE finished_at IS NOT NULL;
