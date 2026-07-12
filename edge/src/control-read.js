import {
  CLIENT_FUTURE_CLOCK_SKEW_MS,
  NEXT_SCHEDULE_MAX_AHEAD_MS,
  envelope,
  failure,
  runView,
  validCounters,
} from "./control-common.js";

const ACTIVE_RUN_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const RELEASE_MAX_BYTES = 64 * 1024;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_CURSOR_VALUE_LENGTH = 128;
const RECENT_ISSUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SUCCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const STALE_RUN_CODE = "run_stale";
const ARCHIVE_OBJECT_KEY_MAX_LENGTH = 1024;
const RELEASE_COUNT_FIELDS = [
  "post_count",
  "comment_count",
  "board_count",
  "collection_count",
  "collection_entry_count",
  "unavailable_post_count",
  "unavailable_comment_count",
];
const identifierPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const archiveObjectKeyPattern = /^[a-zA-Z0-9_./-]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const gitShaPattern = /^[0-9a-f]{40}$/i;
const workerVersionPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function boardView(row) {
  return {
    board_id: row.board_id,
    board_name: row.board_name ?? null,
    group_name: row.group_name ?? null,
    last_scanned_at: row.last_scanned_at ?? null,
    last_outcome: row.last_outcome ?? null,
    discovered: Number(row.discovered ?? 0),
    changed: Number(row.changed ?? 0),
    pending: Number(row.pending ?? 0),
    running: Number(row.running ?? 0),
    retry: Number(row.retry ?? 0),
    done: Number(row.done ?? 0),
    dead: Number(row.dead ?? 0),
    collection_enabled: Number(row.collection_enabled ?? 1) === 1,
    outline_only: Number(row.outline_only ?? 0),
    incremental_anchor_post_id: row.incremental_anchor_post_id == null
      ? null
      : Number(row.incremental_anchor_post_id),
    last_incremental_at: row.last_incremental_at ?? null,
    inventory_next_page: row.inventory_next_page == null
      ? null
      : Number(row.inventory_next_page),
    last_inventory_at: row.last_inventory_at ?? null,
    inventory_pass_started_at: row.inventory_pass_started_at ?? null,
    warning_code: row.warning_code ?? null,
  };
}

async function failuresPage(env, requestId, url) {
  const limit = pageLimit(url);
  const cursor = decodeCursor(url.searchParams.get("cursor"), 3);
  const boardId = url.searchParams.get("board_id");
  if (boardId != null && !/^[a-z0-9_]{1,64}$/.test(boardId)) {
    throw Object.assign(new Error("Board id is invalid"), { status: 400 });
  }
  if (cursor && !/^\d+$/.test(cursor[2])) {
    throw Object.assign(new Error("Page cursor is invalid"), { status: 400 });
  }
  const clauses = [];
  const parameters = [];
  if (boardId) {
    clauses.push("board_id = ?");
    parameters.push(boardId);
  }
  if (cursor) {
    clauses.push("(COALESCE(last_attempt_at, '') < ? OR " +
      "(COALESCE(last_attempt_at, '') = ? AND " +
      "(board_id > ? OR (board_id = ? AND external_post_id > ?))))");
    parameters.push(cursor[0], cursor[0], cursor[1], cursor[1], Number(cursor[2]));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT board_id, external_post_id, attempts, error_code, last_attempt_at
     FROM frontier_failures ${where}
     ORDER BY COALESCE(last_attempt_at, '') DESC, board_id, external_post_id LIMIT ?`,
  ).bind(...parameters, limit + 1).all();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return envelope(requestId, {
    items: page.map((row) => ({
      board_id: row.board_id,
      external_post_id: Number(row.external_post_id),
      attempts: Number(row.attempts),
      error_code: row.error_code,
      last_attempt_at: row.last_attempt_at ?? null,
    })),
    next_cursor: rows.length > limit && last
      ? encodeCursor([last.last_attempt_at ?? "", last.board_id, String(last.external_post_id)])
      : null,
  });
}

function pageLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return DEFAULT_PAGE_LIMIT;
  if (!/^\d{1,2}$/.test(raw)) throw Object.assign(new Error("Page limit is invalid"), { status: 400 });
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw Object.assign(new Error("Page limit is invalid"), { status: 400 });
  }
  return limit;
}

function encodeCursor(values) {
  return btoa(JSON.stringify(values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(raw, count) {
  if (raw == null || raw === "") return null;
  if (raw.length > MAX_CURSOR_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw Object.assign(new Error("Page cursor is invalid"), { status: 400 });
  }
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      raw.length + ((4 - raw.length % 4) % 4),
      "=",
    );
    const values = JSON.parse(atob(padded));
    if (!Array.isArray(values) || values.length !== count ||
        !values.every(
          (value) => typeof value === "string" && value.length <= MAX_CURSOR_VALUE_LENGTH,
        )) {
      throw new Error();
    }
    return values;
  } catch {
    throw Object.assign(new Error("Page cursor is invalid"), { status: 400 });
  }
}

async function runsPage(env, requestId, url) {
  const limit = pageLimit(url);
  const cursor = decodeCursor(url.searchParams.get("cursor"), 2);
  const futureAfter = new Date(Date.now() + CLIENT_FUTURE_CLOCK_SKEW_MS).toISOString();
  const cursorWhere = cursor
    ? "AND (r.started_at < ? OR (r.started_at = ? AND r.run_id < ?))"
    : "";
  let statement = env.CONTROL_DB.prepare(
    `SELECT r.*, e.sequence AS event_sequence, e.step AS event_step,
       e.state AS event_state, e.recorded_at AS event_recorded_at,
       e.counters_json AS event_counters_json, e.safe_message AS event_safe_message
     FROM runs AS r
     LEFT JOIN run_events AS e ON e.run_id = r.run_id AND e.sequence = (
       SELECT MAX(latest.sequence) FROM run_events AS latest
       WHERE latest.run_id = r.run_id AND latest.step <> 'archive_snapshot'
     )
     WHERE r.started_at <= ? ${cursorWhere}
     ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`,
  );
  statement = cursor
    ? statement.bind(futureAfter, cursor[0], cursor[0], cursor[1], limit + 1)
    : statement.bind(futureAfter, limit + 1);
  const result = await statement.all();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return envelope(requestId, {
    items: page.map(runView),
    next_cursor: rows.length > limit && last
      ? encodeCursor([last.started_at, last.run_id])
      : null,
  });
}

async function boardsPage(env, requestId, url) {
  const limit = pageLimit(url);
  const cursor = decodeCursor(url.searchParams.get("cursor"), 1);
  const state = url.searchParams.get("state");
  if (state != null && state !== "" && !identifierPattern.test(state)) {
    throw Object.assign(new Error("Board state is invalid"), { status: 400 });
  }
  const clauses = [];
  const parameters = [];
  if (cursor) {
    clauses.push("board_id > ?");
    parameters.push(cursor[0]);
  }
  if (state) {
    clauses.push("last_outcome = ?");
    parameters.push(state);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.CONTROL_DB.prepare(
    `SELECT * FROM board_status ${where} ORDER BY board_id LIMIT ?`,
  ).bind(...parameters, limit + 1).all();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return envelope(requestId, {
    items: page.map(boardView),
    next_cursor: rows.length > limit && last ? encodeCursor([last.board_id]) : null,
  });
}

async function activeRelease(env) {
  const object = await env.ARCHIVE.get("release.json");
  if (!object) return { error: "release_unavailable" };
  if (object.size > RELEASE_MAX_BYTES) return { error: "release_invalid" };
  const body = await object.arrayBuffer();
  if (body.byteLength > RELEASE_MAX_BYTES) return { error: "release_invalid" };
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { error: "release_invalid" };
  }
  if (!manifest || manifest.schema_version !== 1 ||
      !RELEASE_COUNT_FIELDS.every(
        (key) => Number.isSafeInteger(manifest[key]) && manifest[key] >= 0,
      )) {
    return { error: "release_invalid" };
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  return {
    releaseSha256: [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0")).join(""),
    activatedAt: object.uploaded instanceof Date ? object.uploaded.toISOString() : null,
    counts: Object.fromEntries(RELEASE_COUNT_FIELDS.map((key) => [key, manifest[key]])),
    manifest,
  };
}

function representativeReleaseRefs(manifest) {
  const refs = [manifest.search, manifest.collections];
  if (manifest.board_count > 0) {
    if (!Array.isArray(manifest.boards) || manifest.boards.length === 0) return null;
    refs.push(manifest.boards[0]);
  }
  const result = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
    const key = ref.object_key;
    const parts = typeof key === "string" ? key.split("/") : [];
    if (typeof key !== "string" || key.length > ARCHIVE_OBJECT_KEY_MAX_LENGTH ||
        !archiveObjectKeyPattern.test(key) || key.startsWith("/") ||
        parts.some((part) => part === "" || part === "." || part === "..") ||
        !Number.isSafeInteger(ref.object_bytes) || ref.object_bytes <= 0 ||
        typeof ref.object_sha256 !== "string" || !sha256Pattern.test(ref.object_sha256)) {
      return null;
    }
    result.push({ key, size: ref.object_bytes });
  }
  return result;
}

async function releaseObjectsError(env, manifest) {
  const refs = representativeReleaseRefs(manifest);
  if (!refs) return "release_reference_invalid";
  try {
    for (const ref of refs) {
      const object = await env.ARCHIVE.head(ref.key);
      if (!object) return "release_object_unavailable";
      if (object.size !== ref.size) return "release_object_size_mismatch";
    }
  } catch {
    return "release_object_unavailable";
  }
  return null;
}

function activeReleaseFailure(requestId, result) {
  return failure(
    requestId,
    503,
    result.error,
    result.error === "release_unavailable" ? "Active release is unavailable" : "Active release is invalid",
    result.error === "release_unavailable",
  );
}

async function releases(env, requestId) {
  const current = await activeRelease(env);
  if (current.error) return activeReleaseFailure(requestId, current);
  const validatedAt = new Date().toISOString();
  const [previous, smokeRun, recovery] = await Promise.all([
    env.CONTROL_DB.prepare(
      `SELECT release_id, finished_at FROM runs
       WHERE state = 'succeeded' AND release_id IS NOT NULL AND release_id <> ?
       ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
    ).bind(current.releaseSha256).first(),
    env.CONTROL_DB.prepare(
      `SELECT run_id, source, state, started_at, finished_at, safe_summary_json
       FROM runs WHERE state = 'succeeded' AND release_id = ?
       ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
    ).bind(current.releaseSha256).first(),
    env.CONTROL_DB.prepare(
      `SELECT run_id, source, state, started_at, finished_at, safe_summary_json
       FROM runs WHERE kind = 'retry' AND state IN ('succeeded', 'partial', 'failed')
       ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
    ).first(),
  ]);
  const smokeView = smokeRun ? runView(smokeRun) : null;
  const recoveryView = recovery ? runView(recovery) : null;
  return envelope(requestId, {
    current: {
      release_id: current.releaseSha256,
      activated_at: current.activatedAt,
      counts: current.counts,
      validation: {
        source: "worker",
        as_of: validatedAt,
        state: "succeeded",
        release_id: current.releaseSha256,
      },
    },
    previous: previous
      ? { release_id: previous.release_id, activated_at: previous.finished_at ?? null }
      : null,
    smoke: smokeRun
      ? {
        source: smokeRun.source,
        as_of: smokeRun.finished_at ?? smokeRun.started_at ?? null,
        state: smokeRun.state,
        release_id: current.releaseSha256,
        run_id: smokeRun.run_id,
        code: smokeView.safe_summary_code,
      }
      : null,
    local_recovery: recovery
      ? {
        source: recovery.source,
        as_of: recovery.finished_at ?? recovery.started_at ?? null,
        state: recovery.state,
        run_id: recovery.run_id,
        code: recoveryView.safe_summary_code,
      }
      : null,
  });
}

async function releaseSmoke(env, requestId, url) {
  const expected = url.searchParams.get("expected_release_sha256");
  const expectedWorkerVersion = url.searchParams.get("expected_worker_version");
  const expectedGitSha = url.searchParams.get("expected_git_sha");
  if (expected !== null && !sha256Pattern.test(expected)) {
    return failure(
      requestId,
      400,
      "invalid_expected_release_sha256",
      "Expected release SHA-256 is invalid",
    );
  }
  if ((expectedWorkerVersion === null) !== (expectedGitSha === null) ||
      (expectedWorkerVersion !== null && !workerVersionPattern.test(expectedWorkerVersion)) ||
      (expectedGitSha !== null && !gitShaPattern.test(expectedGitSha))) {
    return failure(
      requestId,
      400,
      "invalid_expected_worker_release",
      "Expected Worker release identity is invalid",
    );
  }
  const current = await activeRelease(env);
  if (current.error) return activeReleaseFailure(requestId, current);
  if (expected !== null && expected.toLowerCase() !== current.releaseSha256) {
    return failure(
      requestId,
      409,
      "release_mismatch",
      "Active release does not match the expected release",
      true,
    );
  }
  const versionId = env.CF_VERSION_METADATA?.id;
  const versionTag = env.CF_VERSION_METADATA?.tag;
  const tagMatch = typeof versionTag === "string"
    ? /^git-([0-9a-f]{40})$/.exec(versionTag)
    : null;
  if (typeof versionId !== "string" || !workerVersionPattern.test(versionId) || !tagMatch) {
    return failure(
      requestId,
      503,
      "worker_version_unavailable",
      "Worker release identity is unavailable",
      true,
    );
  }
  const workerVersionId = versionId.toLowerCase();
  const workerGitSha = tagMatch[1];
  if (expectedWorkerVersion !== null &&
      (expectedWorkerVersion.toLowerCase() !== workerVersionId ||
       expectedGitSha.toLowerCase() !== workerGitSha)) {
    return failure(
      requestId,
      409,
      "worker_release_mismatch",
      "Worker does not match the expected release",
      true,
    );
  }
  const objectError = await releaseObjectsError(env, current.manifest);
  if (objectError) {
    const message = objectError === "release_reference_invalid"
      ? "Release object reference is invalid"
      : objectError === "release_object_size_mismatch"
        ? "Required release object size does not match the release"
        : "Required release object is unavailable";
    return failure(requestId, 503, objectError, message, true);
  }
  try {
    const schema = await env.CONTROL_DB.prepare(
      `SELECT
         (SELECT board_name FROM board_status LIMIT 1) AS board_name,
         (SELECT group_name FROM board_status LIMIT 1) AS group_name,
         (SELECT running FROM board_status LIMIT 1) AS running,
         (SELECT done FROM board_status LIMIT 1) AS done,
         (SELECT inventory_next_page FROM board_status LIMIT 1) AS inventory_next_page,
         (SELECT last_inventory_at FROM board_status LIMIT 1) AS last_inventory_at,
         (SELECT inventory_pass_started_at FROM board_status LIMIT 1)
           AS inventory_pass_started_at,
         (SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'index' AND name = 'commands_active_conflict_group_idx')
           AS command_integrity`,
    ).first();
    if (Number(schema?.command_integrity) !== 1) throw new Error("control schema incomplete");
  } catch {
    return failure(
      requestId,
      503,
      "d1_schema_unavailable",
      "Required control schema is unavailable",
      true,
    );
  }
  return envelope(requestId, {
    release_sha256: current.releaseSha256,
    worker_version_id: workerVersionId,
    worker_git_sha: workerGitSha,
    counts: current.counts,
    checks: { worker_version: true, r2_release: true, d1_schema: true },
  });
}

function staleRunStatements(env, now) {
  const nowText = now.toISOString();
  const staleBefore = new Date(now.getTime() - ACTIVE_RUN_MAX_AGE_MS).toISOString();
  const futureAfter = new Date(now.getTime() + CLIENT_FUTURE_CLOCK_SKEW_MS).toISOString();
  return [
    env.CONTROL_DB.prepare(
      `UPDATE commands SET state = 'failed', finished_at = ?, safe_message = ?
       WHERE state = 'claimed' AND run_id IN (
         SELECT run_id FROM runs
         WHERE state = 'running' AND (started_at < ? OR started_at > ?)
       )`,
    ).bind(nowText, STALE_RUN_CODE, staleBefore, futureAfter),
    env.CONTROL_DB.prepare(
      `UPDATE runs SET state = 'failed', finished_at = ?, safe_summary_json = ?
       WHERE state = 'running' AND (started_at < ? OR started_at > ?)`,
    ).bind(nowText, JSON.stringify({ code: STALE_RUN_CODE }), staleBefore, futureAfter),
  ];
}

async function reconcileStaleRuns(env, now) {
  await env.CONTROL_DB.batch(staleRunStatements(env, now));
}

export async function runControlMaintenance(env, now = new Date()) {
  const successBefore = new Date(now.getTime() - SUCCESS_RETENTION_MS).toISOString();
  const failureBefore = new Date(now.getTime() - FAILURE_RETENTION_MS).toISOString();
  await env.CONTROL_DB.batch([
    ...staleRunStatements(env, now),
    env.CONTROL_DB.prepare(
      `DELETE FROM commands WHERE finished_at IS NOT NULL AND (
         (state IN ('succeeded', 'cancelled', 'expired') AND finished_at < ?)
         OR (state IN ('partial', 'failed') AND finished_at < ?)
       )`,
    ).bind(successBefore, failureBefore),
    env.CONTROL_DB.prepare(
      `DELETE FROM runs WHERE finished_at IS NOT NULL AND (
         (state = 'succeeded' AND finished_at < ?)
         OR (state IN ('partial', 'failed') AND finished_at < ?)
       )`,
    ).bind(successBefore, failureBefore),
  ]);
}

async function overview(env, requestId) {
  const now = new Date();
  let activeRow = await env.CONTROL_DB.prepare(
    "SELECT * FROM runs WHERE state = 'running' ORDER BY started_at DESC, run_id DESC LIMIT 1",
  ).first();
  const activeStartedAt = Date.parse(activeRow?.started_at ?? "");
  if (activeRow && (!Number.isFinite(activeStartedAt) ||
      activeStartedAt < now.getTime() - ACTIVE_RUN_MAX_AGE_MS ||
      activeStartedAt > now.getTime() + CLIENT_FUTURE_CLOCK_SKEW_MS)) {
    await reconcileStaleRuns(env, now);
    activeRow = null;
  }
  const issueSince = new Date(now.getTime() - RECENT_ISSUE_MAX_AGE_MS).toISOString();
  const futureAfter = new Date(now.getTime() + CLIENT_FUTURE_CLOCK_SKEW_MS).toISOString();
  const [runner, latest, automatic, issue, queued, snapshot] = await Promise.all([
    env.CONTROL_DB.prepare("SELECT * FROM runner_status WHERE id = 1").first(),
    env.CONTROL_DB.prepare(
      `SELECT * FROM runs WHERE state <> 'running' AND started_at <= ?
       ORDER BY started_at DESC, run_id DESC LIMIT 1`,
    ).bind(futureAfter).first(),
    env.CONTROL_DB.prepare(
      `SELECT * FROM runs WHERE kind = 'scheduled' AND started_at <= ?
       ORDER BY started_at DESC, run_id DESC LIMIT 1`,
    ).bind(futureAfter).first(),
    env.CONTROL_DB.prepare(
      `SELECT issue.*,
          (
            SELECT MIN(recovery.started_at) FROM runs AS recovery
            WHERE recovery.kind = 'scheduled' AND recovery.state = 'succeeded'
              AND recovery.started_at > issue.started_at
              AND recovery.started_at <= ?
          ) AS recovered_at
       FROM runs AS issue
       WHERE issue.state IN ('partial', 'failed')
         AND issue.started_at >= ? AND issue.started_at <= ?
         AND COALESCE(json_extract(issue.safe_summary_json, '$.code'), '') <> 'schedule_paused'
       ORDER BY issue.started_at DESC, issue.run_id DESC LIMIT 1`,
    ).bind(futureAfter, issueSince, futureAfter).first(),
    env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM commands WHERE state IN ('queued', 'claimed')",
    ).first(),
    env.CONTROL_DB.prepare(
      `SELECT counters_json, recorded_at FROM run_events
       WHERE step = 'archive_snapshot' AND recorded_at <= ?
       ORDER BY recorded_at DESC, run_id DESC, sequence DESC LIMIT 1`,
    ).bind(futureAfter).first(),
  ]);
  let archiveSnapshot = null;
  try {
    const counters = JSON.parse(snapshot?.counters_json || "{}");
    if (snapshot && typeof snapshot.counters_json === "string" && validCounters(counters)) {
      archiveSnapshot = { recorded_at: snapshot.recorded_at, counters };
    }
  } catch {
    // Invalid historical telemetry is omitted rather than exposed.
  }
  const recentIssue = issue ? runView(issue) : null;
  if (recentIssue) {
    recentIssue.recovered_at = issue.recovered_at ?? null;
    recentIssue.recovered = Boolean(issue.recovered_at);
  }
  const nextScheduledAt = Date.parse(runner?.next_scheduled_at ?? "");
  const scheduleTimestampValid = Number.isFinite(nextScheduledAt) &&
    nextScheduledAt <= now.getTime() + NEXT_SCHEDULE_MAX_AHEAD_MS;
  const safeRunner = runner && !scheduleTimestampValid
    ? { ...runner, next_scheduled_at: null }
    : runner;
  return envelope(requestId, {
    runner: safeRunner ?? null,
    schedule_enabled: Boolean(runner?.next_scheduled_at) && scheduleTimestampValid,
    schedule_paused: runner?.state === "paused",
    active_run: activeRow ? runView(activeRow) : null,
    latest_run: latest ? runView(latest) : null,
    latest_automatic_run: automatic ? runView(automatic) : null,
    recent_issue: recentIssue,
    archive_snapshot: archiveSnapshot,
    active_commands: Number(queued?.count ?? 0),
  });
}

export async function readControlResponse(request, env, requestId, url) {
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/v1/runner/release-smoke") {
    return releaseSmoke(env, requestId, url);
  }
  if (url.pathname === "/api/v1/ops/overview") return overview(env, requestId);
  if (url.pathname === "/api/v1/ops/runs") return runsPage(env, requestId, url);
  if (url.pathname === "/api/v1/ops/boards") return boardsPage(env, requestId, url);
  if (url.pathname === "/api/v1/ops/failures") return failuresPage(env, requestId, url);
  if (url.pathname === "/api/v1/ops/releases") return releases(env, requestId);
  return null;
}
