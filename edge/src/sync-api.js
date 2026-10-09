// Device sync API (docs/24 §12.7, docs/00 ADR-016): the signed-in owner's reading records in D1.
// POST /api/v1/sync/push {deviceId, ops: [{opId, key, value}]} settles each op against the stored
// value (sync-rules.js) and answers the value every key now holds; GET /api/v1/sync/pull?since=<rev>
// returns the rows changed after that change number, oldest first.
import { SYNC_VALUE_MAX_CHARS, resolveSync, stableJson, validSyncKey, validSyncValue } from "../public/sync-rules.js";
import { readJson } from "./control-common.js";

const PUSH_BODY_MAX_BYTES = 1024 * 1024;
// D1 counts every statement against a per-request limit; 100 ops stay near 20 statements.
const PUSH_MAX_OPS = 100;
const PULL_PAGE = 500;
// D1 binds at most 100 parameters per statement.
const IN_CHUNK = 90;
const UPSERT_ROWS = 24;
const OPS_LOG_ROWS = 33;
const OPS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const opIdPattern = /^[A-Za-z0-9-]{8,64}$/;
const deviceIdPattern = /^[A-Za-z0-9-]{8,64}$/;
const encoder = new TextEncoder();

export async function ownerHash(subject) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(subject)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function answer(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function refused(status, code) {
  return answer({ error: code }, status);
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function storedRows(db, owner, keys) {
  const rows = new Map();
  for (const part of chunks(keys, IN_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT key, value, server_rev FROM user_sync WHERE owner_id = ? AND key IN (${part.map(() => "?").join(", ")})`,
    ).bind(owner, ...part).all();
    for (const row of results) rows.set(row.key, { value: JSON.parse(row.value), rev: row.server_rev });
  }
  return rows;
}

async function appliedOps(db, owner, opIds) {
  const seen = new Set();
  for (const part of chunks(opIds, IN_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT op_id FROM user_sync_ops WHERE owner_id = ? AND op_id IN (${part.map(() => "?").join(", ")})`,
    ).bind(owner, ...part).all();
    for (const row of results) seen.add(row.op_id);
  }
  return seen;
}

function validPush(body) {
  if (!deviceIdPattern.test(body?.deviceId ?? "") || !Array.isArray(body.ops) || body.ops.length > PUSH_MAX_OPS) return false;
  const opIds = new Set();
  for (const op of body.ops) {
    if (!opIdPattern.test(op?.opId ?? "") || opIds.has(op.opId) || !validSyncKey(op.key) || !validSyncValue(op.value)) return false;
    if (JSON.stringify(op.value).length > SYNC_VALUE_MAX_CHARS) return false;
    opIds.add(op.opId);
  }
  return true;
}

async function push(request, env, owner) {
  let body;
  try {
    body = await readJson(request, PUSH_BODY_MAX_BYTES);
  } catch (error) {
    return refused(error.status ?? 400, "invalid_body");
  }
  if (!validPush(body)) return refused(400, "invalid_ops");
  const db = env.CONTROL_DB;
  const keys = [...new Set(body.ops.map((op) => op.key))];
  const [stored, seen] = await Promise.all([storedRows(db, owner, keys), appliedOps(db, owner, body.ops.map((op) => op.opId))]);
  // Ops apply in order; a key named twice in one push settles against the first result.
  const current = new Map([...stored].map(([key, row]) => [key, row.value]));
  const writes = new Map();
  const fresh = [];
  for (const op of body.ops) {
    if (seen.has(op.opId)) continue;
    fresh.push(op);
    const before = current.get(op.key);
    const after = resolveSync(op.key, before, op.value);
    if (before && stableJson(after) === stableJson(before)) continue;
    current.set(op.key, after);
    writes.set(op.key, { value: after, opId: op.opId });
  }
  const now = new Date().toISOString();
  if (writes.size || fresh.length) {
    const statements = [
      db.prepare("INSERT INTO user_sync_owners (owner_id, rev) VALUES (?, 0) ON CONFLICT(owner_id) DO NOTHING").bind(owner),
    ];
    // Every written key takes the next change number. All rows read the counter before the one
    // statement that advances it, and D1 runs the batch as one transaction, so numbers never repeat.
    const written = [...writes];
    for (const [index, part] of chunks(written, UPSERT_ROWS).entries()) {
      const offset = index * UPSERT_ROWS;
      const rows = part.map((_, row) =>
        `(?1, ?${row * 4 + 4}, ?${row * 4 + 5}, (SELECT rev FROM user_sync_owners WHERE owner_id = ?1) + ?${row * 4 + 6}, ?2, ?${row * 4 + 7}, ?3)`);
      const values = part.flatMap(([key, write], row) => [key, JSON.stringify(write.value), offset + row + 1, write.opId]);
      statements.push(db.prepare(
        `INSERT INTO user_sync (owner_id, key, value, server_rev, device_id, op_id, updated_at) VALUES ${rows.join(", ")}
         ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, server_rev = excluded.server_rev,
           device_id = excluded.device_id, op_id = excluded.op_id, updated_at = excluded.updated_at`,
      ).bind(owner, body.deviceId, now, ...values));
    }
    if (written.length) {
      statements.push(db.prepare("UPDATE user_sync_owners SET rev = rev + ? WHERE owner_id = ?").bind(written.length, owner));
    }
    for (const part of chunks(fresh, OPS_LOG_ROWS)) {
      statements.push(db.prepare(
        `INSERT INTO user_sync_ops (owner_id, op_id, created_at) VALUES ${part.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT(owner_id, op_id) DO NOTHING`,
      ).bind(...part.flatMap((op) => [owner, op.opId, now])));
    }
    await db.batch(statements);
  }
  // What each key holds now: the page applies a value that differs from what it sent.
  const settled = await storedRows(db, owner, keys);
  return answer({
    acked: body.ops.map((op) => op.opId),
    rows: keys.filter((key) => settled.has(key)).map((key) => ({ key, value: settled.get(key).value, rev: settled.get(key).rev })),
  });
}

async function pull(url, env, owner) {
  const since = Number(url.searchParams.get("since") ?? "0");
  if (!Number.isSafeInteger(since) || since < 0) return refused(400, "invalid_since");
  const db = env.CONTROL_DB;
  const { results } = await db.prepare(
    "SELECT key, value, server_rev FROM user_sync WHERE owner_id = ? AND server_rev > ? ORDER BY server_rev LIMIT ?",
  ).bind(owner, since, PULL_PAGE).all();
  const head = await db.prepare("SELECT rev FROM user_sync_owners WHERE owner_id = ?").bind(owner).first();
  const rows = results.map((row) => ({ key: row.key, value: JSON.parse(row.value), rev: row.server_rev }));
  return answer({
    rows,
    rev: rows.length ? rows.at(-1).rev : Math.max(since, head?.rev ?? 0),
    more: rows.length === PULL_PAGE,
  });
}

// Only a signed-in person (an Access email) has records; SYNC_OWNERS, when set, names the owners
// allowed to keep them here (a comma-separated list of owner hashes).
export async function syncResponse(request, env, identity) {
  const url = new URL(request.url);
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD || identity?.role !== "user" || !identity.subject) return refused(403, "access_user_required");
  const owner = await ownerHash(identity.subject);
  const allowed = String(env.SYNC_OWNERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(owner)) return refused(403, "owner_not_allowed");
  try {
    if (url.pathname === "/api/v1/sync/push") {
      if (request.method !== "POST") return answer({ error: "method_not_allowed" }, 405);
      return await push(request, env, owner);
    }
    if (url.pathname === "/api/v1/sync/pull") {
      if (request.method !== "GET") return answer({ error: "method_not_allowed" }, 405);
      return await pull(url, env, owner);
    }
  } catch (error) {
    console.error("sync_unavailable", error instanceof Error ? error.message : String(error));
    return answer({ error: "unavailable" }, 503);
  }
  return refused(404, "not_found");
}

export async function pruneSyncOps(env, now = new Date()) {
  await env.CONTROL_DB.prepare("DELETE FROM user_sync_ops WHERE created_at < ?")
    .bind(new Date(now.getTime() - OPS_RETENTION_MS).toISOString()).run();
}
