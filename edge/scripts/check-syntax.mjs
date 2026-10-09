// `node --check` every module this package ships, runs or tests. The hand-kept list in
// package.json had already missed new files (2026-10-09 review); third-party vendor bundles and
// installed packages are skipped, everything else under these folders is found by walking them.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "public", "sw", "scripts", "test", "e2e", "backup"];
const SKIP = new Set(["node_modules", "vendor", "fonts", ".wrangler"]);

function* modules(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) yield* modules(join(directory, entry.name));
    } else if (/\.m?js$/.test(entry.name)) {
      yield join(directory, entry.name);
    }
  }
}

const files = [...ROOTS.flatMap((root) => [...modules(root)]), "playwright.config.js"];
const failed = files.filter((file) => spawnSync(process.execPath, ["--check", file], { stdio: "inherit" }).status !== 0);
if (failed.length) {
  console.error(`node --check failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`node --check: ${files.length} files`);
