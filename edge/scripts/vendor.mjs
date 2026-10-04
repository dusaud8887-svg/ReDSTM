// Bundles pinned browser libraries from node_modules into public/vendor/ as single ESM files.
// The Reader has no build step; pages import these files by absolute path.
//   node scripts/vendor.mjs          rebuild every bundle and public/vendor/manifest.json, and write
//                                    public/precache-manifest.js (the service worker's app shell) and
//                                    public/sw.js (sw/sw.js bundled into one classic script)
//   node scripts/vendor.mjs --precache  only rewrite public/precache-manifest.js and public/sw.js
//                                    (after app edits)
//   node scripts/vendor.mjs --check  rebuild in memory and require the committed files, manifest,
//                                    LICENSEs, file set and precache list to match exactly
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const vendorRoot = new URL("public/vendor/", root);

// name: npm package, file: output basename, source: re-export entry, license: package whose LICENSE ships.
const bundles = [
  {
    name: "es-hangul", file: "es-hangul.js",
    source: `export { getChoseong, disassemble, assemble, josa, convertQwertyToHangul, canBeChoseong, hasBatchim } from "es-hangul";`,
  },
  { name: "@leeoniya/ufuzzy", file: "ufuzzy.js", source: `export { default } from "@leeoniya/ufuzzy";` },
  { name: "idb", file: "idb.js", source: `export { openDB, deleteDB } from "idb";` },
  {
    name: "@floating-ui/dom", file: "floating-ui.js",
    source: `export { computePosition, autoUpdate, offset, flip, shift, size, inline, hide, arrow } from "@floating-ui/dom";`,
  },
  {
    name: "@use-gesture/vanilla", file: "use-gesture.js",
    source: `export { Gesture, PinchGesture, DragGesture } from "@use-gesture/vanilla";`,
  },
  { name: "uqr", file: "uqr.js", source: `export { renderSVG } from "uqr";` },
  {
    name: "workbox-routing", dir: "workbox", file: "workbox.js", licenseFrom: "workbox-core",
    source: [
      `export { registerRoute, setCatchHandler, NavigationRoute } from "workbox-routing";`,
      `export { CacheFirst, NetworkFirst, StaleWhileRevalidate, NetworkOnly } from "workbox-strategies";`,
      `export { ExpirationPlugin } from "workbox-expiration";`,
      `export { CacheableResponsePlugin } from "workbox-cacheable-response";`,
      `export { RangeRequestsPlugin } from "workbox-range-requests";`,
      `export { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";`,
    ].join("\n"),
  },
];

// Packages that already ship browser ESM; copied as-is.
const copies = [
  {
    name: "photoswipe",
    // core only: gallery.js drives PhotoSwipe itself (the overlay manager owns Esc/focus/Back).
    files: ["dist/photoswipe.esm.min.js", "dist/photoswipe.css"],
  },
];

const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const pinned = (name) => {
  const version = packageJson.devDependencies?.[name];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${name} must be pinned to an exact version in package.json`);
  return version;
};
const moduleUrl = (name, path = "") => new URL(`node_modules/${name}/${path}`, root);
const safe = (name) => name.replace(/^@/, "").replace("/", "-");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Produces every vendor file in memory: [{ path (relative to public/vendor/), bytes, meta }].
async function produce() {
  const outputs = [];
  const resolveDir = root.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const bundle of bundles) {
    const version = pinned(bundle.name);
    const dir = `${bundle.dir ?? safe(bundle.name)}@${version}/`;
    const result = await build({
      stdin: { contents: bundle.source, resolveDir, loader: "js" },
      bundle: true, minify: true, format: "esm", target: "es2022", write: false, legalComments: "none",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    outputs.push({ path: `${dir}${bundle.file}`, bytes: Buffer.from(result.outputFiles[0].contents), meta: { name: bundle.name, version } });
    outputs.push({ path: `${dir}LICENSE`, bytes: await readFile(moduleUrl(bundle.licenseFrom ?? bundle.name, "LICENSE")) });
  }
  for (const item of copies) {
    const version = pinned(item.name);
    const dir = `${safe(item.name)}@${version}/`;
    for (const file of item.files) {
      outputs.push({ path: `${dir}${file.split("/").pop()}`, bytes: await readFile(moduleUrl(item.name, file)), meta: { name: item.name, version } });
    }
    outputs.push({ path: `${dir}LICENSE`, bytes: await readFile(moduleUrl(item.name, "LICENSE")) });
  }
  const entries = outputs.filter((o) => o.meta).map((o) => ({
    ...o.meta, path: `/vendor/${o.path}`, bytes: o.bytes.length, gzip: gzipSync(o.bytes, { level: 9 }).length, sha256: digest(o.bytes),
  }));
  const manifest = Buffer.from(`${JSON.stringify({ generatedBy: "edge/scripts/vendor.mjs", files: entries }, null, 2)}\n`);
  outputs.push({ path: "manifest.json", bytes: manifest });
  return { outputs, entries };
}

// The service worker's precache (docs/24 §12.6.1 row 13): the app shell — the page, its styles
// and modules, font CSS, icons and manifest — plus the two core font files. Other vendor bundles
// and font pieces are cached when first used. A revision is the first 16 hex of the SHA-256 of
// the file with line endings normalised, so a Windows checkout and Linux CI agree.
const publicRoot = new URL("public/", root);
const PRECACHE_FONTS = ["fonts/pretendard@1.3.9/core.woff2", "fonts/maruburi@1.000/700.core.woff2"];
const NOT_SHELL = new Set(["ops.js", "sw.js", "precache-manifest.js"]);

async function precacheList() {
  const top = (await readdir(publicRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const files = [
    ...top.filter((name) => name.endsWith(".js") && !NOT_SHELL.has(name)),
    "manifest.webmanifest",
    ...(await readdir(new URL("styles/", publicRoot))).filter((name) => name.endsWith(".css")).map((name) => `styles/${name}`),
    ...(await readdir(new URL("icons/", publicRoot))).map((name) => `icons/${name}`),
  ];
  for (const dir of await readdir(new URL("fonts/", publicRoot), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(new URL(`fonts/${dir.name}/`, publicRoot))) if (name.endsWith(".css")) files.push(`fonts/${dir.name}/${name}`);
  }
  files.push(...PRECACHE_FONTS);
  const text = /\.(?:js|css|html|webmanifest|svg)$/;
  const revision = async (path) => {
    const bytes = await readFile(new URL(path, publicRoot));
    return digest(text.test(path) ? Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")) : bytes).slice(0, 16);
  };
  const entries = [{ url: "/", revision: await revision("index.html") }];
  for (const path of files.sort()) entries.push({ url: `/${path}`, revision: await revision(path) });
  return `// Generated by edge/scripts/vendor.mjs; run npm run precache after changing the app shell.\nexport default ${JSON.stringify(entries, null, 2)};\n`;
}

// The service worker ships as one classic script. Chrome fetches a module service worker and its
// imports without cookies, so behind Cloudflare Access they are redirected to the sign-in page and
// registration fails; a classic script is fetched with the same-origin cookies. sw/sw.js keeps
// its absolute imports, resolved here to public/ files (the precache list freshly generated).
async function swBundle() {
  const files = new URL("sw/", root);
  const result = await build({
    entryPoints: ["sw.js"], bundle: true, write: false, format: "iife", target: "es2022", legalComments: "none",
    plugins: [{
      name: "public-paths",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => (args.kind === "entry-point" ? { path: "sw.js", namespace: "sw" }
          : { path: args.path.replace(/^\//, ""), namespace: "public" }));
        b.onLoad({ filter: /.*/, namespace: "sw" }, async () => ({ contents: (await readFile(new URL("sw.js", files), "utf8")).replaceAll("\r\n", "\n"), loader: "js" }));
        b.onLoad({ filter: /.*/, namespace: "public" }, async (args) => ({
          contents: args.path === "precache-manifest.js" ? await precacheList() : (await readFile(new URL(args.path, publicRoot), "utf8")).replaceAll("\r\n", "\n"),
          loader: "js",
        }));
      },
    }],
  });
  return `// Generated by edge/scripts/vendor.mjs from sw/sw.js; run npm run precache after editing it.\n${result.outputFiles[0].text}`;
}

async function writeShell() {
  await writeFile(new URL("precache-manifest.js", publicRoot), await precacheList());
  await writeFile(new URL("sw.js", publicRoot), await swBundle());
  console.log("public/precache-manifest.js and public/sw.js written");
}

async function listFiles(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await listFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found;
}

// Builds into a sibling temp directory and swaps it in only after every file is written.
async function rebuild() {
  const { outputs, entries } = await produce();
  const staging = new URL("public/vendor.tmp/", root);
  await rm(staging, { recursive: true, force: true });
  for (const output of outputs) {
    const target = new URL(output.path, staging);
    await mkdir(new URL("./", target), { recursive: true });
    await writeFile(target, output.bytes);
  }
  await rm(vendorRoot, { recursive: true, force: true });
  await rename(staging, vendorRoot);
  for (const entry of entries) console.log(`${entry.path}  ${entry.bytes} B, ${entry.gzip} B gzip`);
  await writeShell();
}

async function check() {
  const { outputs } = await produce();
  const expected = new Map(outputs.map((o) => [o.path, o.bytes]));
  const actual = await listFiles(vendorRoot);
  const extra = actual.filter((path) => !expected.has(path));
  if (extra.length) throw new Error(`Unexpected files in public/vendor: ${extra.join(", ")}`);
  for (const [path, bytes] of expected) {
    let committed;
    try {
      committed = await readFile(new URL(path, vendorRoot));
    } catch {
      throw new Error(`public/vendor/${path} is missing; run npm run vendor`);
    }
    if (!committed.equals(bytes)) throw new Error(`public/vendor/${path} differs from a fresh build; run npm run vendor`);
  }
  console.log(`Vendor bundles match a fresh build (${expected.size} files).`);
  let committed = "";
  try {
    committed = (await readFile(new URL("precache-manifest.js", publicRoot), "utf8")).replaceAll("\r\n", "\n");
  } catch { /* reported below */ }
  if (committed !== await precacheList()) throw new Error("public/precache-manifest.js is out of date; run npm run precache");
  let worker = "";
  try {
    worker = (await readFile(new URL("sw.js", publicRoot), "utf8")).replaceAll("\r\n", "\n");
  } catch { /* reported below */ }
  if (worker !== await swBundle()) throw new Error("public/sw.js differs from a fresh bundle of sw/sw.js; run npm run precache");
  console.log("Precache list and service worker bundle match the app shell.");
}

try {
  if (process.argv.includes("--precache")) await writeShell();
  else await (process.argv.includes("--check") ? check() : rebuild());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
