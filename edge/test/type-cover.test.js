import assert from "node:assert/strict";
import test from "node:test";

import { coverInitial, fnv1a, HUE_COUNT, workHue, workKey } from "../public/type-cover.js";

test("FNV-1a matches the reference values", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
});

test("a work keeps one hue from its stable key, and a chosen hue wins", () => {
  const key = workKey({ source: "typemoon", id: 42 });
  assert.equal(key, "typemoon:collection:42");
  assert.equal(workHue(key), workHue("typemoon:collection:42"));
  assert.ok(workHue(key) >= 0 && workHue(key) < HUE_COUNT);
  assert.equal(workHue(key, 7), 7);
  assert.equal(workHue(key, 12), workHue(key));
  assert.equal(workKey({ source: "arcalive", board: "novel", id: "long" }), "arcalive:novel:long");
  assert.equal(workKey({ source: "novel", id: "novel:toki:1" }), "novel:novel:toki:1");
  const spread = new Set(Array.from({ length: 200 }, (_, index) => workHue(`novel:work:${index}`)));
  assert.equal(spread.size, HUE_COUNT);
});

test("the small cover letter skips bracketed tags and keeps whole graphemes", () => {
  assert.equal(coverInitial("달그림자 서고의 마술사"), "달");
  assert.equal(coverInitial("[AA] 성배전쟁 뒷이야기"), "성");
  assert.equal(coverInitial("【단편】 겨울 역"), "겨");
  assert.equal(coverInitial("(완) Fate/stay night"), "F");
  assert.equal(coverInitial("…그리고 아무도"), "그");
  assert.equal(coverInitial("fate"), "F");
  assert.equal(coverInitial("👨‍👩‍👧 가족"), "👨‍👩‍👧");
  assert.equal(coverInitial("[AA]"), "[");
  assert.equal(coverInitial(""), "?");
});
