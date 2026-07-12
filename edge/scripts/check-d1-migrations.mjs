import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edge = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(edge, "node_modules", "wrangler", "bin", "wrangler.js");
const database = "redstm-control";

function run(args, { json = false } = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: edge,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: json ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler exited with ${result.status}`);
  return json ? JSON.parse(result.stdout) : null;
}

function apply(config, persistence) {
  run([
    "d1", "migrations", "apply", database,
    "--local", "--config", config, "--persist-to", persistence,
  ]);
}

function execute(config, persistence, sql, { json = false } = {}) {
  return run([
    "d1", "execute", database,
    "--local", "--config", config, "--persist-to", persistence,
    "--command", sql,
    ...(json ? ["--json"] : []),
  ], { json });
}

const temporary = mkdtempSync(join(tmpdir(), "redstm-d1-migrations-"));
try {
  const fullPersistence = join(temporary, "full");
  apply(join(edge, "wrangler.jsonc"), fullPersistence);

  const upgrade = join(temporary, "upgrade");
  const migrations = join(upgrade, "migrations");
  const persistence = join(upgrade, "state");
  mkdirSync(migrations, { recursive: true });
  const migrationNames = readdirSync(join(edge, "migrations")).sort();
  for (const name of migrationNames.filter((name) => name <= "0003_operations_telemetry.sql")) {
    cpSync(join(edge, "migrations", name), join(migrations, name));
  }
  const config = join(upgrade, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify({
    name: "redstm-d1-upgrade-fixture",
    compatibility_date: "2026-07-10",
    d1_databases: [{
      binding: "CONTROL_DB",
      database_name: database,
      database_id: "997d0196-c136-410c-b11a-69eff7dc1a75",
      migrations_dir: "./migrations",
    }],
  }));
  apply(config, persistence);
  execute(config, persistence, `
    INSERT INTO runner_status (
      id, schema_version, runner_version, state, heartbeat_at
    ) VALUES (1, 1, 'fixture', 'idle', '2026-07-12T00:00:00.000Z');
    INSERT INTO commands (
      command_id, idempotency_key, action, args_json, requested_by_hash,
      requested_at, expires_at, state
    ) VALUES
      ('00000000-0000-4000-8000-000000000001', 'fixture-process', 'sync-now', '{}',
       'fixture', '2026-07-12T00:00:00.000Z', '2026-07-13T00:00:00.000Z', 'queued'),
      ('00000000-0000-4000-8000-000000000002', 'fixture-marker', 'pause-after-current',
       '{}', 'fixture', '2026-07-12T00:00:00.000Z', '2026-07-13T00:00:00.000Z', 'claimed');
    INSERT INTO runs (
      run_id, kind, source, state, requested_at, started_at
    ) VALUES ('fixture-run', 'scheduled', 'systemd', 'running',
              '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO run_events (
      run_id, sequence, step, state, recorded_at
    ) VALUES ('fixture-run', 0, 'scheduled', 'running', '2026-07-12T00:00:00.000Z');
    INSERT INTO board_status (
      board_id, last_scanned_at, last_outcome, discovered, changed, pending, retry, dead
    ) VALUES ('fixture-board', '2026-07-12T00:00:00.000Z', 'succeeded', 1, 0, 1, 0, 0);
  `);
  for (const name of migrationNames.filter((name) => name >= "0004_retention_indexes.sql")) {
    cpSync(join(edge, "migrations", name), join(migrations, name));
  }
  apply(config, persistence);
  const verification = execute(config, persistence, `
    SELECT
      (SELECT COUNT(*) FROM runner_status) AS runner_count,
      (SELECT COUNT(*) FROM commands) AS command_count,
      (SELECT COUNT(*) FROM runs) AS run_count,
      (SELECT COUNT(*) FROM run_events) AS event_count,
      (SELECT COUNT(*) FROM board_status) AS board_count,
      (SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'index' AND name = 'commands_active_conflict_group_idx') AS integrity_index;
  `, { json: true });
  assert.deepEqual(verification[0].results[0], {
    runner_count: 1,
    command_count: 2,
    run_count: 1,
    event_count: 1,
    board_count: 1,
    integrity_index: 1,
  });
  console.log("D1 empty and 0003 upgrade migration fixtures passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
