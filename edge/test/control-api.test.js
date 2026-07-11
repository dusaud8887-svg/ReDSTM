import assert from "node:assert/strict";
import test from "node:test";

import { controlApiResponse } from "../src/control-api.js";

const requestId = "018f47a8-7a2d-7c11-8f44-89d95775c6ea";

function request(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://archive.example${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "X-Request-Id": requestId,
      "X-ReDSTM-Protocol": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  });
}

function database(handler) {
  return {
    prepare(sql) {
      let parameters = [];
      const statement = {
        bind(...values) {
          parameters = values;
          return statement;
        },
        first() {
          return handler("first", sql, parameters);
        },
        run() {
          return handler("run", sql, parameters);
        },
      };
      return statement;
    },
  };
}

test("enforces protocol and route roles before D1", async () => {
  const env = { CONTROL_DB: database(() => assert.fail("D1 must not be called")) };
  const missing = await controlApiResponse(
    new Request("https://archive.example/api/v1/ops/overview"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(missing.status, 400);

  const denied = await controlApiResponse(
    request("/api/v1/runner/heartbeat", { method: "POST", body: {} }),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(denied.status, 403);

  const oversized = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "sync-now", args: {}, padding: "x".repeat(17 * 1024) },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "oversized-command-001",
      },
    }),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(oversized.status, 413);
});

test("returns an existing idempotent command without inserting", async () => {
  let calls = 0;
  const existing = {
    command_id: crypto.randomUUID(),
    action: "sync-now",
    state: "queued",
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const env = {
    CONTROL_DB: database((method, sql) => {
      calls += 1;
      assert.equal(method, "first");
      assert.match(sql, /idempotency_key/);
      return existing;
    }),
  };
  const result = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "sync-now", args: {} },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "command-repeat-001",
      },
    }),
    env,
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.command_id, existing.command_id);
  assert.equal(calls, 1);
});

test("claims one command with a conditional update", async () => {
  let receivedSql = "";
  let receivedParameters = [];
  let updates = 0;
  const claimed = {
    command_id: crypto.randomUUID(),
    action: "retry-batch",
    state: "claimed",
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const env = {
    CONTROL_DB: database((method, sql, parameters) => {
      if (sql.includes("WHERE claim_idempotency_key")) return updates ? claimed : null;
      updates += 1;
      receivedSql = sql;
      receivedParameters = parameters;
      assert.equal(method, "first");
      return claimed;
    }),
  };
  const result = await controlApiResponse(
    request("/api/v1/runner/commands/claim", {
      method: "POST",
      body: { runner_id: "oracle-primary" },
      headers: { "Idempotency-Key": "claim-attempt-001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(result.status, 200);
  assert.match(receivedSql, /UPDATE commands/);
  assert.match(receivedSql, /RETURNING \*/);
  assert.equal(receivedParameters[2], "oracle-primary");
  assert.equal(receivedParameters[3], "claim-attempt-001");
  assert.equal((await result.json()).data.command.state, "claimed");

  const replay = await controlApiResponse(
    request("/api/v1/runner/commands/claim", {
      method: "POST",
      body: { runner_id: "oracle-primary" },
      headers: { "Idempotency-Key": "claim-attempt-001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal((await replay.json()).data.command.command_id, claimed.command_id);
  assert.equal(updates, 1);
});

test("heartbeat and overview expose only bounded status", async () => {
  const statements = [];
  const env = {
    CONTROL_DB: database((method, sql, parameters) => {
      statements.push({ method, sql, parameters });
      if (sql.includes("runner_status WHERE")) {
        return { state: "idle", heartbeat_at: "2026-07-12T00:00:00.000Z" };
      }
      if (sql.includes("FROM runs")) return null;
      if (sql.includes("COUNT(*)")) return { count: 0 };
      return { success: true };
    }),
  };
  const invalid = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: { runner_version: "git-abc123", state: "idle", active_step: "C:\\secret" },
      headers: { "Idempotency-Key": "heartbeat-invalid" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(invalid.status, 400);
  assert.equal(statements.length, 0);

  const heartbeat = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: { runner_version: "git-abc123", state: "idle", disk_free_bytes: 1000 },
      headers: { "Idempotency-Key": "heartbeat-0001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(heartbeat.status, 200);
  assert.match(statements[0].sql, /ON CONFLICT\(id\) DO UPDATE/);

  const overview = await controlApiResponse(
    request("/api/v1/ops/overview"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).data.active_commands, 0);
});
