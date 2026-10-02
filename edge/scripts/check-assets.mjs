import { readdir, readFile } from "node:fs/promises";

const publicRoot = new URL("../public/", import.meta.url);
const fonts = new URL("fonts/", publicRoot);
// SUIT stays for /ops; the old single MaruBuri and Saitamaar files live only in font-sources.
const assets = [
  ["SUIT-Variable.woff2", "SUIT-LICENSE.txt", true],
];
// Versioned web font directories built by scripts/build-fonts.py: every url() in the family CSS
// must be a real WOFF2 inside the same directory, and every WOFF2 there must be referenced.
const splitFamilies = [
  ["pretendard@1.3.9/", "pretendard.css"],
  ["maruburi@1.000/", "maruburi.css"],
  ["gowun-batang@5.3.0/", "gowun-batang.css"],
  ["saitamaar@1.0/", "saitamaar.css"],
];

try {
  for (const [fontName, licenseName, isWoff2] of assets) {
    const [font, license] = await Promise.all([
      readFile(new URL(fontName, fonts)),
      readFile(new URL(licenseName, fonts), "utf8"),
    ]);
    if (font.length === 0) throw new Error(`${fontName} is empty`);
    if (license.trim().length === 0) throw new Error(`${licenseName} is empty`);
    if (isWoff2 && font.subarray(0, 4).toString("ascii") !== "wOF2") {
      throw new Error(`${fontName} is not WOFF2`);
    }
  }
  for (const [dir, cssName] of splitFamilies) {
    const base = new URL(dir, fonts);
    const [css, license] = await Promise.all([
      readFile(new URL(cssName, base), "utf8"),
      readFile(new URL("LICENSE.txt", base), "utf8"),
    ]);
    if (license.trim().length === 0) throw new Error(`${dir}LICENSE.txt is empty`);
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/["']/g, ""));
    if (urls.length === 0) throw new Error(`${dir}${cssName} declares no fonts`);
    for (const url of urls) {
      if (!url.startsWith(`/fonts/${dir}`)) throw new Error(`${url} points outside ${dir}`);
      const font = await readFile(new URL(url.slice(1), publicRoot));
      if (font.subarray(0, 4).toString("ascii") !== "wOF2") throw new Error(`${url} is not WOFF2`);
    }
    const files = (await readdir(base)).filter((name) => name.endsWith(".woff2"));
    const referenced = new Set(urls.map((url) => url.split("/").pop()));
    const orphan = files.find((name) => !referenced.has(name));
    if (orphan) throw new Error(`${dir}${orphan} is not referenced by ${cssName}`);
  }
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", publicRoot), "utf8"));
  if (manifest.name !== "ReDSTM 개인 장서" || manifest.start_url !== "/" || manifest.display !== "standalone") {
    throw new Error("Web app manifest has invalid install metadata");
  }
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${size}x${size}` && item.type === "image/png");
    if (!icon) throw new Error(`Manifest is missing its ${size}px PNG icon`);
    const png = await readFile(new URL(icon.src.slice(1), publicRoot));
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      throw new Error(`${icon.src} is not a ${size}x${size} PNG`);
    }
  }
  console.log("Font, split font, manifest, and icon assets are valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
