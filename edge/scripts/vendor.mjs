// Bundles pinned browser libraries from node_modules into public/vendor/ as single ESM files.
// The Reader has no build step; pages import these files by absolute path.
//   node scripts/vendor.mjs          rebuild every bundle and public/vendor/manifest.json
//   node scripts/vendor.mjs --check  verify bundles match manifest.json and package.json versions
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const vendorRoot = new URL("public/vendor/", root);
const manifestUrl = new URL("manifest.json", vendorRoot);

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
  { name: "modern-screenshot", file: "modern-screenshot.js", source: `export { domToBlob, domToPng } from "modern-screenshot";` },
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

async function writeEntry(dir, relative, bytes, entries, meta) {
  await writeFile(new URL(relative, dir), bytes);
  entries.push({ ...meta, path: `/vendor/${dir.href.slice(vendorRoot.href.length)}${relative}`, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: digest(bytes) });
}

async function rebuild() {
  await rm(vendorRoot, { recursive: true, force: true });
  const entries = [];
  for (const bundle of bundles) {
    const version = pinned(bundle.name);
    const dir = new URL(`${bundle.dir ?? safe(bundle.name)}@${version}/`, vendorRoot);
    await mkdir(dir, { recursive: true });
    const result = await build({
      stdin: { contents: bundle.source, resolveDir: root.pathname.replace(/^\/([A-Za-z]:)/, "$1"), loader: "js" },
      bundle: true, minify: true, format: "esm", target: "es2022", write: false, legalComments: "none",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeEntry(dir, bundle.file, Buffer.from(result.outputFiles[0].contents), entries, { name: bundle.name, version });
    await copyFile(moduleUrl(bundle.licenseFrom ?? bundle.name, "LICENSE"), new URL("LICENSE", dir));
  }
  for (const item of copies) {
    const version = pinned(item.name);
    const dir = new URL(`${safe(item.name)}@${version}/`, vendorRoot);
    await mkdir(dir, { recursive: true });
    for (const file of item.files) {
      const bytes = await readFile(moduleUrl(item.name, file));
      await writeEntry(dir, file.split("/").pop(), bytes, entries, { name: item.name, version });
    }
    await copyFile(moduleUrl(item.name, "LICENSE"), new URL("LICENSE", dir));
  }
  await writeFile(manifestUrl, `${JSON.stringify({ generatedBy: "edge/scripts/vendor.mjs", files: entries }, null, 2)}\n`);
  for (const entry of entries) console.log(`${entry.path}  ${entry.bytes} B, ${entry.gzip} B gzip`);
}

async function check() {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  for (const entry of manifest.files) {
    if (pinned(entry.name) !== entry.version) throw new Error(`${entry.path} was built from ${entry.version}, package.json pins ${pinned(entry.name)}`);
    const bytes = await readFile(new URL(entry.path.slice("/vendor/".length), vendorRoot));
    if (digest(bytes) !== entry.sha256) throw new Error(`${entry.path} does not match its manifest hash`);
    const license = await readFile(new URL(`${entry.path.slice("/vendor/".length).split("/")[0]}/LICENSE`, vendorRoot), "utf8");
    if (!license.trim()) throw new Error(`${entry.path} has no LICENSE next to it`);
  }
  console.log(`Vendor bundles match manifest (${manifest.files.length} files).`);
}

try {
  await (process.argv.includes("--check") ? check() : rebuild());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
