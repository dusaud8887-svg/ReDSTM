import assert from "node:assert/strict";
import test from "node:test";

import { prefersDark, themeColor } from "../public/theme.js";
import { planImport } from "../public/user-state.js";

test("the browser bar follows the app outside the Reader and the surface inside it", () => {
  assert.equal(themeColor({ dark: false, readerOpen: false, surface: "ink" }), "#F7F6F3");
  assert.equal(themeColor({ dark: true, readerOpen: false }), "#121413");
  assert.equal(themeColor({ dark: false, readerOpen: true, surface: "paper" }), "#F5EFE3");
  assert.equal(themeColor({ dark: false, readerOpen: true, surface: "ink" }), "#000000");
  assert.equal(themeColor({ dark: true, readerOpen: true, surface: "unknown" }), "#161918");
});

test("system follows the OS; explicit themes do not", () => {
  assert.equal(prefersDark("system", true), true);
  assert.equal(prefersDark("light", true), false);
  assert.equal(prefersDark("dark", false), true);
});

test("the ink surface, brightness and warmth survive a backup and stay in range", () => {
  const ok = planImport(JSON.stringify({ schema_version: 2, settings: { readerSurface: "ink", readerDim: 40, readerWarm: 25 } })).state.settings;
  assert.deepEqual([ok.readerSurface, ok.readerDim, ok.readerWarm], ["ink", 40, 25]);
  const bad = planImport(JSON.stringify({ schema_version: 2, settings: { readerSurface: "neon", readerDim: 90, readerWarm: -1 } }), { readerSurface: "default", readerDim: 0, readerWarm: 0 }).state.settings;
  assert.deepEqual([bad.readerSurface, bad.readerDim, bad.readerWarm], ["default", 0, 0]);
});
