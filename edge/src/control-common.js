const counterNames = new Set([
  "changed_posts",
  "failed_posts",
  "boards_ok",
  "boards_failed",
  "discovered",
  "pending",
  "retry",
  "dead",
]);

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
  };
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
  }
  return run;
}
