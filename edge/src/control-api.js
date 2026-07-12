import {
  CLIENT_FUTURE_CLOCK_SKEW_MS,
  NEXT_SCHEDULE_MAX_AHEAD_MS,
  envelope,
  failure,
  runView,
  validCounters,
} from "./control-common.js";
import { readControlResponse } from "./control-read.js";

const CONTROL_BODY_MAX_BYTES = 16 * 1024;
const TELEMETRY_BODY_MAX_BYTES = 64 * 1024;
const COMMAND_TTL_MS = 15 * 60 * 1000;
const COMMAND_CLAIM_LEASE_MS = 2 * 60 * 1000;
const COMMAND_MAX_CLAIM_ATTEMPTS = 2;
const RUN_EVENT_BATCH_MAX_ITEMS = 50;
const protocol = "1";
const actions = new Set([
  "sync-now",
  "full-catalog",
  "full-content",
  "retry-batch",
  "publish-if-changed",
  "pause-after-current",
  "resume-schedule",
]);
const markerActions = new Set(["pause-after-current", "resume-schedule"]);
const runnerStates = new Set(["idle", "running", "degraded", "failed", "paused"]);
const runKinds = new Set(["scheduled", "manual-sync", "retry", "publish"]);
const runSources = new Set(["systemd", "command"]);
const terminalStates = new Set(["succeeded", "partial", "failed"]);
const boardOutcomes = new Set(["succeeded", "partial", "failed"]);
const commandRunKinds = new Map([
  ["sync-now", "manual-sync"],
  ["full-catalog", "manual-sync"],
  ["full-content", "retry"],
  ["retry-batch", "retry"],
  ["publish-if-changed", "publish"],
]);
const storedActions = new Map([
  ["full-catalog", "sync-now"],
  ["full-content", "retry-batch"],
]);
const safeWarnings = new Set([
  "auth_failed",
  "parse_drift",
  "rate_limited",
  "site_unreachable",
  "disk_low",
  "control_rejected",
  "token_expiring",
  "publish_stale",
]);
const identifierPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const idempotencyPattern = /^[a-zA-Z0-9_.:-]{8,128}$/;

function commandConflictGroup(action) {
  return markerActions.has(action) ? "schedule-marker" : "process";
}

function commandConflictFilter(group) {
  return group === "schedule-marker"
    ? "action IN ('pause-after-current', 'resume-schedule')"
    : "action NOT IN ('pause-after-current', 'resume-schedule')";
}

function logicalAction(row) {
  return row.operation ?? row.action;
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
  let args = {};
  try {
    const parsed = JSON.parse(row.args_json ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch {
    // Invalid stored arguments are exposed as empty and rejected by the runner.
  }
  return {
    command_id: row.command_id,
    action: logicalAction(row),
    state: row.state,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    claimed_at: row.claimed_at ?? null,
    claim_expires_at: row.claim_expires_at ?? null,
    claim_attempts: Number(row.claim_attempts ?? 0),
    finished_at: row.finished_at ?? null,
    run_id: row.run_id ?? null,
    safe_message: row.safe_message ?? null,
    args,
  };
}

function commandReplay(requestId, row, action, args = {}) {
  let storedArgs;
  try {
    storedArgs = JSON.parse(row.args_json ?? "{}");
  } catch {
    storedArgs = null;
  }
  return logicalAction(row) === action && JSON.stringify(storedArgs) === JSON.stringify(args)
    ? envelope(requestId, commandView(row))
    : failure(
      requestId,
      409,
      "idempotency_conflict",
      "Idempotency key belongs to a different command intent",
    );
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

function timestampValue(value) {
  return value == null ? null : new Date(value).toISOString();
}

function validClientTimestamp(value, now) {
  return validTimestamp(value) && (
    value == null || Date.parse(value) <= now.getTime() + CLIENT_FUTURE_CLOCK_SKEW_MS
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
  const body = await readJson(request, CONTROL_BODY_MAX_BYTES);
  if (!actions.has(body.action) || body.args == null ||
      typeof body.args !== "object" || Array.isArray(body.args)) {
    return failure(requestId, 400, "invalid_command", "Command action or arguments are invalid");
  }
  const argKeys = Object.keys(body.args);
  const boardAction = ["sync-now", "full-catalog", "full-content"].includes(body.action);
  if ((!boardAction && argKeys.length) || argKeys.some((key) => key !== "board_id") ||
      (body.args.board_id !== undefined &&
       (typeof body.args.board_id !== "string" || !/^[a-z0-9_]{1,64}$/.test(body.args.board_id)))) {
    return failure(requestId, 400, "invalid_command", "Command action or arguments are invalid");
  }
  const existing = await env.CONTROL_DB.prepare(
    "SELECT * FROM commands WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first();
  if (existing) return commandReplay(requestId, existing, body.action, body.args);
  const now = new Date();
  const nowText = now.toISOString();
  await env.CONTROL_DB.prepare(
    `UPDATE commands SET state = 'expired', finished_at = ?, safe_message = 'expired'
     WHERE state = 'queued' AND expires_at <= ?`,
  ).bind(nowText, nowText).run();
  const conflictGroup = commandConflictGroup(body.action);
  const conflictFilter = commandConflictFilter(conflictGroup);
  const conflict = await env.CONTROL_DB.prepare(
    `SELECT command_id FROM commands WHERE ${conflictFilter}
     AND state IN ('queued', 'claimed') LIMIT 1`,
  ).first();
  if (conflict) {
    return failure(requestId, 409, "command_conflict", "Another command is active", true);
  }
  const command = {
    command_id: crypto.randomUUID(),
    action: storedActions.get(body.action) ?? body.action,
    operation: body.action,
    args_json: JSON.stringify(body.args),
    state: "queued",
    requested_at: nowText,
    expires_at: new Date(now.getTime() + COMMAND_TTL_MS).toISOString(),
  };
  try {
    await env.CONTROL_DB.prepare(
      `INSERT INTO commands (
         command_id, idempotency_key, action, operation, args_json, requested_by_hash,
         requested_at, expires_at, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    ).bind(
      command.command_id,
      idempotencyKey,
      command.action,
      command.operation,
      command.args_json,
      await subjectHash(auth.subject.trim().toLowerCase()),
      command.requested_at,
      command.expires_at,
    ).run();
  } catch (error) {
    const replay = await env.CONTROL_DB.prepare(
      "SELECT * FROM commands WHERE idempotency_key = ?",
    ).bind(idempotencyKey).first();
    if (replay) return commandReplay(requestId, replay, body.action, body.args);
    const conflict = await env.CONTROL_DB.prepare(
      `SELECT command_id FROM commands WHERE ${conflictFilter}
       AND state IN ('queued', 'claimed') LIMIT 1`,
    ).first();
    if (conflict) {
      return failure(requestId, 409, "command_conflict", "Another command is active", true);
    }
    throw error;
  }
  return envelope(requestId, commandView(command), 202);
}

async function claimCommand(request, env, requestId) {
  const idempotencyKey = request.headers.get("Idempotency-Key") || "";
  if (!idempotencyPattern.test(idempotencyKey)) {
    return failure(requestId, 400, "invalid_idempotency_key", "Idempotency key is invalid");
  }
  const body = await readJson(request, CONTROL_BODY_MAX_BYTES);
  if (!identifierPattern.test(body.runner_id || "") ||
      (body.command_kind !== undefined && body.command_kind !== "marker")) {
    return failure(requestId, 400, "invalid_runner", "Runner claim is invalid");
  }
  const markerFilter = body.command_kind === "marker"
    ? "AND action IN ('pause-after-current', 'resume-schedule')"
    : "";
  const replay = await env.CONTROL_DB.prepare(
    "SELECT * FROM commands WHERE claim_idempotency_key = ?",
  ).bind(idempotencyKey).first();
  if (replay) return envelope(requestId, { command: commandView(replay) });
  const now = new Date();
  const nowText = now.toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'expired', finished_at = ?, safe_message = 'expired'
       WHERE state = 'queued' AND expires_at <= ?`,
    ).bind(nowText, nowText),
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'queued', claimed_at = NULL, claim_expires_at = NULL,
         runner_id = NULL, claim_idempotency_key = NULL
       WHERE state = 'claimed' AND claim_expires_at <= ?
         AND claim_attempts < ? AND run_id IS NULL ${markerFilter}`,
    ).bind(nowText, COMMAND_MAX_CLAIM_ATTEMPTS),
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'failed', finished_at = ?, safe_message = 'claim_lost'
       WHERE state = 'claimed' AND claim_expires_at <= ?
         AND claim_attempts >= ? AND run_id IS NULL ${markerFilter}`,
    ).bind(nowText, nowText, COMMAND_MAX_CLAIM_ATTEMPTS),
  ]);
  let claimed;
  try {
    claimed = await env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'claimed', claimed_at = ?, claim_expires_at = ?,
         claim_attempts = claim_attempts + 1, runner_id = ?, claim_idempotency_key = ?
       WHERE command_id = (
         SELECT command_id FROM commands
         WHERE state = 'queued' AND expires_at > ? ${markerFilter}
         ORDER BY requested_at, command_id LIMIT 1
       ) AND state = 'queued'
       RETURNING *`,
    ).bind(
      nowText,
      new Date(now.getTime() + COMMAND_CLAIM_LEASE_MS).toISOString(),
      body.runner_id,
      idempotencyKey,
      nowText,
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
  const body = await readJson(request, TELEMETRY_BODY_MAX_BYTES);
  const commandLease = body.active_command_id != null || body.runner_id != null;
  const receivedAt = new Date();
  if (!identifierPattern.test(body.runner_version || "") || !runnerStates.has(body.state) ||
      (body.safe_warning_code != null && !safeWarnings.has(body.safe_warning_code)) ||
      [body.active_run_id, body.active_step, body.active_board_id].some(
        (value) => value != null && !identifierPattern.test(value),
      ) ||
      (body.active_post_id != null &&
        (!Number.isSafeInteger(body.active_post_id) || body.active_post_id < 1)) ||
      !validTimestamp(body.next_scheduled_at) ||
      (body.next_scheduled_at != null &&
        Date.parse(body.next_scheduled_at) >
          receivedAt.getTime() + NEXT_SCHEDULE_MAX_AHEAD_MS) ||
      (commandLease && (
        !/^[0-9a-f-]{36}$/i.test(body.active_command_id || "") ||
        !identifierPattern.test(body.runner_id || "")
      )) ||
      (body.disk_free_bytes != null &&
        (!Number.isSafeInteger(body.disk_free_bytes) || body.disk_free_bytes < 0))) {
    return failure(requestId, 400, "invalid_heartbeat", "Heartbeat fields are invalid");
  }
  const now = receivedAt.toISOString();
  const statements = [env.CONTROL_DB.prepare(
    `INSERT INTO runner_status (
       id, schema_version, runner_version, state, heartbeat_at, next_scheduled_at,
       active_run_id, active_step, active_board_id, active_post_id,
       disk_free_bytes, safe_warning_code
     ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = 1, runner_version = excluded.runner_version,
       state = excluded.state, heartbeat_at = excluded.heartbeat_at,
       next_scheduled_at = excluded.next_scheduled_at,
       active_run_id = excluded.active_run_id, active_step = excluded.active_step,
       active_board_id = excluded.active_board_id,
       active_post_id = excluded.active_post_id,
       disk_free_bytes = excluded.disk_free_bytes,
       safe_warning_code = excluded.safe_warning_code`,
  ).bind(
    body.runner_version,
    body.state,
    now,
    timestampValue(body.next_scheduled_at),
    body.active_run_id ?? null,
    body.active_step ?? null,
    body.active_board_id ?? null,
    body.active_post_id ?? null,
    body.disk_free_bytes ?? null,
    body.safe_warning_code ?? null,
  )];
  if (commandLease) {
    statements.push(
      env.CONTROL_DB.prepare(
        `UPDATE commands SET claim_expires_at = ?
         WHERE command_id = ? AND state = 'claimed' AND runner_id = ?`,
      ).bind(
        new Date(Date.parse(now) + COMMAND_CLAIM_LEASE_MS).toISOString(),
        body.active_command_id,
        body.runner_id,
      ),
    );
  }
  const results = await env.CONTROL_DB.batch(statements);
  return envelope(requestId, {
    accepted: true,
    heartbeat_at: now,
    command_lease_renewed: commandLease ? Number(results[1]?.meta?.changes ?? 0) === 1 : null,
  });
}

async function startRun(request, env, requestId) {
  const body = await readJson(request, TELEMETRY_BODY_MAX_BYTES);
  if (!identifierPattern.test(body.run_id || "") || !runKinds.has(body.kind) ||
      !runSources.has(body.source) || !validTimestamp(body.requested_at) ||
      !validTimestamp(body.started_at) ||
      (body.command_id != null && !/^[0-9a-f-]{36}$/i.test(body.command_id)) ||
      (body.source === "command") !== (body.command_id != null)) {
    return failure(requestId, 400, "invalid_run", "Run fields are invalid");
  }
  const existing = await env.CONTROL_DB.prepare(
    "SELECT * FROM runs WHERE run_id = ?",
  ).bind(body.run_id).first();
  if (existing) return envelope(requestId, runView(existing));
  const receivedAt = new Date();
  if (!validClientTimestamp(body.requested_at, receivedAt) ||
      !validClientTimestamp(body.started_at, receivedAt)) {
    return failure(requestId, 400, "invalid_run", "Run timestamp is too far in the future");
  }
  let storedCommandAction = null;
  if (body.command_id != null) {
    const command = await env.CONTROL_DB.prepare(
      "SELECT action, operation, state, run_id FROM commands WHERE command_id = ?",
    ).bind(body.command_id).first();
    if (!command || command.state !== "claimed" || command.run_id != null ||
        commandRunKinds.get(logicalAction(command)) !== body.kind) {
      return failure(requestId, 409, "command_not_startable", "Command cannot start this run");
    }
    storedCommandAction = command.action;
  }
  const startedAt = timestampValue(body.started_at) ?? receivedAt.toISOString();
  if (body.command_id != null) {
    let results;
    try {
      results = await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare(
          `INSERT INTO runs (run_id, kind, source, state, requested_at, started_at)
           SELECT ?, ?, ?, 'running', ?, ? FROM commands
           WHERE command_id = ? AND action = ?
             AND state = 'claimed' AND run_id IS NULL`,
        ).bind(
          body.run_id,
          body.kind,
          body.source,
          timestampValue(body.requested_at),
          startedAt,
          body.command_id,
          storedCommandAction,
        ),
        env.CONTROL_DB.prepare(
          `UPDATE commands SET run_id = ?
           WHERE command_id = ? AND action = ?
             AND state = 'claimed' AND run_id IS NULL`,
        ).bind(body.run_id, body.command_id, storedCommandAction),
      ]);
    } catch (error) {
      const raced = await env.CONTROL_DB.prepare(
        "SELECT * FROM runs WHERE run_id = ?",
      ).bind(body.run_id).first();
      if (raced) return envelope(requestId, runView(raced));
      throw error;
    }
    if (results.length !== 2 ||
        results.some((result) => Number(result?.meta?.changes ?? 0) !== 1)) {
      const raced = await env.CONTROL_DB.prepare(
        "SELECT * FROM runs WHERE run_id = ?",
      ).bind(body.run_id).first();
      return raced
        ? envelope(requestId, runView(raced))
        : failure(requestId, 409, "command_not_startable", "Command cannot start this run");
    }
  } else {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        `INSERT INTO runs (run_id, kind, source, state, requested_at, started_at)
         VALUES (?, ?, ?, 'running', ?, ?) ON CONFLICT(run_id) DO NOTHING`,
      ).bind(
        body.run_id,
        body.kind,
        body.source,
        timestampValue(body.requested_at),
        startedAt,
      ),
    ]);
  }
  return envelope(
    requestId,
    runView({ ...body, state: "running", started_at: startedAt }),
    202,
  );
}

function validBoardCounters(value) {
  const required = ["discovered", "changed", "pending", "retry", "dead"];
  const allowed = new Set([...required, "running", "done"]);
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((name) => allowed.has(name)) && required.every(
      (name) => Number.isSafeInteger(value[name]) && value[name] >= 0,
    ) && ["running", "done"].every(
      (name) => value[name] == null || (Number.isSafeInteger(value[name]) && value[name] >= 0),
    );
}

async function recordBoardStatus(request, env, requestId) {
  const body = await readJson(request, CONTROL_BODY_MAX_BYTES);
  const receivedAt = new Date();
  if (!identifierPattern.test(body.board_id || "") || !boardOutcomes.has(body.last_outcome) ||
      (body.board_name != null &&
        (typeof body.board_name !== "string" || body.board_name.length > 128)) ||
      (body.group_name != null &&
        (typeof body.group_name !== "string" || body.group_name.length > 128)) ||
      typeof body.last_scanned_at !== "string" || !validTimestamp(body.last_scanned_at) ||
      (body.inventory_next_page != null &&
        (!Number.isSafeInteger(body.inventory_next_page) || body.inventory_next_page < 1)) ||
      !validTimestamp(body.last_inventory_at) ||
      !validTimestamp(body.inventory_pass_started_at) ||
      !validClientTimestamp(body.last_scanned_at, receivedAt) ||
      !validClientTimestamp(body.last_inventory_at, receivedAt) ||
      !validClientTimestamp(body.inventory_pass_started_at, receivedAt) ||
      (body.collection_enabled !== undefined && typeof body.collection_enabled !== "boolean") ||
      (body.outline_only !== undefined &&
        (!Number.isSafeInteger(body.outline_only) || body.outline_only < 0)) ||
      (body.incremental_anchor_post_id != null &&
        (!Number.isSafeInteger(body.incremental_anchor_post_id) ||
         body.incremental_anchor_post_id < 1)) ||
      !validTimestamp(body.last_incremental_at) ||
      !validBoardCounters(body.counters) ||
      (body.warning_code != null && !safeWarnings.has(body.warning_code))) {
    return failure(requestId, 400, "invalid_board_status", "Board status is invalid");
  }
  const counters = body.counters;
  const scannedAt = timestampValue(body.last_scanned_at);
  await env.CONTROL_DB.prepare(
    `INSERT INTO board_status (
       board_id, board_name, group_name, last_scanned_at, last_outcome,
       discovered, changed, pending, running, retry, done, dead,
       inventory_next_page, last_inventory_at, inventory_pass_started_at, warning_code,
       collection_enabled, outline_only, incremental_anchor_post_id, last_incremental_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(board_id) DO UPDATE SET
       board_name = COALESCE(excluded.board_name, board_status.board_name),
       group_name = COALESCE(excluded.group_name, board_status.group_name),
       last_scanned_at = excluded.last_scanned_at, last_outcome = excluded.last_outcome,
       discovered = excluded.discovered, changed = excluded.changed, pending = excluded.pending,
       running = excluded.running, retry = excluded.retry, done = excluded.done,
       dead = excluded.dead,
       inventory_next_page = COALESCE(
         excluded.inventory_next_page, board_status.inventory_next_page
       ),
       last_inventory_at = COALESCE(excluded.last_inventory_at, board_status.last_inventory_at),
       inventory_pass_started_at = COALESCE(
         excluded.inventory_pass_started_at, board_status.inventory_pass_started_at
       ),
       warning_code = excluded.warning_code,
       collection_enabled = excluded.collection_enabled,
       outline_only = excluded.outline_only,
       incremental_anchor_post_id = excluded.incremental_anchor_post_id,
       last_incremental_at = excluded.last_incremental_at
     WHERE board_status.last_scanned_at IS NULL
        OR board_status.last_scanned_at > ?
        OR excluded.last_scanned_at >= board_status.last_scanned_at`,
  ).bind(
    body.board_id,
    body.board_name ?? null,
    body.group_name ?? null,
    scannedAt,
    body.last_outcome,
    counters.discovered,
    counters.changed,
    counters.pending,
    counters.running ?? 0,
    counters.retry,
    counters.done ?? 0,
    counters.dead,
    body.inventory_next_page ?? null,
    timestampValue(body.last_inventory_at),
    timestampValue(body.inventory_pass_started_at),
    body.warning_code ?? null,
    body.collection_enabled === false ? 0 : 1,
    body.outline_only ?? 0,
    body.incremental_anchor_post_id ?? null,
    timestampValue(body.last_incremental_at),
    new Date(receivedAt.getTime() + CLIENT_FUTURE_CLOCK_SKEW_MS).toISOString(),
  ).run();
  return envelope(requestId, { accepted: true });
}

async function recordFrontierFailures(request, env, requestId) {
  const body = await readJson(request, TELEMETRY_BODY_MAX_BYTES);
  if (!/^[a-z0-9_]{1,64}$/.test(body.board_id || "") ||
      !identifierPattern.test(body.generation || "") ||
      typeof body.complete !== "boolean" || !Array.isArray(body.items) ||
      body.items.length > 100 || body.items.some((item) =>
        !item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isSafeInteger(item.external_post_id) || item.external_post_id < 1 ||
        !Number.isSafeInteger(item.attempts) || item.attempts < 0 ||
        !identifierPattern.test(item.error_code || "") ||
        !validTimestamp(item.last_attempt_at))) {
    return failure(requestId, 400, "invalid_frontier_failures", "Failure batch is invalid");
  }
  const statements = body.items.map((item) => env.CONTROL_DB.prepare(
    `INSERT INTO frontier_failures (
       board_id, external_post_id, attempts, error_code, last_attempt_at, sync_generation
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(board_id, external_post_id) DO UPDATE SET
       attempts = excluded.attempts, error_code = excluded.error_code,
       last_attempt_at = excluded.last_attempt_at,
       sync_generation = excluded.sync_generation`,
  ).bind(
    body.board_id,
    item.external_post_id,
    item.attempts,
    item.error_code,
    timestampValue(item.last_attempt_at),
    body.generation,
  ));
  if (body.complete) {
    statements.push(env.CONTROL_DB.prepare(
      "DELETE FROM frontier_failures WHERE board_id = ? AND sync_generation <> ?",
    ).bind(body.board_id, body.generation));
  }
  if (statements.length) await env.CONTROL_DB.batch(statements);
  return envelope(requestId, { accepted: body.items.length }, 202);
}

async function finishCommand(request, env, requestId, commandId) {
  const body = await readJson(request, CONTROL_BODY_MAX_BYTES);
  if (!identifierPattern.test(body.runner_id || "") || !terminalStates.has(body.state) ||
      (body.safe_summary_code != null && !identifierPattern.test(body.safe_summary_code))) {
    return failure(requestId, 400, "invalid_command_finish", "Command result is invalid");
  }
  const existing = await env.CONTROL_DB.prepare(
    "SELECT * FROM commands WHERE command_id = ?",
  ).bind(commandId).first();
  if (!existing) return failure(requestId, 404, "command_not_found", "Command was not found");
  if (terminalStates.has(existing.state)) {
    return existing.state === body.state
      ? envelope(requestId, commandView(existing))
      : failure(requestId, 409, "command_terminal", "Command has a different terminal state");
  }
  const result = await env.CONTROL_DB.prepare(
    `UPDATE commands SET state = ?, finished_at = ?, safe_message = ?
     WHERE command_id = ? AND state = 'claimed' AND runner_id = ? RETURNING *`,
  ).bind(
    body.state,
    new Date().toISOString(),
    body.safe_summary_code ?? null,
    commandId,
    body.runner_id,
  ).first();
  return result
    ? envelope(requestId, commandView(result))
    : failure(requestId, 409, "command_not_finishable", "Command cannot be finished");
}

function validEvent(event) {
  return event && typeof event === "object" && !Array.isArray(event) &&
    Number.isSafeInteger(event.sequence) && event.sequence >= 0 &&
    identifierPattern.test(event.step || "") && identifierPattern.test(event.state || "") &&
    validTimestamp(event.recorded_at) && validCounters(event.counters ?? {}) &&
    (event.safe_message == null || identifierPattern.test(event.safe_message));
}

async function recordEvents(request, env, requestId, runId) {
  const body = await readJson(request, TELEMETRY_BODY_MAX_BYTES);
  const receivedAt = new Date();
  if (!Array.isArray(body.events) || body.events.length < 1 ||
      body.events.length > RUN_EVENT_BATCH_MAX_ITEMS ||
      !body.events.every(
        (event) => validEvent(event) && validClientTimestamp(event.recorded_at, receivedAt),
      )) {
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
      timestampValue(event.recorded_at) ?? new Date().toISOString(),
      JSON.stringify(event.counters ?? {}),
      event.safe_message ?? null,
    )),
  );
  return envelope(requestId, { accepted: body.events.length });
}

async function finishRun(request, env, requestId, runId) {
  const body = await readJson(request, TELEMETRY_BODY_MAX_BYTES);
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
    const readResponse = await readControlResponse(request, env, requestId, url);
    if (readResponse) return readResponse;
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
      if (result) return envelope(requestId, commandView(result));
      const existing = await env.CONTROL_DB.prepare(
        "SELECT * FROM commands WHERE command_id = ?",
      ).bind(commandMatch[1]).first();
      return existing?.state === "cancelled"
        ? envelope(requestId, commandView(existing))
        : failure(requestId, 409, "command_not_cancellable", "Command cannot be cancelled");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/commands/claim") {
      return await claimCommand(request, env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/heartbeat") {
      return await heartbeat(request, env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/boards/status") {
      return await recordBoardStatus(request, env, requestId);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runner/frontier-failures") {
      return await recordFrontierFailures(request, env, requestId);
    }
    const commandFinishMatch = /^\/api\/v1\/runner\/commands\/([0-9a-f-]{36})\/finish$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && commandFinishMatch) {
      return await finishCommand(request, env, requestId, commandFinishMatch[1]);
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
