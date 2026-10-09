import assert from "node:assert/strict";
import test from "node:test";

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { resolveSync, stableJson, validSyncKey, validSyncValue } from "../public/sync-rules.js";
import { ownerHash, pruneSyncOps, syncResponse } from "../src/sync-api.js";

// D1 stand-in on real SQLite with the real migrations (batch = one transaction, as on D1).
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
  const execute = (sql, parameters, mode) => {
    const statement = db.prepare(sql);
    if (mode === "first") {
      const row = statement.get(...parameters);
      return row ? { ...row } : null;
    }
    if (mode === "all") return { results: statement.all(...parameters).map((row) => ({ ...row })) };
    return { results: [], meta: { changes: Number(statement.run(...parameters).changes) } };
  };
  let statementsRun = 0;
  const CONTROL_DB = {
    prepare(sql) {
      const statement = {
        sql, parameters: [],
        bind(...values) { statement.parameters = values; return statement; },
        first: async () => { statementsRun += 1; return execute(sql, statement.parameters, "first"); },
        all: async () => { statementsRun += 1; return execute(sql, statement.parameters, "all"); },
        run: async () => { statementsRun += 1; return execute(sql, statement.parameters, "run"); },
      };
      return statement;
    },
    async batch(statements) {
      statementsRun += statements.length;
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.parameters, "run"));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, env: { CONTROL_DB, TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "aud" }, statements: () => statementsRun };
}

const me = { role: "user", subject: "reader@example.com" };
let opCounter = 0;
const op = (key, value, opId = `op-${String(++opCounter).padStart(6, "0")}`) => ({ opId, key, value });

async function push(env, ops, identity = me, deviceId = "device-aaaa") {
  const response = await syncResponse(new Request("https://archive.example/api/v1/sync/push", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId, ops }),
  }), env, identity);
  return { status: response.status, body: await response.json() };
}

async function pull(env, since, identity = me) {
  const response = await syncResponse(new Request(`https://archive.example/api/v1/sync/pull?since=${since}`), env, identity);
  return { status: response.status, body: await response.json() };
}

test("sync keys and values are checked before anything is stored", () => {
  for (const key of ["tm.h:board_a:12", "tm.b:board_a:12", "tm.later:post:board_a:3", "tm.view:board_a:3", "text.h:novel:1:2",
    "text.b:arcalive:9", "text.hidden:work:novel:1", "text.shelves", "library", "annotation:abc-123", "session:abc", "work:novel:12"]) {
    assert.equal(validSyncKey(key), true, key);
  }
  for (const key of ["", "tm.h:", "settings", "tm.h:a b", "annotation:../x", "offline:novel:1", 12]) assert.equal(validSyncKey(key), false, String(key));
  assert.equal(validSyncValue({ at: 1, data: { readAt: "x" } }), true);
  assert.equal(validSyncValue({ at: 1, deleted: true }), true);
  for (const value of [null, {}, { at: -1, data: {} }, { at: 1, data: [] }, { at: 1, deleted: true, data: {} }, { at: Number.NaN, data: {} }, { at: 1, data: {}, extra: 1 }]) {
    assert.equal(validSyncValue(value), false, JSON.stringify(value));
  }
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 1 }] }), stableJson({ a: [{ c: 1, d: 2 }], b: 1 }));
});

test("the later action wins, a tie is settled by content, and reading progress keeps its maximum", () => {
  const older = { at: 1000, data: { readAt: "2026-10-01T00:00:00Z", progress: 0.9 } };
  const newer = { at: 2000, data: { readAt: "2026-10-02T00:00:00Z", progress: 0.2 } };
  assert.deepEqual(resolveSync("tm.h:board_a:1", older, newer), { at: 2000, data: { readAt: "2026-10-02T00:00:00Z", progress: 0.9 } });
  assert.deepEqual(resolveSync("tm.h:board_a:1", newer, older), { at: 2000, data: { readAt: "2026-10-02T00:00:00Z", progress: 0.9 } });
  // Progress is a history rule only.
  assert.deepEqual(resolveSync("tm.b:board_a:1", { at: 1, data: { progress: 1 } }, { at: 2, data: { progress: 0 } }), { at: 2, data: { progress: 0 } });
  const left = { at: 5, data: { note: "a" } };
  const right = { at: 5, data: { note: "b" } };
  assert.deepEqual(resolveSync("work:novel:1", left, right), resolveSync("work:novel:1", right, left));
  // A deletion is an action too: a later read brings the record back, an earlier one does not.
  assert.equal(resolveSync("tm.h:board_a:1", { at: 3000, deleted: true }, newer).deleted, true);
  assert.deepEqual(resolveSync("tm.h:board_a:1", { at: 1500, deleted: true }, newer), newer);
});

test("a deleted mark or note never comes back, however late the old edit arrives", () => {
  const deleted = { at: 10, data: { id: "a1", deletedAt: "2026-10-01T00:00:00Z" } };
  const edited = { at: 99, data: { id: "a1", note: "edited later on an old device" } };
  assert.equal(resolveSync("annotation:a1", deleted, edited), deleted);
  assert.deepEqual(resolveSync("annotation:a1", edited, deleted), deleted);
});

test("sync needs a signed-in Access user and, when configured, an allowed owner", async () => {
  const { env } = sqliteD1();
  assert.equal((await pull({ ...env, TEAM_DOMAIN: "" }, 0)).status, 403);
  assert.equal((await pull(env, 0, { role: "user", subject: "" })).status, 403);
  assert.equal((await pull(env, 0, { role: "runner", subject: "client-id" })).status, 403);
  assert.equal((await pull({ ...env, SYNC_OWNERS: "0000000000000000" }, 0)).status, 403);
  const owner = await ownerHash(me.subject);
  assert.equal((await pull({ ...env, SYNC_OWNERS: ` 0000000000000000, ${owner}` }, 0)).status, 200);
  const response = await syncResponse(new Request("https://archive.example/api/v1/sync/push"), env, me);
  assert.equal(response.status, 405);
  const text = await syncResponse(new Request("https://archive.example/api/v1/sync/push", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
  }), env, me);
  assert.equal(text.status, 400);
});

test("a push stores each entry under a new change number and a pull returns them in order", async () => {
  const { env } = sqliteD1();
  const first = await push(env, [
    op("tm.h:board_a:1", { at: 100, data: { readAt: "2026-10-01T00:00:00Z", progress: 0.5 } }),
    op("tm.b:board_a:2", { at: 200, data: { savedAt: "2026-10-01T00:00:00Z" } }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(first.body.acked.length, 2);
  assert.deepEqual(first.body.rows.map((row) => [row.key, row.rev]), [["tm.h:board_a:1", 1], ["tm.b:board_a:2", 2]]);
  await push(env, [op("tm.b:board_a:2", { at: 300, deleted: true })]);
  const all = await pull(env, 0);
  assert.deepEqual(all.body.rows.map((row) => [row.key, row.rev]), [["tm.h:board_a:1", 1], ["tm.b:board_a:2", 3]]);
  assert.deepEqual(all.body.rows[1].value, { at: 300, deleted: true });
  assert.equal(all.body.rev, 3);
  assert.equal(all.body.more, false);
  const since = await pull(env, 3);
  assert.deepEqual(since.body, { rows: [], rev: 3, more: false });
  assert.equal((await pull(env, -1)).status, 400);
});

test("an older action loses, and the push answers the value the key kept", async () => {
  const { env } = sqliteD1();
  await push(env, [op("tm.h:board_a:1", { at: 500, data: { readAt: "2026-10-02T00:00:00Z", progress: 0.2 } })], me, "device-phone");
  const late = await push(env, [op("tm.h:board_a:1", { at: 400, data: { readAt: "2026-10-01T00:00:00Z", progress: 0.8 } })], me, "device-desk");
  // The newer position stays; the further progress is kept with it under a new change number.
  assert.deepEqual(late.body.rows, [{ key: "tm.h:board_a:1", value: { at: 500, data: { readAt: "2026-10-02T00:00:00Z", progress: 0.8 } }, rev: 2 }]);
  const same = await push(env, [op("tm.h:board_a:1", { at: 300, data: { readAt: "2026-09-30T00:00:00Z", progress: 0.1 } })]);
  // Nothing changed: no new change number.
  assert.equal(same.body.rows[0].rev, 2);
  assert.equal((await pull(env, 0)).body.rev, 2);
});

test("a retried push with the same operation ids changes nothing", async () => {
  const { env } = sqliteD1();
  const ops = [op("work:novel:1", { at: 10, data: { workKey: "novel:1", hue: 3 } })];
  await push(env, ops);
  await push(env, [op("work:novel:1", { at: 20, data: { workKey: "novel:1", hue: 5 } })]);
  // The first answer was lost and the device sends the same op again after a newer change.
  const retried = await push(env, ops);
  assert.deepEqual(retried.body.rows[0].value, { at: 20, data: { workKey: "novel:1", hue: 5 } });
  assert.equal(retried.body.rows[0].rev, 2);
  assert.deepEqual(retried.body.acked, [ops[0].opId]);
});

test("one push may name a key twice, and owners never see each other's rows", async () => {
  const { env } = sqliteD1();
  const pushed = await push(env, [
    op("tm.view:board_a:1", { at: 10, data: { mode: "aa" } }),
    op("tm.view:board_a:1", { at: 20, data: { mode: "prose" } }),
  ]);
  assert.deepEqual(pushed.body.rows, [{ key: "tm.view:board_a:1", value: { at: 20, data: { mode: "prose" } }, rev: 1 }]);
  const other = { role: "user", subject: "someone@example.com" };
  assert.deepEqual((await pull(env, 0, other)).body.rows, []);
  await push(env, [op("tm.view:board_a:1", { at: 5, data: { mode: "aa" } })], other);
  assert.deepEqual((await pull(env, 0, other)).body.rows.map((row) => row.value.data.mode), ["aa"]);
  assert.deepEqual((await pull(env, 0)).body.rows.map((row) => row.value.data.mode), ["prose"]);
});

test("malformed or oversized pushes are refused whole", async () => {
  const { env } = sqliteD1();
  const good = { at: 1, data: {} };
  for (const ops of [
    [op("settings", good)],
    [op("tm.h:board_a:1", { at: 1 })],
    [op("tm.h:board_a:1", good, "short")],
    [op("tm.h:board_a:1", good, "same-op-id"), op("tm.h:board_a:2", good, "same-op-id")],
    [op("tm.h:board_a:1", { at: 1, data: { text: "x".repeat(140 * 1024) } })],
    Array.from({ length: 101 }, (_, index) => op(`tm.h:board_a:${index}`, good)),
  ]) {
    assert.equal((await push(env, ops)).status, 400);
  }
  assert.equal((await push(env, [op("tm.h:board_a:1", good)], me, "x")).status, 400);
  assert.deepEqual((await pull(env, 0)).body.rows, []);
});

test("a full push stays within D1's per-request statement budget and pulls page by 500", async () => {
  const { env, statements } = sqliteD1();
  for (let batch = 0; batch < 6; batch += 1) {
    const before = statements();
    await push(env, Array.from({ length: 100 }, (_, index) => op(`tm.h:board_a:${batch * 100 + index}`, { at: index, data: { readAt: "2026-10-01T00:00:00Z" } })));
    assert.ok(statements() - before <= 25, `${statements() - before} statements`);
  }
  const first = await pull(env, 0);
  assert.equal(first.body.rows.length, 500);
  assert.equal(first.body.more, true);
  assert.equal(first.body.rev, 500);
  const rest = await pull(env, first.body.rev);
  assert.equal(rest.body.rows.length, 100);
  assert.equal(rest.body.more, false);
  assert.equal(rest.body.rev, 600);
});

test("operation ids older than 30 days are pruned; synced rows stay", async () => {
  const { db, env } = sqliteD1();
  await push(env, [op("library", { at: 1, data: { key: "library" } })]);
  db.prepare("UPDATE user_sync_ops SET created_at = '2026-01-01T00:00:00.000Z'").run();
  await pruneSyncOps(env, new Date("2026-10-09T00:00:00Z"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_sync_ops").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_sync").get().count, 1);
});
