import { envelope, failure, runView } from "./control-common.js";

const identifierPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;

function boardView(row) {
  return {
    board_id: row.board_id,
    last_scanned_at: row.last_scanned_at ?? null,
    last_outcome: row.last_outcome ?? null,
    discovered: Number(row.discovered ?? 0),
    changed: Number(row.changed ?? 0),
    pending: Number(row.pending ?? 0),
    retry: Number(row.retry ?? 0),
    dead: Number(row.dead ?? 0),
    warning_code: row.warning_code ?? null,
  };
}

function pageLimit(url) {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return 20;
  if (!/^\d{1,2}$/.test(raw)) throw Object.assign(new Error("Page limit is invalid"), { status: 400 });
  const limit = Number(raw);
  if (limit < 1 || limit > 50) {
    throw Object.assign(new Error("Page limit is invalid"), { status: 400 });
  }
  return limit;
}

function encodeCursor(values) {
  return btoa(JSON.stringify(values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(raw, count) {
  if (raw == null || raw === "") return null;
  if (raw.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw Object.assign(new Error("Page cursor is invalid"), { status: 400 });
  }
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      raw.length + ((4 - raw.length % 4) % 4),
      "=",
    );
    const values = JSON.parse(atob(padded));
    if (!Array.isArray(values) || values.length !== count ||
        !values.every((value) => typeof value === "string" && value.length <= 128)) {
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
  const cursorWhere = cursor
    ? "WHERE (r.started_at < ? OR (r.started_at = ? AND r.run_id < ?))"
    : "";
  let statement = env.CONTROL_DB.prepare(
    `SELECT r.*, e.sequence AS event_sequence, e.step AS event_step,
       e.state AS event_state, e.recorded_at AS event_recorded_at,
       e.counters_json AS event_counters_json, e.safe_message AS event_safe_message
     FROM runs AS r
     LEFT JOIN run_events AS e ON e.run_id = r.run_id AND e.sequence = (
       SELECT MAX(latest.sequence) FROM run_events AS latest WHERE latest.run_id = r.run_id
     )
     ${cursorWhere}
     ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`,
  );
  statement = cursor
    ? statement.bind(cursor[0], cursor[0], cursor[1], limit + 1)
    : statement.bind(limit + 1);
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

async function releases(env, requestId) {
  const object = await env.ARCHIVE.get("release.json");
  if (!object) return failure(requestId, 503, "release_unavailable", "Active release is unavailable", true);
  if (object.size > 64 * 1024) {
    return failure(requestId, 503, "release_invalid", "Active release is invalid");
  }
  const body = await object.arrayBuffer();
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return failure(requestId, 503, "release_invalid", "Active release is invalid");
  }
  const countFields = [
    "post_count",
    "comment_count",
    "board_count",
    "collection_count",
    "collection_entry_count",
    "unavailable_post_count",
    "unavailable_comment_count",
  ];
  if (!manifest || manifest.schema_version !== 1 ||
      !countFields.every((key) => Number.isSafeInteger(manifest[key]) && manifest[key] >= 0)) {
    return failure(requestId, 503, "release_invalid", "Active release is invalid");
  }
  const digest = await crypto.subtle.digest("SHA-256", body);
  const releaseId = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  const previous = await env.CONTROL_DB.prepare(
    `SELECT release_id, finished_at FROM runs
     WHERE release_id IS NOT NULL AND release_id <> ?
     ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
  ).bind(releaseId).first();
  return envelope(requestId, {
    current: {
      release_id: releaseId,
      activated_at: object.uploaded instanceof Date ? object.uploaded.toISOString() : null,
      counts: Object.fromEntries(countFields.map((key) => [key, manifest[key]])),
    },
    previous: previous
      ? { release_id: previous.release_id, activated_at: previous.finished_at ?? null }
      : null,
    smoke: null,
    local_recovery: null,
  });
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

export async function readControlResponse(request, env, requestId, url) {
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/v1/ops/overview") return overview(env, requestId);
  if (url.pathname === "/api/v1/ops/runs") return runsPage(env, requestId, url);
  if (url.pathname === "/api/v1/ops/boards") return boardsPage(env, requestId, url);
  if (url.pathname === "/api/v1/ops/releases") return releases(env, requestId);
  return null;
}
