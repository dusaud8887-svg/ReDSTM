import assert from "node:assert/strict";
import test from "node:test";
import { createLocator, createTextModel, modelOffset, modelPosition, resolveLocator, sanitizeLocator, searchCopy, sourceRange } from "../public/text-model.js";

const text = (data) => ({ nodeType: 3, data });
const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes, matches: () => ["BUTTON", "FIGCAPTION"].includes(tagName) });
const revision = "a".repeat(64);

test("extracts block boundaries, ruby bases and UTF-16 coordinates without reader UI", () => {
  const emoji = text("😀가");
  const ruby = text("漢字");
  const model = createTextModel(element("DIV", element("P", emoji), element("P", element("RUBY", ruby, element("RT", text("かんじ"))), element("BR"), text("끝")), element("BUTTON", text("재시도")), element("FIGCAPTION", text("안내"))));
  assert.equal(model.text, "😀가\n漢字\n끝\n");
  assert.equal(modelOffset(model, ruby, 1), 6);
  assert.deepEqual(modelPosition(model, 5), { node: ruby, offset: 0 });
  assert.deepEqual(modelPosition(model, 4), { node: ruby, offset: 0 });
  assert.equal(modelPosition(model, -1), null);
});

test("maps normalization expansion, Hangul composition and collapsed spaces back to source", () => {
  const raw = "Ａ  가\n\tﬃ😀";
  const copy = searchCopy(raw);
  assert.equal(copy.text, "a 가 ffi😀");
  assert.deepEqual(sourceRange(copy, 2, 3), { start: 3, end: 5 });
  assert.deepEqual(sourceRange(copy, 4, 7), { start: 7, end: 8 });
  assert.deepEqual(sourceRange(copy, 7, 9), { start: 8, end: 10 });
  assert.equal(sourceRange(copy, 0, 100), null);
  assert.equal(searchCopy("ΟΣ İ").text, "ος i̇");
});

test("resolves a repeated sentence by context, preserves ambiguity and never chooses first silently", () => {
  const old = { text: "앞 문장. 반복. 뒤 문장. 다른 문장. 반복. 마지막." };
  const start = old.text.lastIndexOf("반복.");
  const loc = createLocator(old, start, start + 3, revision);
  assert.equal(resolveLocator(old, loc, revision).status, "exact");
  const changed = { text: `새 문장. ${old.text}` };
  assert.deepEqual(resolveLocator(changed, loc, "b".repeat(64)), { status: "candidate", start: changed.text.lastIndexOf("반복."), end: changed.text.lastIndexOf("반복.") + 3 });
  const ambiguous = { v: 2, tm: 1, rev: revision, start: 2, end: 3, exact: "x", prefix: "", suffix: "" };
  assert.deepEqual(resolveLocator({ text: "x---x" }, ambiguous, "b".repeat(64)), { status: "unresolved" });
  assert.deepEqual(resolveLocator({ text: "삭제됨" }, loc), { status: "unresolved" });
  assert.equal(sanitizeLocator({ ...loc, end: -1 }), null);
  assert.equal(sanitizeLocator({ ...loc, rev: "invalid" }), null);
});

test("a locator travels in a link and comes back the same sentence", async () => {
  const { decodeLocator, encodeLocator } = await import("../public/text-model.js");
  const loc = { v: 2, tm: 1, rev: "a".repeat(64), start: 100, end: 160, exact: "가".repeat(60), prefix: "앞".repeat(32), suffix: "뒤".repeat(32) };
  const code = encodeLocator(loc);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeLocator(code), { v: 2, tm: 1, rev: "a".repeat(64), start: 100, end: 132, exact: "가".repeat(32), prefix: "앞".repeat(12), suffix: "뒤".repeat(12) });
  assert.equal(decodeLocator("not-json"), null);
  assert.equal(encodeLocator({ v: 1 }), "");
});
