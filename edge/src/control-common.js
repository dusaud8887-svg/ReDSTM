const counterNames = new Set([
  "changed_posts",
  "failed_posts",
  "boards_ok",
  "boards_failed",
  "discovered",
  "pending",
  "retry",
  "dead",
  "discovered_posts",
  "body_collected",
  "outline_only",
  "missing_body_pending",
  "missing_body_dead",
  "frontier_pending",
  "frontier_running",
  "frontier_retry",
  "frontier_done",
  "frontier_dead",
  "inventory_total_boards",
  "inventory_completed_boards",
  "inventory_in_progress_boards",
]);

export const CLIENT_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NEXT_SCHEDULE_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

export const COMMAND_MAX_CLAIM_ATTEMPTS = 2;

// The stale-run reaper stores runs as failed with safe_summary_json {"code":"run_stale"} and
// their claimed commands as failed with safe_message "run_stale". That verdict is a guess made
// while the runner was unreachable, so the runner's own later result may replace it (docs/08
// §7.5); every other terminal state is immutable.
export const STALE_RUN_CODE = "run_stale";
export const STALE_RUN_SQL =
  `(state = 'failed' AND json_extract(safe_summary_json, '$.code') = '${STALE_RUN_CODE}')`;
export const STALE_COMMAND_SQL = `(state = 'failed' AND safe_message = '${STALE_RUN_CODE}')`;

export function reapedAsStale(run) {
  if (run?.state !== "failed") return false;
  try {
    return JSON.parse(run.safe_summary_json || "{}")?.code === STALE_RUN_CODE;
  } catch {
    return false;
  }
}

// Overdue queued commands expire; claims whose lease lapsed before a run started go back to the
// queue (or fail after the last attempt). claimCommand runs these before claiming; overview and
// the daily maintenance run them too, so a runner that died after claiming cannot leave a
// command "active" (blocking new commands and cancel) until it comes back. markerFilter limits
// the claim statements to marker actions for a marker-only claim.
// Outside the runner's own claim (docs/08 §7.4), a lapsed claim is only settled once the runner
// itself looks gone (no heartbeat since runnerGoneBefore): during a short outage its queued
// run_start is still on the way, and requeueing under it would reject that start.
export function commandLeaseStatements(env, nowText, markerFilter = "", runnerGoneBefore = null) {
  const runnerGone = runnerGoneBefore === null ? "" : `AND NOT EXISTS (
         SELECT 1 FROM runner_status WHERE id = 1 AND heartbeat_at >= ?)`;
  const goneBinding = runnerGoneBefore === null ? [] : [runnerGoneBefore];
  return [
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'expired', finished_at = ?, safe_message = 'expired'
       WHERE state = 'queued' AND expires_at <= ?`,
    ).bind(nowText, nowText),
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'queued', claimed_at = NULL, claim_expires_at = NULL,
         runner_id = NULL, claim_idempotency_key = NULL
       WHERE state = 'claimed' AND claim_expires_at <= ?
         AND claim_attempts < ? AND run_id IS NULL ${markerFilter} ${runnerGone}`,
    ).bind(nowText, COMMAND_MAX_CLAIM_ATTEMPTS, ...goneBinding),
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'failed', finished_at = ?, safe_message = 'claim_lost'
       WHERE state = 'claimed' AND claim_expires_at <= ?
         AND claim_attempts >= ? AND run_id IS NULL ${markerFilter} ${runnerGone}`,
    ).bind(nowText, nowText, COMMAND_MAX_CLAIM_ATTEMPTS, ...goneBinding),
  ];
}

export function envelope(requestId, data, status = 200) {
  return Response.json(
    { api_version: 1, request_id: requestId, server_time: new Date().toISOString(), data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function failure(requestId, status, code, message, retryable = false) {
  return Response.json(
    {
      api_version: 1,
      request_id: requestId,
      server_time: new Date().toISOString(),
      error: { code, message, retryable },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function validCounters(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, count]) =>
      counterNames.has(key) && Number.isSafeInteger(count) && count >= 0);
}

export function runView(row) {
  const run = {
    run_id: row.run_id,
    kind: row.kind,
    source: row.source,
    state: row.state,
    requested_at: row.requested_at ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    changed_posts: Number(row.changed_posts ?? 0),
    failed_posts: Number(row.failed_posts ?? 0),
    boards_ok: Number(row.boards_ok ?? 0),
    boards_failed: Number(row.boards_failed ?? 0),
    release_id: row.release_id ?? null,
    counters_reported: null,
  };
  try {
    const summary = JSON.parse(row.safe_summary_json || "{}");
    run.safe_summary_code = typeof summary?.code === "string" ? summary.code : null;
    run.counters_reported = typeof summary?.counters_reported === "boolean"
      ? summary.counters_reported
      : null;
  } catch {
    run.safe_summary_code = null;
  }
  if (row.event_sequence != null) {
    let counters = {};
    try {
      const parsed = JSON.parse(row.event_counters_json || "{}");
      if (validCounters(parsed)) counters = parsed;
    } catch {
      // Invalid historical telemetry is omitted rather than exposed.
    }
    run.latest_event = {
      sequence: Number(row.event_sequence),
      step: row.event_step,
      state: row.event_state,
      recorded_at: row.event_recorded_at,
      counters,
      safe_message: row.event_safe_message ?? null,
    };
    if (run.state === "running") {
      for (const name of ["changed_posts", "failed_posts", "boards_ok", "boards_failed"]) {
        if (Object.hasOwn(counters, name)) run[name] = counters[name];
      }
    }
  }
  return run;
}
