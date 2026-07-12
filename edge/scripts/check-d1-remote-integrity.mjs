import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edge = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(edge, "node_modules", "wrangler", "bin", "wrangler.js");

function count(sql, field) {
  const result = spawnSync(process.execPath, [
    wrangler,
    "d1", "execute", "redstm-control", "--remote", "--command", sql, "--json",
  ], {
    cwd: edge,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler exited with ${result.status}`);
  const value = JSON.parse(result.stdout)?.[0]?.results?.[0]?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("D1 integrity query returned an invalid count");
  }
  return value;
}

const commandTables = count(
  "SELECT COUNT(*) AS table_count FROM sqlite_schema " +
    "WHERE type = 'table' AND name = 'commands'",
  "table_count",
);
if (commandTables === 0) {
  console.log(JSON.stringify({ ok: true, status: "fresh_database" }));
} else {
  const conflicts = count(`
    SELECT COUNT(*) AS conflict_count FROM (
      SELECT CASE
        WHEN action IN ('pause-after-current', 'resume-schedule') THEN 'schedule-marker'
        ELSE 'process'
      END AS conflict_group, COUNT(*) AS active_count
      FROM commands WHERE state IN ('queued', 'claimed')
      GROUP BY conflict_group HAVING active_count > 1
    )
  `, "conflict_count");
  if (conflicts) {
    console.error(JSON.stringify({
      ok: false,
      status: "blocked",
      safe_code: "d1_active_command_conflict",
      conflict_groups: conflicts,
    }));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ ok: true, status: "compatible" }));
  }
}
