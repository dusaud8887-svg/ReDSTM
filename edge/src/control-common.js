const counterNames = new Set([
  "changed_posts",
  "failed_posts",
  "boards_ok",
  "boards_failed",
  "discovered",
  "pending",
  "retry",
  "dead",
  "outline_only",
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
