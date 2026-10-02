import assert from "node:assert/strict";
import test from "node:test";
import { kwicMatches, kwicScope, runKwic } from "../public/kwic-core.js";

test("T17: scope is a visited set, filtered before counts and fetches", () => {
  const entries = Array.from({ length: 200 }, (_, index) => ({ documentId: String(index + 1) }));
  const scoped = kwicScope(entries, { read: ["1", "2", "3", "4", "5", "200"], current: "200" });
  assert.deepEqual(scoped.map((entry) => entry.documentId), ["1", "2", "3", "4", "5", "200"]);
  assert.equal(kwicScope(entries, { all: true }).length, 200);
  assert.deepEqual(kwicScope(entries, { opened: ["199"] }).map((entry) => entry.documentId), ["199"]);
});

test("KWIC keeps original UTF-16 locators across normalization", () => {
  const [match] = kwicMatches("앞 🙂 ＡＢＣ 뒤", "abc", "revision");
  assert.equal(match.exact, "ＡＢＣ");
  assert.equal(match.locator.start, 5);
  assert.equal(match.locator.exact, "ＡＢＣ");
});

test("KWIC fetches at most four at once and separates failure from no matches", async () => {
  let running = 0;
  let peak = 0;
  const results = [];
  await runKwic(Array.from({ length: 9 }, (_, i) => ({ documentId: String(i) })), {
    query: "찾음", signal: new AbortController().signal,
    async load(entry) {
      running += 1; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      if (entry.documentId === "3") throw new Error("missing");
      return entry.documentId === "4" ? "없음" : "찾음";
    },
    onResult: (result) => results.push(result),
  });
  assert.equal(peak, 4);
  assert.equal(results.at(-1).failed, 1);
  assert.equal(results.at(-1).checked, 9);
  assert.equal(results.reduce((sum, result) => sum + result.matches.length, 0), 7);
});

test("cancelled KWIC never emits late results or starts later requests", async () => {
  const controller = new AbortController();
  let loaded = 0;
  await runKwic(Array.from({ length: 20 }, (_, i) => ({ documentId: String(i) })), {
    query: "문장", signal: controller.signal,
    async load() { loaded += 1; await Promise.resolve(); controller.abort(); return "문장"; },
    onResult() { assert.fail("late result"); },
  });
  assert.equal(loaded, 4);
});
