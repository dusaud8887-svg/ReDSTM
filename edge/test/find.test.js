import assert from "node:assert/strict";
import test from "node:test";

import { findMatches, MATCH_LIMIT } from "../public/find.js";

test("hits are found on the search copy and reported in original offsets", () => {
  const text = "알겠어. 그녀는 말했다.\n\"알겠어.\"  다시   알겠어.";
  const hits = findMatches(text, "알겠어");
  assert.equal(hits.length, 3);
  for (const hit of hits) assert.equal(text.slice(hit.start, hit.end), "알겠어");
  // Runs of spaces and a newline collapse to one space in the copy but keep original offsets.
  const spaced = findMatches(text, "다시 알겠어");
  assert.equal(spaced.length, 1);
  assert.equal(text.slice(spaced[0].start, spaced[0].end), "다시   알겠어");
});

test("width and case variants match, and an empty query finds nothing", () => {
  assert.equal(findMatches("ＡＢＣ와 abc", "abc").length, 2);
  assert.deepEqual(findMatches("본문", "   "), []);
});

test("hits are capped", () => {
  assert.equal(findMatches("가".repeat(MATCH_LIMIT + 50), "가").length, MATCH_LIMIT);
});
