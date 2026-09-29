import assert from "node:assert/strict";
import test from "node:test";

import { adjacentInSequence, episodeNumber, labelGap } from "../public/sequence.js";

const episodes = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, label: `${index + 1}화`, available: true }));
const available = (entry) => entry.available;

test("moves by canonical position and stops at both ends", () => {
  assert.deepEqual(adjacentInSequence(episodes, 199, 1, available), { kind: "ready", target: episodes[200], skipped: [] });
  assert.equal(adjacentInSequence(episodes, 199, -1, available).target.id, 199);
  assert.deepEqual(adjacentInSequence(episodes, 0, -1, available), { kind: "end", target: null, skipped: [] });
  assert.deepEqual(adjacentInSequence(episodes, 299, 1, available), { kind: "end", target: null, skipped: [] });
});

test("never falls back to another entry when the current one is missing", () => {
  for (const index of [-1, 300, 1.5, null]) {
    assert.deepEqual(adjacentInSequence(episodes, index, 1, available), { kind: "not-in-sequence", target: null, skipped: [] });
  }
  assert.throws(() => adjacentInSequence(episodes, 1, 2), RangeError);
});

test("reports skipped unavailable entries instead of silently jumping", () => {
  const withGap = episodes.slice(0, 5).map((entry) => ({ ...entry, available: entry.id !== 3 && entry.id !== 4 }));
  const result = adjacentInSequence(withGap, 1, 1, available);
  assert.equal(result.kind, "gap");
  assert.equal(result.target.id, 5);
  assert.deepEqual(result.skipped.map((entry) => entry.id), [3, 4]);
  const tail = withGap.slice(0, 4);
  assert.deepEqual(adjacentInSequence(tail, 1, 1, available).kind, "unavailable-tail");
});

test("reads episode numbers from Korean and Japanese chapter labels", () => {
  assert.equal(episodeNumber("2회차 환관이 남성을 되찾음-31화"), 31);
  assert.equal(episodeNumber("제 12 話"), 12);
  assert.equal(episodeNumber("프롤로그"), null);
  assert.equal(labelGap("31화", "34화"), 2);
  assert.equal(labelGap("31화", "32화"), 0);
  assert.equal(labelGap("외전", "32화"), 0);
  assert.equal(labelGap("50화", "1화"), 0);
});
