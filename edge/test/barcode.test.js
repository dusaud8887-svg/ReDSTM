import assert from "node:assert/strict";
import test from "node:test";

import { barcodeModel, barcodeSummary, binLabel } from "../public/barcode.js";

const episodes = (count, state = () => "unread") => Array.from({ length: count }, (_, index) => ({ position: index + 1, state: state(index) }));

test("bins stay about 3px wide and cover every episode once, in order", () => {
  const entries = episodes(340);
  const { bins } = barcodeModel(entries, 384);
  assert.equal(bins.length, 128);
  assert.equal(bins[0].from, 0);
  assert.equal(bins.at(-1).to, 340);
  for (let index = 1; index < bins.length; index += 1) assert.equal(bins[index].from, bins[index - 1].to);
  assert.ok(bins.every((bin) => bin.to > bin.from));
  // Fewer episodes than bins: one bin per episode.
  assert.equal(barcodeModel(episodes(12), 384).bins.length, 12);
  assert.deepEqual(barcodeModel([], 384).bins, []);
});

test("a bin shows its most important state: reading, then missing, then unread, then read", () => {
  const entries = episodes(8, (index) => ["read", "read", "unread", "read", "missing", "read", "reading", "unread"][index]);
  entries[3].fresh = true;
  const { bins } = barcodeModel(entries, 8, { target: 2 });
  assert.deepEqual(bins.map((bin) => bin.state), ["read", "unread", "missing", "reading"]);
  assert.deepEqual(bins.map((bin) => bin.fresh), [false, true, false, false]);
  assert.equal(binLabel(entries, bins[3]), "7화–8화 · 읽는 중");
  assert.equal(binLabel(entries, bins[1]), "3화–4화 · 안 읽음 포함 · 새 화");
});

test("분량 보기 sizes bins by length and still keeps one episode per bin", () => {
  const entries = episodes(6).map((entry, index) => ({ ...entry, weight: index === 0 ? 1000 : 10 }));
  const { bins } = barcodeModel(entries, 12, { mode: "length" });
  assert.equal(bins.length, 4);
  assert.deepEqual(bins.map((bin) => [bin.from, bin.to]), [[0, 1], [1, 2], [2, 3], [3, 6]]);
});

test("the summary names read, missing and new episodes", () => {
  const entries = episodes(340, (index) => (index < 118 ? "read" : index < 123 ? "missing" : "unread"));
  entries[339].fresh = true;
  entries[338].fresh = true;
  entries[337].fresh = true;
  assert.equal(barcodeSummary(entries), "340화 중 118화 읽음 · 5화 보존 안 됨 · 새 3화");
});

test("T27: a 10,000-episode model is built within a frame", () => {
  const entries = episodes(10_000, (index) => (index < 4000 ? "read" : index === 4000 ? "reading" : "unread"));
  const started = performance.now();
  const { bins } = barcodeModel(entries, 1200);
  const elapsed = performance.now() - started;
  assert.equal(bins.length, 400);
  assert.ok(elapsed < 16, `${elapsed}ms`);
  assert.equal(bins.filter((bin) => bin.state === "reading").length, 1);
});

test("분량 보기 widths follow length even when each bin holds one episode", () => {
  const entries = episodes(2).map((entry, index) => ({ ...entry, weight: index ? 99 : 1 }));
  const { bins } = barcodeModel(entries, 300, { mode: "length" });
  assert.equal(bins.length, 2);
  assert.equal(bins[0].w, 3);
  assert.equal(bins[1].x, 3);
  assert.equal(bins[1].w, 297);
  const order = barcodeModel(entries, 300);
  assert.deepEqual(order.bins.map((bin) => bin.w), [150, 150]);
});
