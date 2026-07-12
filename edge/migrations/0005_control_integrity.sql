CREATE UNIQUE INDEX commands_active_conflict_group_idx
ON commands (
  CASE
    WHEN action IN ('pause-after-current', 'resume-schedule') THEN 'schedule-marker'
    ELSE 'process'
  END
)
WHERE state IN ('queued', 'claimed');

CREATE INDEX run_events_snapshot_recorded_idx
ON run_events(recorded_at DESC, run_id DESC, sequence DESC)
WHERE step = 'archive_snapshot';
