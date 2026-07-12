import assert from "node:assert/strict";
import test from "node:test";

import { controlApiResponse } from "../src/control-api.js";

const requestId = "018f47a8-7a2d-7c11-8f44-89d95775c6ea";
const workerVersionId = "12345678-1234-1234-1234-123456789abc";
const workerGitSha = "a".repeat(40);
const workerVersionMetadata = {
  id: workerVersionId,
  tag: `git-${workerGitSha}`,
  timestamp: "2026-07-12T00:00:00.000Z",
};

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
    CONTROL_DB: database((method, sql, values) => {
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

test("rejects an idempotency key reused for a different command intent", async () => {
  const existing = {
    command_id: crypto.randomUUID(),
    action: "sync-now",
    state: "queued",
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const env = {
    CONTROL_DB: database((method, sql) => {
      assert.equal(method, "first");
      assert.equal(sql, "SELECT * FROM commands WHERE idempotency_key = ?");
      return existing;
    }),
  };
  const result = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "retry-batch", args: {} },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "command-repeat-001",
      },
    }),
    env,
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, "idempotency_conflict");
});

test("replays an already cancelled command", async () => {
  const commandId = crypto.randomUUID();
  const cancelled = {
    command_id: commandId,
    action: "sync-now",
    state: "cancelled",
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    finished_at: new Date().toISOString(),
  };
  const env = {
    CONTROL_DB: database((method, sql) => {
      if (method === "first" && sql.startsWith("UPDATE commands")) return null;
      if (method === "first" && sql === "SELECT * FROM commands WHERE command_id = ?") {
        return cancelled;
      }
      assert.fail(`Unexpected D1 statement: ${method} ${sql}`);
    }),
  };
  const result = await controlApiResponse(
    request(`/api/v1/ops/commands/${commandId}`, {
      method: "DELETE",
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "cancel-repeat-001",
      },
    }),
    env,
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.state, "cancelled");
});

test("allows one marker command alongside an active process command", async () => {
  let conflictSql = "";
  let inserted = false;
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      if (sql === "SELECT * FROM commands WHERE idempotency_key = ?") return null;
      if (method === "run" && sql.includes("SET state = 'expired'")) {
        return { success: true };
      }
      if (sql.startsWith("SELECT command_id FROM commands")) {
        conflictSql = sql;
        return null;
      }
      if (method === "run" && sql.includes("INSERT INTO commands")) {
        inserted = true;
        assert.doesNotMatch(sql, /active_conflict_group/);
        assert.equal(values.length, 6);
        assert.match(values.at(-1), /^\d{4}-\d{2}-\d{2}T/);
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
        if (sql === "SELECT * FROM commands WHERE idempotency_key = ?") return null;
        if (method === "run" && sql.includes("SET state = 'expired'")) {
          return { success: true };
        }
        assert.equal(method, "first");
        assert.match(sql, /action NOT IN \('pause-after-current', 'resume-schedule'\)/);
        return { command_id: "active-process" };
      }),
    },
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(blocked.status, 409);
});

test("returns a stable conflict when the database wins a command creation race", async () => {
  let conflictReads = 0;
  const env = {
    CONTROL_DB: database((method, sql) => {
      if (sql === "SELECT * FROM commands WHERE idempotency_key = ?") return null;
      if (method === "run" && sql.includes("SET state = 'expired'")) {
        return { success: true };
      }
      if (method === "run" && sql.includes("INSERT INTO commands")) {
        throw new Error("UNIQUE constraint failed: index commands_active_conflict_group_idx");
      }
      if (method === "first" && sql.startsWith("SELECT command_id FROM commands")) {
        conflictReads += 1;
        return conflictReads === 1 ? null : { command_id: "race-winner" };
      }
      assert.fail(`Unexpected D1 statement: ${method} ${sql}`);
    }),
  };
  const response = await controlApiResponse(
    request("/api/v1/ops/commands", {
      method: "POST",
      body: { action: "sync-now", args: {} },
      headers: {
        Origin: "https://archive.example",
        "X-ReDSTM-Command": "1",
        "Idempotency-Key": "process-race-loser-001",
      },
    }),
    env,
    { role: "user", subject: "reader@example.test" },
  );
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).error, {
    code: "command_conflict",
    message: "Another command is active",
    retryable: true,
  });
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
  assert.match(reconciliation[1].sql, /claim_attempts < \?/);
  assert.equal(reconciliation[1].parameters[1], 2);
  assert.match(reconciliation[2].sql, /claim_lost/);
  assert.equal(reconciliation[2].parameters[2], 2);

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
  let staleRunReconciled = false;
  const env = {
    CONTROL_DB: database((method, sql, parameters) => {
      statements.push({ method, sql, parameters });
      if (method === "batch") {
        staleRunReconciled ||= parameters.some((statement) =>
          statement.sql.includes("UPDATE runs SET state = 'failed'"));
        return parameters.map((_, index) => ({ meta: { changes: index === 1 ? 1 : 0 } }));
      }
      if (sql.includes("runner_status WHERE")) {
        return {
          state: "idle",
          heartbeat_at: "2026-07-12T00:00:00.000Z",
          next_scheduled_at: "2026-07-12T06:17:00.000Z",
        };
      }
      if (sql.includes("FROM run_events")) {
        assert.match(sql, /recorded_at <= \?/);
        return {
          counters_json: JSON.stringify({
            outline_only: 3,
            frontier_pending: 2,
            inventory_total_boards: 46,
            inventory_completed_boards: 40,
          }),
          recorded_at: "2026-07-12T04:00:00.000Z",
        };
      }
      if (sql.includes("state IN ('partial', 'failed')")) {
        assert.match(sql, /issue\.started_at >= \? AND issue\.started_at <= \?/);
        return {
          run_id: "run-partial", kind: "scheduled", source: "systemd", state: "partial",
          started_at: "2026-07-12T03:00:00.000Z", safe_summary_json: '{"code":"parse_drift"}',
          recovered_at: "2026-07-12T04:00:00.000Z",
        };
      }
      if (sql.includes("kind = 'scheduled'")) {
        return {
          run_id: "run-automatic", kind: "scheduled", source: "systemd", state: "succeeded",
          started_at: "2026-07-12T04:00:00.000Z", safe_summary_json: '{"code":"scheduled_succeeded"}',
        };
      }
      if (sql.includes("state <> 'running'")) {
        return {
          run_id: "run-latest", kind: "scheduled", source: "systemd", state: "succeeded",
          started_at: "2026-07-12T04:00:00.000Z", safe_summary_json: '{"code":"scheduled_succeeded"}',
        };
      }
      if (sql.includes("state = 'running'")) {
        if (staleRunReconciled) return null;
        return {
          run_id: "run-abandoned", kind: "scheduled", source: "systemd", state: "running",
          started_at: "2999-01-01T00:00:00.000Z",
          safe_summary_json: null,
        };
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

  const unsupportedWarning = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: { runner_version: "git-abc123", state: "degraded", safe_warning_code: "backup_stale" },
      headers: { "Idempotency-Key": "heartbeat-warning-invalid" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(unsupportedWarning.status, 400);
  assert.equal(statements.length, 0);

  const impossibleSchedule = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: {
        runner_version: "git-abc123",
        state: "idle",
        next_scheduled_at: "2999-01-01T00:00:00Z",
      },
      headers: { "Idempotency-Key": "heartbeat-schedule-invalid" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(impossibleSchedule.status, 400);
  assert.equal(statements.length, 0);

  const heartbeat = await controlApiResponse(
    request("/api/v1/runner/heartbeat", {
      method: "POST",
      body: {
        runner_version: "git-abc123", state: "degraded", disk_free_bytes: 1000,
        safe_warning_code: "control_rejected",
      },
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
  const overviewData = (await overview.json()).data;
  assert.equal(overviewData.active_commands, 0);
  assert.equal(overviewData.active_run, null);
  assert.equal(staleRunReconciled, true);
  assert.equal(overviewData.schedule_enabled, true);
  assert.equal(overviewData.latest_run.safe_summary_code, "scheduled_succeeded");
  assert.equal(overviewData.latest_automatic_run.run_id, "run-automatic");
  assert.equal(overviewData.recent_issue.safe_summary_code, "parse_drift");
  assert.equal(overviewData.recent_issue.recovered, true);
  assert.equal(overviewData.recent_issue.recovered_at, "2026-07-12T04:00:00.000Z");
  assert.equal(overviewData.archive_snapshot.counters.outline_only, 3);
});

test("ignores a historical impossible next schedule timestamp", async () => {
  const env = {
    CONTROL_DB: database((method, sql) => {
      assert.equal(method, "first");
      if (sql.includes("runner_status WHERE")) {
        return {
          state: "idle",
          heartbeat_at: new Date().toISOString(),
          next_scheduled_at: "2999-01-01T00:00:00.000Z",
        };
      }
      if (sql.includes("COUNT(*)")) return { count: 0 };
      return null;
    }),
  };

  const response = await controlApiResponse(
    request("/api/v1/ops/overview"),
    env,
    { role: "user", subject: "reader" },
  );
  const data = (await response.json()).data;

  assert.equal(response.status, 200);
  assert.equal(data.schedule_enabled, false);
  assert.equal(data.runner.next_scheduled_at, null);
});

test("pages runs with an opaque keyset cursor and latest event", async () => {
  const rows = [
    {
      run_id: "run-003",
      kind: "scheduled",
      source: "systemd",
      state: "succeeded",
      started_at: "2026-07-12T03:00:00Z",
      safe_summary_json: '{"code":"scheduled_succeeded"}',
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
      assert.match(sql, /latest\.step <> 'archive_snapshot'/);
      assert.match(sql, /WHERE r\.started_at <= \?/);
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
  assert.equal(page.items[0].safe_summary_code, "scheduled_succeeded");
  assert.match(page.next_cursor, /^[a-zA-Z0-9_-]+$/);
  assert.equal(parameters.length, 2);
  assert.ok(Date.parse(parameters[0]) > Date.now());
  assert.ok(Date.parse(parameters[0]) <= Date.now() + 6 * 60 * 1000);
  assert.equal(parameters[1], 2);

  const second = await controlApiResponse(
    request(`/api/v1/ops/runs?limit=1&cursor=${page.next_cursor}`),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(second.status, 200);
  assert.deepEqual(parameters.slice(1), [
    rows[0].started_at,
    rows[0].started_at,
    rows[0].run_id,
    2,
  ]);
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
      if (sql.includes("kind = 'retry'")) return null;
      if (sql.includes("release_id = ?")) return null;
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
  assert.equal(data.current.validation.source, "worker");
  assert.equal(data.current.validation.state, "succeeded");
  assert.equal(data.current.validation.release_id, data.current.release_id);
  assert.equal(data.smoke, null);
  assert.equal(data.local_recovery, null);
  assert.equal(JSON.stringify(data).includes("must-not-leak"), false);
});

test("derives release smoke and local recovery evidence from terminal runs", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schema_version: 1,
    post_count: 10,
    comment_count: 20,
    board_count: 2,
    collection_count: 1,
    collection_entry_count: 3,
    unavailable_post_count: 4,
    unavailable_comment_count: 5,
  }));
  const env = {
    ARCHIVE: {
      get: () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }),
    },
    CONTROL_DB: database((_method, sql) => {
      if (sql.includes("release_id <> ?")) return null;
      if (sql.includes("release_id = ?")) {
        return {
          run_id: "publish-run",
          source: "command",
          state: "succeeded",
          started_at: "2026-07-12T01:00:00Z",
          finished_at: "2026-07-12T01:01:00Z",
          safe_summary_json: '{"code":"publish_succeeded"}',
        };
      }
      assert.match(sql, /kind = 'retry'/);
      return {
        run_id: "retry-run",
        source: "systemd",
        state: "partial",
        started_at: "2026-07-12T02:00:00Z",
        finished_at: "2026-07-12T02:02:00Z",
        safe_summary_json: '{"code":"run_partial"}',
      };
    }),
  };

  const response = await controlApiResponse(
    request("/api/v1/ops/releases"), env, { role: "user", subject: "reader" },
  );
  const data = (await response.json()).data;
  assert.deepEqual(data.smoke, {
    source: "command",
    as_of: "2026-07-12T01:01:00Z",
    state: "succeeded",
    release_id: data.current.release_id,
    run_id: "publish-run",
    code: "publish_succeeded",
  });
  assert.deepEqual(data.local_recovery, {
    source: "systemd",
    as_of: "2026-07-12T02:02:00Z",
    state: "partial",
    run_id: "retry-run",
    code: "run_partial",
  });
});

test("runner release smoke verifies the expected release and current D1 schema", async () => {
  const objectSha256 = "a".repeat(64);
  const refs = [
    { object_key: "search/title-author.json.zst", object_bytes: 101, object_sha256: objectSha256 },
    { object_key: "collections/all.json.zst", object_bytes: 202, object_sha256: objectSha256 },
    { object_key: "boards/must-not-leak.json.zst", object_bytes: 303, object_sha256: objectSha256 },
  ];
  const manifest = {
    schema_version: 1,
    post_count: 10,
    comment_count: 20,
    board_count: 2,
    collection_count: 1,
    collection_entry_count: 3,
    unavailable_post_count: 4,
    unavailable_comment_count: 5,
    search: refs[0],
    collections: refs[1],
    boards: [refs[2]],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const releaseSha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  let r2Reads = 0;
  const r2Heads = [];
  let d1Reads = 0;
  const env = {
    CF_VERSION_METADATA: workerVersionMetadata,
    ARCHIVE: {
      get(key) {
        r2Reads += 1;
        assert.equal(key, "release.json");
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      },
      head(key) {
        r2Heads.push(key);
        const ref = refs.find((candidate) => candidate.object_key === key);
        return ref ? { size: ref.object_bytes } : null;
      },
    },
    CONTROL_DB: database((method, sql) => {
      d1Reads += 1;
      assert.equal(method, "first");
      for (const column of [
        "board_name",
        "group_name",
        "running",
        "done",
        "inventory_next_page",
        "last_inventory_at",
        "inventory_pass_started_at",
        "commands_active_conflict_group_idx",
      ]) {
        assert.match(sql, new RegExp(`\\b${column}\\b`));
      }
      assert.match(sql, /FROM sqlite_master/);
      return { command_integrity: 1 };
    }),
  };
  const response = await controlApiResponse(
    request(
      `/api/v1/runner/release-smoke?expected_release_sha256=${releaseSha256.toUpperCase()}` +
      `&expected_worker_version=${workerVersionId.toUpperCase()}` +
      `&expected_git_sha=${workerGitSha.toUpperCase()}`,
    ),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.api_version, 1);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.data.release_sha256, releaseSha256);
  assert.equal(payload.data.worker_version_id, workerVersionId);
  assert.equal(payload.data.worker_git_sha, workerGitSha);
  assert.deepEqual(payload.data.checks, {
    worker_version: true,
    r2_release: true,
    d1_schema: true,
  });
  assert.equal(payload.data.counts.post_count, 10);
  assert.equal(JSON.stringify(payload.data).includes("must-not-leak"), false);
  assert.equal(r2Reads, 1);
  assert.deepEqual(r2Heads, refs.map((ref) => ref.object_key));
  assert.equal(d1Reads, 1);

  const denied = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    env,
    { role: "user", subject: "reader" },
  );
  assert.equal(denied.status, 403);
  assert.equal(r2Reads, 1);
  assert.equal(r2Heads.length, 3);
  assert.equal(d1Reads, 1);
});

test("runner release smoke rejects invalid, missing, and size-mismatched object refs", async () => {
  const objectSha256 = "b".repeat(64);
  const refs = [
    { object_key: "search/title-author.json.zst", object_bytes: 11, object_sha256: objectSha256 },
    { object_key: "collections/all.json.zst", object_bytes: 22, object_sha256: objectSha256 },
    { object_key: "boards/write/manifest.json.zst", object_bytes: 33, object_sha256: objectSha256 },
  ];
  const manifest = {
    schema_version: 1,
    post_count: 1,
    comment_count: 2,
    board_count: 1,
    collection_count: 4,
    collection_entry_count: 5,
    unavailable_post_count: 6,
    unavailable_comment_count: 7,
    search: refs[0],
    collections: refs[1],
    boards: [refs[2]],
  };
  const noD1 = database(() => assert.fail("D1 must not be called"));
  const archive = (release, head) => {
    const bytes = new TextEncoder().encode(JSON.stringify(release));
    return {
      get: () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }),
      head,
    };
  };

  const invalid = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: archive(
        { ...manifest, search: { ...refs[0], object_key: "../search.json.zst" } },
        () => assert.fail("R2 head must not be called for an invalid ref"),
      ),
      CONTROL_DB: noD1,
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(invalid.status, 503);
  assert.deepEqual((await invalid.json()).error, {
    code: "release_reference_invalid",
    message: "Release object reference is invalid",
    retryable: true,
  });

  const missing = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: archive(manifest, (key) =>
        key === refs[1].object_key ? null : { size: refs.find((ref) => ref.object_key === key).object_bytes }),
      CONTROL_DB: noD1,
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, "release_object_unavailable");

  const mismatch = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: archive(manifest, (key) => ({
        size: key === refs[2].object_key
          ? refs[2].object_bytes + 1
          : refs.find((ref) => ref.object_key === key).object_bytes,
      })),
      CONTROL_DB: noD1,
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(mismatch.status, 503);
  const mismatchError = (await mismatch.json()).error;
  assert.equal(mismatchError.code, "release_object_size_mismatch");
  assert.equal(mismatchError.retryable, true);
});

test("runner release smoke permits no board ref when the release has no boards", async () => {
  const refs = [
    { object_key: "search/empty.json.zst", object_bytes: 1, object_sha256: "d".repeat(64) },
    { object_key: "collections/empty.json.zst", object_bytes: 2, object_sha256: "e".repeat(64) },
  ];
  const bytes = new TextEncoder().encode(JSON.stringify({
    schema_version: 1,
    post_count: 0,
    comment_count: 0,
    board_count: 0,
    collection_count: 0,
    collection_entry_count: 0,
    unavailable_post_count: 0,
    unavailable_comment_count: 0,
    search: refs[0],
    collections: refs[1],
  }));
  const heads = [];
  const response = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: {
        get: () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }),
        head(key) {
          heads.push(key);
          const ref = refs.find((candidate) => candidate.object_key === key);
          return ref ? { size: ref.object_bytes } : null;
        },
      },
      CONTROL_DB: database(() => ({ command_integrity: 1 })),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(heads, refs.map((ref) => ref.object_key));
});

test("runner release smoke fails safely before exposing storage details", async () => {
  const noStorage = {
    ARCHIVE: { get: () => assert.fail("R2 must not be called") },
    CONTROL_DB: database(() => assert.fail("D1 must not be called")),
  };
  const invalidExpected = await controlApiResponse(
    request("/api/v1/runner/release-smoke?expected_release_sha256=not-a-sha"),
    noStorage,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(invalidExpected.status, 400);
  assert.equal((await invalidExpected.json()).error.code, "invalid_expected_release_sha256");

  const objectSha256 = "c".repeat(64);
  const refs = [
    { object_key: "search/title-author.json.zst", object_bytes: 1, object_sha256: objectSha256 },
    { object_key: "collections/all.json.zst", object_bytes: 2, object_sha256: objectSha256 },
    { object_key: "boards/write/manifest.json.zst", object_bytes: 3, object_sha256: objectSha256 },
  ];
  const manifest = {
    schema_version: 1,
    post_count: 1,
    comment_count: 2,
    board_count: 3,
    collection_count: 4,
    collection_entry_count: 5,
    unavailable_post_count: 6,
    unavailable_comment_count: 7,
    search: refs[0],
    collections: refs[1],
    boards: [refs[2]],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const archive = {
    get() {
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    },
    head(key) {
      const ref = refs.find((candidate) => candidate.object_key === key);
      return ref ? { size: ref.object_bytes } : null;
    },
  };
  const mismatch = await controlApiResponse(
    request(`/api/v1/runner/release-smoke?expected_release_sha256=${"0".repeat(64)}`),
    {
      ARCHIVE: archive,
      CONTROL_DB: database(() => assert.fail("D1 must not be called")),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "release_mismatch");

  const missingWorkerVersion = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      ARCHIVE: archive,
      CONTROL_DB: database(() => assert.fail("D1 must not be called")),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(missingWorkerVersion.status, 503);
  assert.equal((await missingWorkerVersion.json()).error.code, "worker_version_unavailable");

  const wrongWorkerVersion = await controlApiResponse(
    request(
      `/api/v1/runner/release-smoke?expected_worker_version=${workerVersionId}` +
      `&expected_git_sha=${"b".repeat(40)}`,
    ),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: archive,
      CONTROL_DB: database(() => assert.fail("D1 must not be called")),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(wrongWorkerVersion.status, 409);
  assert.equal((await wrongWorkerVersion.json()).error.code, "worker_release_mismatch");

  const missingSchema = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      CF_VERSION_METADATA: workerVersionMetadata,
      ARCHIVE: archive,
      CONTROL_DB: database(() => {
        throw new Error("no such column: board_name at /private/control.sqlite");
      }),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(missingSchema.status, 503);
  const error = await missingSchema.json();
  assert.equal(error.error.code, "d1_schema_unavailable");
  assert.equal(JSON.stringify(error).includes("private"), false);

  const invalidCounts = new TextEncoder().encode(JSON.stringify({ ...manifest, post_count: -1 }));
  const invalidRelease = await controlApiResponse(
    request("/api/v1/runner/release-smoke"),
    {
      ARCHIVE: {
        get() {
          return {
            size: invalidCounts.byteLength,
            arrayBuffer: async () => invalidCounts.buffer,
          };
        },
      },
      CONTROL_DB: database(() => assert.fail("D1 must not be called")),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(invalidRelease.status, 503);
  assert.equal((await invalidRelease.json()).error.code, "release_invalid");
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
        return values.map(() => ({ meta: { changes: 1 } }));
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
  assert.match(statements[0].sql, /SELECT \?, \?, \?, 'running', \?, \? FROM commands/);
  assert.match(statements[0].sql, /state = 'claimed' AND run_id IS NULL/);
  assert.doesNotMatch(statements[0].sql, /ON CONFLICT/);
  assert.equal(statements[0].parameters[4], "2026-07-12T00:00:00.000Z");
  assert.deepEqual(statements[0].parameters.slice(-2), [commandId, "sync-now"]);
  assert.match(statements[1].sql, /UPDATE commands SET run_id/);
  assert.match(statements[1].sql, /state = 'claimed' AND run_id IS NULL/);
  assert.deepEqual(statements[1].parameters, ["sync-run-001", commandId, "sync-now"]);
});

test("allows only one run to win a claimed command start race", async () => {
  const commandId = crypto.randomUUID();
  const command = { action: "sync-now", state: "claimed", run_id: null };
  const runs = new Map();
  let commandReads = 0;
  let releasePrechecks;
  const prechecksReady = new Promise((resolve) => {
    releasePrechecks = resolve;
  });
  let batches = 0;
  const env = {
    CONTROL_DB: database((method, sql, values) => {
      if (method === "first" && sql.includes("SELECT * FROM runs")) {
        return runs.get(values[0]) ?? null;
      }
      if (method === "first" && sql.includes("SELECT action, state, run_id FROM commands")) {
        commandReads += 1;
        if (commandReads === 2) releasePrechecks();
        return prechecksReady.then(() => ({ ...command, run_id: null }));
      }
      if (method === "batch") {
        batches += 1;
        const [insert, link] = values;
        assert.match(insert.sql, /FROM commands/);
        assert.match(insert.sql, /state = 'claimed' AND run_id IS NULL/);
        assert.match(link.sql, /state = 'claimed' AND run_id IS NULL/);
        const runId = insert.parameters[0];
        if (command.run_id != null) {
          return values.map(() => ({ meta: { changes: 0 } }));
        }
        runs.set(runId, { run_id: runId, state: "running" });
        command.run_id = runId;
        return values.map(() => ({ meta: { changes: 1 } }));
      }
      assert.fail(`Unexpected D1 statement: ${method} ${sql}`);
    }),
  };
  const start = (runId) => controlApiResponse(
    request("/api/v1/runner/runs", {
      method: "POST",
      body: {
        run_id: runId,
        kind: "manual-sync",
        source: "command",
        command_id: commandId,
      },
      headers: { "Idempotency-Key": `start-${runId}` },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );

  const responses = await Promise.all([start("race-run-a"), start("race-run-b")]);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [202, 409]);
  const loser = responses.find((response) => response.status === 409);
  assert.ok(loser);
  assert.equal((await loser.json()).error.code, "command_not_startable");
  assert.equal(batches, 2);
  assert.equal(runs.size, 1);
  assert.equal(command.run_id, [...runs.keys()][0]);

  const replay = await start(command.run_id);
  assert.equal(replay.status, 200);
  assert.equal(batches, 2);
  assert.equal(runs.size, 1);
});

test("rejects a new run timestamp beyond the allowed future clock skew", async () => {
  let reads = 0;
  const response = await controlApiResponse(
    request("/api/v1/runner/runs", {
      method: "POST",
      body: {
        run_id: "future-run",
        kind: "scheduled",
        source: "systemd",
        started_at: "2999-01-01T00:00:00Z",
      },
      headers: { "Idempotency-Key": "future-run-start" },
    }),
    {
      CONTROL_DB: database((method, sql) => {
        reads += 1;
        assert.equal(method, "first");
        assert.match(sql, /SELECT \* FROM runs/);
        return null;
      }),
    },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_run");
  assert.equal(reads, 1);
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
        board_name: "AA 게시판",
        group_name: "aa",
        last_scanned_at: "2026-07-12T04:00:00Z",
        last_outcome: "partial",
        counters: {
          discovered: 10, changed: 2, pending: 3, running: 1, retry: 1, done: 20, dead: 0,
        },
        inventory_next_page: 37,
        last_inventory_at: null,
        inventory_pass_started_at: "2026-07-12T00:00:00Z",
        warning_code: "parse_drift",
      },
      headers: { "Idempotency-Key": "board-status-0001" },
    }),
    env,
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 200);
  assert.match(sql, /board_status\.last_scanned_at > \?/);
  assert.match(sql, /excluded\.last_scanned_at >= board_status\.last_scanned_at/);
  assert.deepEqual(parameters.slice(0, 5), [
    "aa", "AA 게시판", "aa", "2026-07-12T04:00:00.000Z", "partial",
  ]);
  assert.equal(parameters[8], 1);
  assert.equal(parameters[10], 20);
  assert.equal(parameters[12], 37);
  assert.equal(parameters[14], "2026-07-12T00:00:00.000Z");
  assert.ok(Date.parse(parameters[16]) > Date.now());
  assert.ok(Date.parse(parameters[16]) <= Date.now() + 6 * 60 * 1000);
});

test("rejects a board timestamp beyond the allowed future clock skew before D1", async () => {
  const response = await controlApiResponse(
    request("/api/v1/runner/boards/status", {
      method: "POST",
      body: {
        board_id: "aa",
        last_scanned_at: "2999-01-01T00:00:00Z",
        last_outcome: "succeeded",
        counters: { discovered: 0, changed: 0, pending: 0, retry: 0, dead: 0 },
      },
      headers: { "Idempotency-Key": "future-board-status" },
    }),
    { CONTROL_DB: database(() => assert.fail("D1 must not be called")) },
    { role: "runner", subject: "runner-token" },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_board_status");
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
