// Bundles pinned browser libraries from node_modules into public/vendor/ as single ESM files.
// The Reader has no build step; pages import these files by absolute path.
//   node scripts/vendor.mjs          rebuild every bundle and public/vendor/manifest.json
//   node scripts/vendor.mjs --check  rebuild in memory and require the committed files, manifest,
//                                    LICENSEs, and file set to match exactly (no stale or extra files)
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
  { name: "diff", file: "diff.js", source: `export { diffChars, diffWordsWithSpace, diffLines } from "diff";` },
  { name: "web-vitals", file: "web-vitals.js", source: `export { onLCP, onINP, onCLS, onFCP, onTTFB } from "web-vitals";` },
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
    files: ["dist/photoswipe-lightbox.esm.min.js", "dist/photoswipe.esm.min.js", "dist/photoswipe.css"],
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
}

try {
  await (process.argv.includes("--check") ? check() : rebuild());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
