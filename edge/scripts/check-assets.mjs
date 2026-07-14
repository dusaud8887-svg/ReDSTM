import { readFile } from "node:fs/promises";

const publicRoot = new URL("../public/", import.meta.url);
const fonts = new URL("fonts/", publicRoot);
const assets = [
  ["SUIT-Variable.woff2", "SUIT-LICENSE.txt", true],
  ["MaruBuri-Regular.woff2", "MaruBuri-LICENSE.txt", true],
  ["Saitamaar-Regular.ttf", "Saitamaar-LICENSE.txt", false],
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
  console.log("Font, manifest, and icon assets are valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
