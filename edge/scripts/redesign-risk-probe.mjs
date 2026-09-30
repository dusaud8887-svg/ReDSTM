// Independent diagnostics on a committed snapshot. No servers, app writes or Git mutations.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const help = "From edge: node scripts/redesign-risk-probe.mjs --ref <completed-commit> [--browser] [--bench]\nPrints observations, not an acceptance pass. Optional browser uses its own temporary profile; no E2E server/results.";

try {
  if (args.includes("--help")) {
    console.log(help);
  } else {
    let ref;
    let browserProbe = false;
    let bench = false;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--ref") {
        ref = args[index + 1];
        if (!ref || ref.startsWith("-")) throw new Error("Missing --ref value");
        index += 1;
      } else if (args[index] === "--browser") browserProbe = true;
      else if (args[index] === "--bench") bench = true;
      else throw new Error(`Unknown option: ${args[index]}`);
    }
    if (!ref) throw new Error(help);
    const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    const source = (path) => git("show", `${commit}:${path}`);
    const modules = new Map();
    // These pure modules use relative static imports. Resolve every dependency from the
    // SAME Git commit rather than importing files the implementation agent may be editing.
    function moduleUrl(path) {
      if (!path.startsWith("edge/public/")) throw new Error(`Unsupported module: ${path}`);
      if (modules.has(path)) return modules.get(path);
      const code = source(path).replace(/from\s*(["'])(\.\.?\/[^"']+)\1/g, (_match, _quote, relative) => {
        const dependency = posix.normalize(posix.join(posix.dirname(path), relative));
        return `from "${moduleUrl(dependency)}"`;
      });
      const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
      modules.set(path, url);
      return url;
    }
    const results = [];
    let hasBarcode = false;
    try { git("cat-file", "-e", `${commit}:edge/public/barcode.js`); hasBarcode = true; } catch { /* not implemented in older snapshots */ }
    if (hasBarcode) {
      const { barcodeModel } = await import(moduleUrl("edge/public/barcode.js"));
      const short = barcodeModel([
        { position: 1, state: "unread", weight: 1 },
        { position: 2, state: "unread", weight: 99 },
      ], 300, { mode: "length" });
      results.push({ probe: "length-mode-small-work", weights: [1, 99], binWidths: short.bins.map((bin) => bin.w) });
    }
    const user = await import(moduleUrl("edge/public/user-state.js"));
    const newer = "2026-09-30T00:30:00Z";
    const older = "2026-09-30T09:00:00+09:00";
    const typeState = (readAt, offset) => ({ ...user.defaultUserState(), history: { "board_a:1": { readAt, offset } } });
    const textKey = "novel:novel:toki:1:1";
    const textState = (readAt, offset) => ({ schema_version: 1, history: { [textKey]: { readAt, offset } }, bookmarks: {} });
    const typeMerged = user.mergeUserStates(typeState(newer, 30), typeState(older, 10));
    const textMerged = user.mergeTextStates(textState(newer, 30), textState(older, 10));
    results.push({ probe: "timestamp-merge", expectedOffset: 30,
      typemoonOffset: typeMerged.history["board_a:1"]?.offset, textOffset: textMerged.history[textKey]?.offset,
      chronologicalNewer: Date.parse(newer) > Date.parse(older) });

    if (bench) {
      const search = await import(moduleUrl("edge/public/search-core.js"));
      const rows = Array.from({ length: 50_000 }, (_, index) => ["board_a", index + 1, `제목 ${index}`, "작가", "분류", "2026-09-30", "a".repeat(64)]);
      const index = search.prepareSearch({ schema_version: 1, fields: search.SEARCH_FIELDS, posts: rows });
      const queries = ["제목", "일치없음", "49999"];
      const times = queries.map((query) => {
        const start = performance.now();
        const result = search.searchPosts(index, { query, target: "title", limit: 20 });
        return { query, elapsedMs: Math.round((performance.now() - start) * 100) / 100, matches: result.total };
      });
      results.push({ probe: "metadata-search", syntheticRows: rows.length, environment: "Node; not a phone performance gate", times });
    }

    if (browserProbe) {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const index = source("edge/src/index.js");
        const policyArray = index.match(/const contentSecurityPolicy = \[([\s\S]*?)\]\.join/);
        if (!policyArray) throw new Error("CSP source shape changed; update this diagnostic before using it");
        const policy = [...policyArray[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1]).join("; ");
        await page.setContent('<canvas id="preview" width="1080" height="1350"></canvas>');
        const csp = await page.evaluate(async (policy) => {
          const meta = document.createElement("meta");
          meta.httpEquiv = "Content-Security-Policy";
          meta.content = policy;
          document.head.append(meta);
          const canvas = document.querySelector("canvas");
          canvas.getContext("2d").fillRect(0, 0, 20, 20);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const url = URL.createObjectURL(blob);
          let directive = null;
          document.addEventListener("securitypolicyviolation", (event) => { directive = event.effectiveDirective; }, { once: true });
          const image = new Image();
          const loaded = await new Promise((resolve) => {
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = url;
          });
          URL.revokeObjectURL(url);
          return { probe: "share-blob-preview-csp", loaded, directive,
            canvasRendered: canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3] === 255 };
        }, policy);
        results.push(csp);
        // A separate document is needed: the first page keeps its real CSP.
        const miniPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await miniPage.setContent('<div id="home-card" style="position:absolute;top:2000px;width:20px;height:20px"></div><div id="list" style="height:20px;overflow:auto"><div style="height:200px"></div></div><button id="mini"><span class="mini-bar-dot"></span><span data-mini-title></span><span data-mini-detail></span></button>');
        await miniPage.addStyleTag({ content: source("edge/public/styles/shell.css") });
        const folded = await miniPage.evaluate(async (url) => {
          const { createMiniBar } = await import(url);
          const element = document.querySelector("#mini");
          element.className = "mini-bar";
          createMiniBar({ element, homeCard: document.querySelector("#home-card") }).render({ title: "테스트 작품", progress: 0.2, open() {} });
          const list = document.querySelector("#list");
          list.scrollTop = 50;
          list.dispatchEvent(new Event("scroll"));
          // Wait through the CSS transition before measuring invisibility.
          await new Promise((resolve) => setTimeout(resolve, 400));
          element.focus();
          const style = getComputedStyle(element);
          return { probe: "folded-mini-focus", folded: element.classList.contains("folded"),
            opacity: style.opacity, pointerEvents: style.pointerEvents, focused: document.activeElement === element,
            tabIndex: element.tabIndex, inert: element.inert, hidden: element.hidden };
        }, moduleUrl("edge/public/shell.js"));
        results.push(folded);
        if (hasBarcode) {
          const barcodePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          await barcodePage.setContent('<style>.barcode-track{width:100%;height:44px}</style><div id="host" style="width:1200px"></div>');
          const resized = await barcodePage.evaluate(async (url) => {
            const { createBarcode } = await import(url);
            const host = document.querySelector("#host");
            const view = createBarcode({ host, onSelect() {} });
            view.update(Array.from({ length: 10_000 }, (_, index) => ({ position: index + 1, state: "unread" })));
            const track = host.querySelector(".barcode-track");
            track.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
            const before = { max: Number(track.getAttribute("aria-valuemax")), now: Number(track.getAttribute("aria-valuenow")) };
            host.style.width = "300px";
            await new Promise((resolve) => setTimeout(resolve, 150));
            const after = { max: Number(track.getAttribute("aria-valuemax")), now: Number(track.getAttribute("aria-valuenow")) };
            track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            const stripOpened = !host.querySelector(".barcode-strip").hidden;
            view.destroy();
            return { probe: "barcode-resize-active-bin", before, after, stripOpened };
          }, moduleUrl("edge/public/barcode.js"));
          results.push(resized);
        }
      } finally {
        await browser.close();
      }
    }
    console.log(JSON.stringify({ commit, diagnosticOnly: true, results }, null, 2));
  }
} catch (error) {
  console.error(error.message.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "(snapshot module)"));
  process.exitCode = 1;
}
