// Full local E2E on the 16 GB Windows workstation (docs/24 §18.2). One `playwright test` run per
// project, so the wrangler/workerd server and the Chrome workers start fresh for each project instead
// of growing across all ~800 tests (the 2026-10-02 run ran out of memory: workers failed to start
// with 0xC0000142). Extra arguments go to every run, e.g. `--last-failed`.
// CI keeps the single `npm run test:e2e` run.
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const port = Number(process.env.REDSTM_E2E_PORT || 8791);
const projects = ["desktop", "medium", "mobile", "compact", ...(process.env.VISUAL === "1" ? ["visual"] : [])];
// Each run empties its output directory, so every project gets its own (traces stay for review).
const outputArg = process.argv.slice(2).find((arg) => arg.startsWith("--output="));
const outputBase = outputArg ? outputArg.slice("--output=".length) : "test-results";
const extra = process.argv.slice(2).filter((arg) => arg !== outputArg);

// playwright.config.js reuses a server already on the port; after an interrupted run that is an
// orphaned workerd still holding its memory. Stop rather than reuse it.
const busy = await new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
if (busy) {
  console.error(`Port ${port} is in use (an orphaned wrangler/workerd from an interrupted run?). Stop it, then run again.`);
  process.exit(2);
}

const failed = [];
for (const project of projects) {
  console.log(`\n=== ${project} ===`);
  const result = spawnSync("npx", ["playwright", "test", `--project=${project}`, "--workers=2", `--output=${outputBase}/${project}`, ...extra], { stdio: "inherit", shell: true });
  if (result.status !== 0) failed.push(project);
}
console.log(failed.length ? `\nFailed projects: ${failed.join(", ")}` : "\nAll projects passed.");
process.exit(failed.length ? 1 : 0);
