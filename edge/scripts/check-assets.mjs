import { readFile } from "node:fs/promises";

const fonts = new URL("../public/fonts/", import.meta.url);
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
  console.log("Font assets and licenses are valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
