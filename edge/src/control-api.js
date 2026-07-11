const protocol = "1";
const actions = new Set([
  "sync-now",
  "retry-batch",
  "publish-if-changed",
  "pause-after-current",
  "resume-schedule",
]);
const runnerStates = new Set(["idle", "running", "degraded", "failed", "paused"]);
const runKinds = new Set(["scheduled", "manual-sync", "retry", "publish"]);
const runSources = new Set(["systemd", "command"]);
const terminalStates = new Set(["succeeded", "partial", "failed"]);
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
const safeWarnings = new Set([
  "auth_failed",
  "parse_drift",
  "rate_limited",
  "site_unreachable",
  "disk_low",
  "token_expiring",
  "publish_stale",
  "backup_stale",
]);
const identifierPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const idempotencyPattern = /^[a-zA-Z0-9_.:-]{8,128}$/;

function envelope(requestId, data, status = 200) {
  return Response.json(
    { api_version: 1, request_id: requestId, server_time: new Date().toISOString(), data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function failure(requestId, status, code, message, retryable = false) {
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

function validRequestId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readJson(request, limit) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw Object.assign(new Error("JSON content type is required"), { status: 400 });
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit) {
    throw Object.assign(new Error("Request body is too large"), { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
  }
}

async function subjectHash(subject) {
  const bytes = new TextEncoder().encode(subject);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function commandView(row) {
  return {
    command_id: row.command_id,
    action: row.action,
    state: row.state,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    claimed_at: row.claimed_at ?? null,
    claim_expires_at: row.claim_expires_at ?? null,
    claim_attempts: Number(row.claim_attempts ?? 0),
    finished_at: row.finished_at ?? null,
    run_id: row.run_id ?? null,
    safe_message: row.safe_message ?? null,
  };
}

function validCounters(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, count]) =>
      counterNames.has(key) && Number.isSafeInteger(count) && count >= 0);
}

function runView(row) {
  return {
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
}

function browserMutation(request, url) {
  return request.headers.get("Origin") === url.origin &&
    request.headers.get("X-ReDSTM-Command") === "1";
}

function validTimestamp(value) {
  return value == null || (
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

async function createCommand(request, env, auth, requestId, url) {
  if (!browserMutation(request, url)) {
    return failure(requestId, 403, "origin_denied", "Command request was denied");
  }
  const idempotencyKey = request.headers.get("Idempotency-Key") || "";
  if (!idempotencyPattern.test(idempotencyKey)) {
    return failure(requestId, 400, "invalid_idempotency_key", "Idempotency key is invalid");
  }
  const body = await readJson(request, 16 * 1024);
  if (!actions.has(body.action) || body.args == null ||
      typeof body.args !== "object" || Array.isArray(body.args) || Object.keys(body.args).length) {
    return failure(requestId, 400, "invalid_command", "Command action or arguments are invalid");
  }
  const existing = await env.CONTROL_DB.prepare(
    "SELECT * FROM commands WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first();
  if (existing) return envelope(requestId, commandView(existing));
  const now = new Date();
  const conflict = await env.CONTROL_DB.prepare(
    "SELECT command_id FROM commands WHERE state = 'claimed' " +
    "OR (state = 'queued' AND expires_at > ?) LIMIT 1",
  ).bind(now.toISOString()).first();
  if (conflict) {
    return failure(requestId, 409, "command_conflict", "Another command is active", true);
  }
  const command = {
    command_id: crypto.randomUUID(),
    action: body.action,
    state: "queued",
    requested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO commands (
         command_id, idempotency_key, action, args_json, requested_by_hash,
         requested_at, expires_at, state
       ) VALUES (?, ?, ?, '{}', ?, ?, ?, 'queued')`,
    ).bind(
      command.command_id,
      idempotencyKey,
      command.action,
      await subjectHash(auth.subject.trim().toLowerCase()),
      command.requested_at,
      command.expires_at,
    ).run();
  } catch {
    const replay = await env.CONTROL_DB.prepare(
      "SELECT * FROM commands WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first();
    if (replay) return envelope(requestId, commandView(replay));
    throw new Error("command insert failed");
  }
  return envelope(requestId, commandView(command), 202);
}

async function claimCommand(request, env, requestId) {
  const idempotencyKey = request.headers.get("Idempotency-Key") || "";
  if (!idempotencyPattern.test(idempotencyKey)) {
    return failure(requestId, 400, "invalid_idempotency_key", "Idempotency key is invalid");
  }
  const body = await readJson(request, 16 * 1024);
  if (!identifierPattern.test(body.runner_id || "")) {
    return failure(requestId, 400, "invalid_runner", "Runner identity is invalid");
  }
  const replay = await env.CONTROL_DB.prepare(
    "SELECT * FROM commands WHERE claim_idempotency_key = ?",
  ).bind(idempotencyKey).first();
  if (replay) return envelope(requestId, { command: commandView(replay) });
  const now = new Date();
  let claimed;
  try {
    claimed = await env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'claimed', claimed_at = ?, claim_expires_at = ?,
         claim_attempts = claim_attempts + 1, runner_id = ?, claim_idempotency_key = ?
       WHERE command_id = (
         SELECT command_id FROM commands
         WHERE state = 'queued' AND expires_at > ? ORDER BY requested_at, command_id LIMIT 1
       ) AND state = 'queued'
       RETURNING *`,
    ).bind(
      now.toISOString(),
      new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      body.runner_id,
      idempotencyKey,
      now.toISOString(),
    ).first();
  } catch {
    claimed = await env.CONTROL_DB.prepare(
      "SELECT * FROM commands WHERE claim_idempotency_key = ?",
    ).bind(idempotencyKey).first();
    if (!claimed) throw new Error("command claim failed");
  }
  return envelope(requestId, { command: claimed ? commandView(claimed) : null });
}

async function heartbeat(request, env, requestId) {
  const body = await readJson(request, 64 * 1024);
  if (!identifierPattern.test(body.runner_version || "") || !runnerStates.has(body.state) ||
      (body.safe_warning_code != null && !safeWarnings.has(body.safe_warning_code)) ||
      [body.active_run_id, body.active_step, body.active_board_id].some(
        (value) => value != null && !identifierPattern.test(value),
      ) ||
      !validTimestamp(body.next_scheduled_at) ||
      (body.disk_free_bytes != null &&
        (!Number.isSafeInteger(body.disk_free_bytes) || body.disk_free_bytes < 0))) {
    return failure(requestId, 400, "invalid_heartbeat", "Heartbeat fields are invalid");
  }
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    `INSERT INTO runner_status (
       id, schema_version, runner_version, state, heartbeat_at, next_scheduled_at,
       active_run_id, active_step, active_board_id, disk_free_bytes, safe_warning_code
     ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = 1, runner_version = excluded.runner_version,
       state = excluded.state, heartbeat_at = excluded.heartbeat_at,
       next_scheduled_at = excluded.next_scheduled_at,
       active_run_id = excluded.active_run_id, active_step = excluded.active_step,
       active_board_id = excluded.active_board_id,
       disk_free_bytes = excluded.disk_free_bytes,
       safe_warning_code = excluded.safe_warning_code`,
  ).bind(
    body.runner_version,
    body.state,
    now,
    body.next_scheduled_at ?? null,
    body.active_run_id ?? null,
    body.active_step ?? null,
    body.active_board_id ?? null,
    body.disk_free_bytes ?? null,
    body.safe_warning_code ?? null,
  ).run();
  return envelope(requestId, { accepted: true, heartbeat_at: now });
}

async function startRun(request, env, requestId) {
  const body = await readJson(request, 64 * 1024);
  if (!identifierPattern.test(body.run_id || "") || !runKinds.has(body.kind) ||
      !runSources.has(body.source) || !validTimestamp(body.requested_at) ||
      !validTimestamp(body.started_at) ||
      (body.command_id != null && !/^[0-9a-f-]{36}$/i.test(body.command_id))) {
    return failure(requestId, 400, "invalid_run", "Run fields are invalid");
  }
  const existing = await env.CONTROL_DB.prepare(
    "SELECT * FROM runs WHERE run_id = ?",
  ).bind(body.run_id).first();
  if (existing) return envelope(requestId, runView(existing));
  const startedAt = body.started_at ?? new Date().toISOString();
  const statements = [
    env.CONTROL_DB.prepare(
      `INSERT INTO runs (run_id, kind, source, state, requested_at, started_at)
       VALUES (?, ?, ?, 'running', ?, ?) ON CONFLICT(run_id) DO NOTHING`,
    ).bind(body.run_id, body.kind, body.source, body.requested_at ?? null, startedAt),
  ];
  if (body.command_id != null) {
    statements.push(
      env.CONTROL_DB.prepare(
        "UPDATE commands SET run_id = ? WHERE command_id = ? AND state = 'claimed'",
      ).bind(body.run_id, body.command_id),
    );
  }
  await env.CONTROL_DB.batch(statements);
  return envelope(
    requestId,
    runView({ ...body, state: "running", started_at: startedAt }),
    202,
  );
}

function validEvent(event) {
  return event && typeof event === "object" && !Array.isArray(event) &&
    Number.isSafeInteger(event.sequence) && event.sequence >= 0 &&
    identifierPattern.test(event.step || "") && identifierPattern.test(event.state || "") &&
    validTimestamp(event.recorded_at) && validCounters(event.counters ?? {}) &&
    (event.safe_message == null || identifierPattern.test(event.safe_message));
}

async function recordEvents(request, env, requestId, runId) {
  const body = await readJson(request, 64 * 1024);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50 ||
      !body.events.every(validEvent)) {
    return failure(requestId, 400, "invalid_events", "Run events are invalid");
  }
  const run = await env.CONTROL_DB.prepare(
    "SELECT state FROM runs WHERE run_id = ?",
  ).bind(runId).first();
  if (!run) return failure(requestId, 404, "run_not_found", "Run was not found");
  if (run.state !== "running") {
    return failure(requestId, 409, "run_terminal", "Run is already terminal");
  }
  await env.CONTROL_DB.batch(
    body.events.map((event) => env.CONTROL_DB.prepare(
      `INSERT INTO run_events (
         run_id, sequence, step, state, recorded_at, counters_json, safe_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, sequence) DO NOTHING`,
    ).bind(
      runId,
      event.sequence,
      event.step,
      event.state,
      event.recorded_at ?? new Date().toISOString(),
      JSON.stringify(event.counters ?? {}),
      event.safe_message ?? null,
    )),
  );
  return envelope(requestId, { accepted: body.events.length });
}

async function finishRun(request, env, requestId, runId) {
  const body = await readJson(request, 64 * 1024);
  if (!terminalStates.has(body.state) || !validCounters(body.counters ?? {}) ||
      (body.release_id != null && !identifierPattern.test(body.release_id)) ||
      (body.safe_summary_code != null && !identifierPattern.test(body.safe_summary_code))) {
    return failure(requestId, 400, "invalid_finish", "Run result is invalid");
  }
  const run = await env.CONTROL_DB.prepare(
    "SELECT * FROM runs WHERE run_id = ?",
  ).bind(runId).first();
  if (!run) return failure(requestId, 404, "run_not_found", "Run was not found");
  if (run.state !== "running") {
    return run.state === body.state
      ? envelope(requestId, runView(run))
      : failure(requestId, 409, "run_terminal", "Run has a different terminal state");
  }
  const counters = body.counters ?? {};
  const finishedAt = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE runs SET state = ?, finished_at = ?, changed_posts = ?, failed_posts = ?,
         boards_ok = ?, boards_failed = ?, release_id = ?, safe_summary_json = ?
       WHERE run_id = ? AND state = 'running'`,
    ).bind(
      body.state,
      finishedAt,
      counters.changed_posts ?? 0,
      counters.failed_posts ?? 0,
      counters.boards_ok ?? 0,
      counters.boards_failed ?? 0,
      body.release_id ?? null,
      JSON.stringify({ code: body.safe_summary_code ?? null }),
      runId,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = ?, finished_at = ?, safe_message = ?
       WHERE run_id = ? AND state = 'claimed'`,
    ).bind(body.state, finishedAt, body.safe_summary_code ?? null, runId),
  ]);
  return envelope(requestId, runView({
    ...run,
    ...counters,
    state: body.state,
    finished_at: finishedAt,
    release_id: body.release_id ?? null,
  }));
}

async function overview(env, requestId) {
  const [runner, run, queued] = await Promise.all([
    env.CONTROL_DB.prepare("SELECT * FROM runner_status WHERE id = 1").first(),
    env.CONTROL_DB.prepare("SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1").first(),
    env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM commands WHERE state IN ('queued', 'claimed')",
    ).first(),
  ]);
  return envelope(requestId, {
    runner: runner ?? null,
    latest_run: run ?? null,
    active_commands: Number(queued?.count ?? 0),
  });
}

export async function controlApiResponse(request, env, auth) {
  const url = new URL(request.url);
  const requestId = request.headers.get("X-Request-Id") || "";
  if (!validRequestId(requestId)) {
    return failure("invalid", 400, "invalid_request_id", "Request ID must be a UUID");
  }
  if (request.headers.get("X-ReDSTM-Protocol") !== protocol) {
    return failure(requestId, 409, "protocol_mismatch", "Unsupported protocol version");
  }
  const runnerRoute = url.pathname.startsWith("/api/v1/runner/");
  const opsRoute = url.pathname.startsWith("/api/v1/ops/");
  if ((runnerRoute && auth.role !== "runner") || (opsRoute && auth.role !== "user")) {
    return failure(requestId, 403, "role_denied", "Route role is not allowed");
  }
  if (new Set(["POST", "DELETE"]).has(request.method) &&
      !idempotencyPattern.test(request.headers.get("Idempotency-Key") || "")) {
    return failure(requestId, 400, "invalid_idempotency_key", "Idempotency key is invalid");
  }
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/ops/overview") {
      return await overview(env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/ops/commands") {
      return await createCommand(request, env, auth, requestId, url);
    }
    const commandMatch = /^\/api\/v1\/ops\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (commandMatch && request.method === "GET") {
      const command = await env.CONTROL_DB.prepare(
        "SELECT * FROM commands WHERE command_id = ?",
      ).bind(commandMatch[1]).first();
      return command
        ? envelope(requestId, commandView(command))
        : failure(requestId, 404, "command_not_found", "Command was not found");
    }
    if (commandMatch && request.method === "DELETE") {
      if (!browserMutation(request, url)) {
        return failure(requestId, 403, "origin_denied", "Command request was denied");
      }
      const result = await env.CONTROL_DB.prepare(
        "UPDATE commands SET state = 'cancelled', finished_at = ? " +
        "WHERE command_id = ? AND state = 'queued' RETURNING *",
      ).bind(new Date().toISOString(), commandMatch[1]).first();
      return result
        ? envelope(requestId, commandView(result))
        : failure(requestId, 409, "command_not_cancellable", "Command cannot be cancelled");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/commands/claim") {
      return await claimCommand(request, env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/heartbeat") {
      return await heartbeat(request, env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/runs") {
      return await startRun(request, env, requestId);
    }
    const eventMatch = /^\/api\/v1\/runner\/runs\/([a-zA-Z0-9_.:-]{1,128})\/events:batch$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && eventMatch) {
      return await recordEvents(request, env, requestId, eventMatch[1]);
    }
    const finishMatch = /^\/api\/v1\/runner\/runs\/([a-zA-Z0-9_.:-]{1,128})\/finish$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && finishMatch) {
      return await finishRun(request, env, requestId, finishMatch[1]);
    }
    return failure(requestId, 404, "route_not_found", "API route was not found");
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    return failure(
      requestId,
      status,
      status === 413 ? "body_too_large" : status === 400 ? "invalid_json" : "control_unavailable",
      status < 500 ? error.message : "Control plane is temporarily unavailable",
      status >= 500,
    );
  }
}
