import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const options = { specs: [], milestone: false };
const help = `Usage (from edge):
  node scripts/redesign-checklist.mjs --ticket P1-5 --base HEAD~1 --head HEAD --spec viewer.spec.js --spec reader-flow.spec.js
  node scripts/redesign-checklist.mjs --ticket M1 --base <milestone-start> --head HEAD --milestone

Reads committed Git revisions only. Prints commands; executes no tests and writes no files.
Use actual ticket boundaries; HEAD~1 is valid only for a one-commit ticket.
--spec is repeatable. Spec names must be relative to edge/e2e.
app.js changes conservatively request the full suite; inspect whether routing changed.
File counts include generated assets: classify them manually against the five-file rule.`;

try {
  if (args.includes("--help")) {
    console.log(help);
  } else {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--milestone") {
        options.milestone = true;
        continue;
      }
      if (!["--ticket", "--base", "--head", "--spec"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`Missing value: ${arg}`);
      index += 1;
      if (arg === "--spec") {
        if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.spec\.js$/.test(value)) throw new Error(`Invalid spec name: ${value}`);
        options.specs.push(value);
      } else {
        options[arg.slice(2)] = value;
      }
    }
    if (!options.ticket || !options.base || !options.head || (!options.milestone && !options.specs.length)) {
      throw new Error(help);
    }
    const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const base = git("rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`);
    const head = git("rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`);
    const files = git("diff", "--name-only", "-z", base, head, "--").split("\0").filter(Boolean);
    for (const spec of options.specs) git("cat-file", "-e", `${head}:edge/e2e/${spec}`);
    const checks = JSON.parse(git("show", `${head}:edge/package.json`)).scripts?.check?.split(/\s*&&\s*/) ?? [];
    const unchecked = files.filter((path) => /^edge\/(?:public|test|e2e)\/.*\.js$/.test(path)
      && !path.startsWith("edge/public/vendor/")
      && !checks.includes(`node --check ${path.slice(5)}`)
      && (() => { try { git("cat-file", "-e", `${head}:${path}`); return true; } catch { return false; } })());
    const reasons = files.filter((path) => /^edge\/public\/(?:reader-session|store|user-state|overlay-manager|app|sw|offline)\.js$/.test(path));
    if (/^P1-(?:1(?:[ab])?|2)$/.test(options.ticket)) reasons.push("P1-1/P1-2: CSS split or tokens");
    console.log(`Ticket: ${options.ticket}\nRevisions: ${base.slice(0, 12)} -> ${head.slice(0, 12)}`);
    console.log(`Changed paths (${files.length}; manually count hand-edited files):\n${files.map((path) => `  ${path}`).join("\n") || "  (none)"}`);
    if (files.length > 5 && !options.milestone) console.log("Review: more than five paths; exclude only generated/copied binary assets, or split the ticket.");
    if (!files.length) console.log("Review: empty revision diff cannot establish ticket verification scope.");
    if (unchecked.length) console.log(`Review check registration (committed package.json):\n${unchecked.map((path) => `  ${path}`).join("\n")}`);
    console.log("\nRun sequentially from edge (these commands have NOT been executed):\nnpm test\nnpm run check\nnpm run lint");
    if (options.specs.length) {
      console.log(`npm run test:e2e -- ${[...new Set(options.specs)].join(" ")} --project=desktop --project=mobile --workers=2`);
    }
    if (options.milestone || reasons.length) {
      console.log(`\nFull suite required${options.milestone ? " at milestone end" : ` or conservatively flagged: ${reasons.join(", ")}`}:`);
      console.log('PowerShell: $env:VISUAL = "1" (Linux CI already sets VISUAL=1; Windows differences are judged by CI)');
      console.log("npm run test:e2e -- --workers=2");
    }
    console.log("\nFailed rerun: keep the SAME spec/project filters and add --last-failed; preserve traces.");
    console.log("Verify the ticket's T acceptance cases in docs/24 §14.3; this tool does not infer coverage or report a pass.");
    if (options.milestone) {
      console.log("Milestone: all projects + axe + visual; Linux CI decides visual differences. Record §19, merge/push main, confirm exact main commit CI success. Carry device checks to §14.5.");
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
