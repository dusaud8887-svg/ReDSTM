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
        sql,
        bind(...values) {
          parameters = values;
          statement.parameters = values;
          return statement;
        },
        first() {
          return handler("first", sql, parameters);
        },
        run() {
          return handler("run", sql, parameters);
        },
        all() {
          return handler("all", sql, parameters);
        },
      };
      return statement;
    },
    batch(statements) {
      return handler("batch", "", statements);
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

test("allows one marker command alongside an active process command", async () => {
  let conflictSql = "";
  let inserted = false;
  const env = {
    CONTROL_DB: database((method, sql) => {
      if (sql === "SELECT * FROM commands WHERE idempotency_key = ?") return null;
      if (sql.startsWith("SELECT command_id FROM commands")) {
        conflictSql = sql;
        return null;
      }
      if (method === "run" && sql.includes("INSERT INTO commands")) {
        inserted = true;
        return { success: true };
      }
      assert.fail(`Unexpected D1 statement: ${method} ${sql}`);
    }),
  };
  const result = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "pause-after-current", args: {} },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "pause-during-process-001",
      },
    }),
    env,
    { role: "user", subject: "reader@example.test" },
  );

  assert.equal(result.status, 202);
  assert.match(conflictSql, /action IN \('pause-after-current', 'resume-schedule'\)/);
  assert.equal(inserted, true);

  const blocked = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "sync-now", args: {} },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "second-process-command-001",
      },
    }),
    {
      CONTROL_DB: database((method, sql) => {
        assert.equal(method, "first");
        if (sql === "SELECT * FROM commands WHERE idempotency_key = ?") return null;
        assert.doesNotMatch(sql, /action IN/);
        return { command_id: "active-process" };
      }),
    },
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(blocked.status, 409);
});

test("claims one command with a conditional update", async () => {
  let receivedSql = "";
  let receivedParameters = [];
  let reconciliation = [];
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
      if (method === "batch") {
        reconciliation = parameters;
        return [];
      }
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
  assert.doesNotMatch(receivedSql, /action IN/);
  assert.equal(receivedParameters[2], "oracle-primary");
  assert.equal(receivedParameters[3], "claim-attempt-001");
  assert.equal((await result.json()).data.command.state, "claimed");
  assert.equal(reconciliation.length, 3);
  assert.match(reconciliation[1].sql, /claim_attempts < 2/);
  assert.match(reconciliation[2].sql, /claim_lost/);

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

test("limits marker claims and rejects an invalid command kind", async () => {
  const noDatabase = { CONTROL_DB: database(() => assert.fail("D1 must not be called")) };
  const invalid = await controlApiResponse(
    request("/api/v1/runner/commands/claim", {
      method: "POST",
      body: { runner_id: "oracle-primary", command_kind: "process" },
      headers: { "Idempotency-Key": "claim-marker-invalid" },
    }),
    noDatabase,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(invalid.status, 400);

  let claimSql = "";
  let reconciliation = [];
  const claimed = {
    command_id: crypto.randomUUID(),
    action: "pause-after-current",
    state: "claimed",
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const env = {
    CONTROL_DB: database((method, sql, parameters) => {
      if (method === "batch") {
        reconciliation = parameters;
        return [];
      }
      if (sql.includes("WHERE claim_idempotency_key")) return null;
      claimSql = sql;
      return claimed;
    }),
  };
  const result = await controlApiResponse(
    request("/api/v1/runner/commands/claim", {
      method: "POST",
      body: { runner_id: "oracle-primary", command_kind: "marker" },
      headers: { "Idempotency-Key": "claim-marker-only" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(result.status, 200);
  assert.match(claimSql, /action IN \('pause-after-current', 'resume-schedule'\)/);
  assert.match(reconciliation[1].sql, /action IN \('pause-after-current', 'resume-schedule'\)/);
  assert.match(reconciliation[2].sql, /action IN \('pause-after-current', 'resume-schedule'\)/);
  assert.equal((await result.json()).data.command.action, "pause-after-current");
});

test("heartbeat and overview expose only bounded status", async () => {
  const statements = [];
  const env = {
    CONTROL_DB: database((method, sql, parameters) => {
      statements.push({ method, sql, parameters });
      if (method === "batch") {
        return parameters.map((_, index) => ({ meta: { changes: index === 1 ? 1 : 0 } }));
      }
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
  assert.match(statements[0].parameters[0].sql, /ON CONFLICT\(id\) DO UPDATE/);

  const commandId = crypto.randomUUID();
  const renewed = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: {
        runner_version: "git-abc123",
        state: "running",
        runner_id: "oracle-primary",
        active_command_id: commandId,
      },
      headers: { "Idempotency-Key": "heartbeat-lease-0001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal((await renewed.json()).data.command_lease_renewed, true);
  assert.match(statements[1].parameters[1].sql, /state = 'claimed'/);

  const overview = await controlApiResponse(
    request("/api/v1/ops/overview"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).data.active_commands, 0);
});

test("pages runs with an opaque keyset cursor and latest event", async () => {
  const rows = [
    {
      run_id: "run-003",
      kind: "scheduled",
      source: "systemd",
      state: "succeeded",
      started_at: "2026-07-12T03:00:00Z",
      event_sequence: 2,
      event_step: "publishing",
      event_state: "succeeded",
      event_recorded_at: "2026-07-12T03:01:00Z",
      event_counters_json: '{"changed_posts":1}',
    },
    {
      run_id: "run-002",
      kind: "scheduled",
      source: "systemd",
      state: "succeeded",
      started_at: "2026-07-12T02:00:00Z",
    },
  ];
  let parameters;
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      assert.equal(method, "all");
      assert.match(sql, /LEFT JOIN run_events/);
      parameters = values;
      return { results: rows };
    }),
  };
  const first = await controlApiResponse(
    request("/api/v1/ops/runs?limit=1"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(first.status, 200);
  const page = (await first.json()).data;
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].latest_event.counters, { changed_posts: 1 });
  assert.match(page.next_cursor, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(parameters, [2]);

  const second = await controlApiResponse(
    request(`/api/v1/ops/runs?limit=1&cursor=${page.next_cursor}`),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(second.status, 200);
  assert.deepEqual(parameters, [rows[0].started_at, rows[0].started_at, rows[0].run_id, 2]);
});

test("pages filtered board summaries without exposing source data", async () => {
  let parameters;
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      assert.equal(method, "all");
      assert.match(sql, /last_outcome = \?/);
      parameters = values;
      return {
        results: [{
          board_id: "aa",
          last_outcome: "succeeded",
          pending: 2,
          warning_code: null,
          upstream_url: "https://must-not-leak.example",
        }],
      };
    }),
  };
  const response = await controlApiResponse(
    request("/api/v1/ops/boards?state=succeeded&limit=5"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.items[0].pending, 2);
  assert.equal("upstream_url" in data.items[0], false);
  assert.deepEqual(parameters, ["succeeded", 6]);
});

test("returns bounded release metadata from the private R2 pointer", async () => {
  const manifest = {
    schema_version: 1,
    post_count: 10,
    comment_count: 20,
    board_count: 2,
    collection_count: 1,
    collection_entry_count: 3,
    unavailable_post_count: 4,
    unavailable_comment_count: 5,
    boards: [{ object_key: "must-not-leak.json.zst" }],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const env = {
    ARCHIVE: {
      get(key) {
        assert.equal(key, "release.json");
        return {
          size: bytes.byteLength,
          uploaded: new Date("2026-07-12T00:00:00Z"),
          arrayBuffer: async () => bytes.buffer,
        };
      },
    },
    CONTROL_DB: database((method, sql) => {
      assert.equal(method, "first");
      assert.match(sql, /release_id <> \?/);
      return { release_id: "previous-release", finished_at: "2026-07-11T00:00:00Z" };
    }),
  };
  const response = await controlApiResponse(
    request("/api/v1/ops/releases"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.current.counts.post_count, 10);
  assert.equal(data.previous.release_id, "previous-release");
  assert.equal(JSON.stringify(data).includes("must-not-leak"), false);
});

test("rejects malformed page controls before storage", async () => {
  const env = {
    CONTROL_DB: database(() => assert.fail("D1 must not be called")),
  };
  const limit = await controlApiResponse(
    request("/api/v1/ops/runs?limit=51"), env, { role: "user", subject: "reader" },
  );
  assert.equal(limit.status, 400);
  const cursor = await controlApiResponse(
    request("/api/v1/ops/boards?cursor=%25"), env, { role: "user", subject: "reader" },
  );
  assert.equal(cursor.status, 400);
});

test("starts a run and command link in one D1 batch", async () => {
  let statements = [];
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      if (method === "batch") {
        statements = values;
        return [];
      }
      if (sql.includes("SELECT * FROM runs")) return null;
      assert.match(sql, /SELECT action, state, run_id FROM commands/);
      return { action: "sync-now", state: "claimed", run_id: null };
    }),
  };
  const commandId = crypto.randomUUID();
  const result = await controlApiResponse(
    request("/api/v1/runner/runs", {
      method: "POST",
      body: {
        run_id: "sync-run-001",
        kind: "manual-sync",
        source: "command",
        command_id: commandId,
        started_at: "2026-07-12T00:00:00Z",
      },
      headers: { "Idempotency-Key": "start-run-001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(result.status, 202);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO runs/);
  assert.match(statements[1].sql, /UPDATE commands SET run_id/);
});

test("rejects a command run with a mismatched action", async () => {
  const env = {
    CONTROL_DB: database((method, sql) => {
      assert.equal(method, "first");
      if (sql.includes("SELECT * FROM runs")) return null;
      return { action: "retry-batch", state: "claimed", run_id: null };
    }),
  };
  const response = await controlApiResponse(
    request("/api/v1/runner/runs", {
      method: "POST",
      body: {
        run_id: "sync-run-002",
        kind: "manual-sync",
        source: "command",
        command_id: crypto.randomUUID(),
      },
      headers: { "Idempotency-Key": "start-run-mismatch" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 409);
});

test("upserts monotonic bounded board status", async () => {
  let sql;
  let parameters;
  const env = {
    CONTROL_DB: database((method, statement, values) => {
      assert.equal(method, "run");
      sql = statement;
      parameters = values;
      return { success: true };
    }),
  };
  const response = await controlApiResponse(
    request("/api/v1/runner/boards/status", {
      method: "POST",
      body: {
        board_id: "aa",
        last_scanned_at: "2026-07-12T04:00:00Z",
        last_outcome: "partial",
        counters: { discovered: 10, changed: 2, pending: 3, retry: 1, dead: 0 },
        warning_code: "parse_drift",
      },
      headers: { "Idempotency-Key": "board-status-0001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 200);
  assert.match(sql, /excluded\.last_scanned_at >= board_status\.last_scanned_at/);
  assert.deepEqual(parameters.slice(0, 3), ["aa", "2026-07-12T04:00:00.000Z", "partial"]);
});

test("finishes marker commands idempotently for the claiming runner", async () => {
  const commandId = crypto.randomUUID();
  const claimed = {
    command_id: commandId,
    action: "pause-after-current",
    state: "claimed",
    runner_id: "oracle-primary",
    requested_at: "2026-07-12T04:00:00Z",
    expires_at: "2026-07-12T04:15:00Z",
  };
  let updated = false;
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      assert.equal(method, "first");
      if (sql.startsWith("SELECT")) return updated ? { ...claimed, state: "succeeded" } : claimed;
      assert.match(sql, /runner_id = \? RETURNING/);
      assert.equal(values.at(-1), "oracle-primary");
      updated = true;
      return { ...claimed, state: "succeeded", safe_message: "schedule_paused" };
    }),
  };
  const options = {
    method: "POST",
    body: { runner_id: "oracle-primary", state: "succeeded", safe_summary_code: "schedule_paused" },
    headers: { "Idempotency-Key": "finish-marker-0001" },
  };
  const first = await controlApiResponse(
    request(`/api/v1/runner/commands/${commandId}/finish`, options),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(first.status, 200);
  const replay = await controlApiResponse(
    request(`/api/v1/runner/commands/${commandId}/finish`, options),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(replay.status, 200);
});

test("batches idempotent run events and terminal command state", async () => {
  const batches = [];
  let runState = "running";
  const run = {
    run_id: "sync-run-001",
    kind: "scheduled",
    source: "systemd",
    state: "running",
    started_at: "2026-07-12T00:00:00.000Z",
  };
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      if (method === "batch") {
        batches.push(values);
        return [];
      }
      if (sql.includes("SELECT state FROM runs")) return { state: runState };
      if (sql.includes("SELECT * FROM runs")) return { ...run, state: runState };
      return null;
    }),
  };
  const events = await controlApiResponse(
    request("/api/v1/runner/runs/sync-run-001/events:batch", {
      method: "POST",
      body: {
        events: [
          {
            sequence: 1,
            step: "crawling",
            state: "running",
            recorded_at: "2026-07-12T00:01:00Z",
            counters: { discovered: 2 },
          },
          {
            sequence: 2,
            step: "verifying",
            state: "running",
            recorded_at: "2026-07-12T00:02:00Z",
            counters: { changed_posts: 1 },
          },
        ],
      },
      headers: { "Idempotency-Key": "event-batch-001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(events.status, 200);
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /ON CONFLICT\(run_id, sequence\) DO NOTHING/);

  const finish = await controlApiResponse(
    request("/api/v1/runner/runs/sync-run-001/finish", {
      method: "POST",
      body: {
        state: "succeeded",
        counters: { changed_posts: 1, boards_ok: 46 },
        release_id: "release-abc123",
        safe_summary_code: "cycle_succeeded",
      },
      headers: { "Idempotency-Key": "finish-run-001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(finish.status, 200);
  assert.equal(batches[1].length, 2);
  assert.match(batches[1][1].sql, /UPDATE commands/);
});

test("rejects oversized event batches before D1", async () => {
  const env = { CONTROL_DB: database(() => assert.fail("D1 must not be called")) };
  const result = await controlApiResponse(
    request("/api/v1/runner/runs/sync-run-001/events:batch", {
      method: "POST",
      body: {
        events: Array.from({ length: 51 }, (_, sequence) => ({
          sequence,
          step: "crawling",
          state: "running",
          counters: {},
        })),
      },
      headers: { "Idempotency-Key": "event-batch-large" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(result.status, 400);
});
