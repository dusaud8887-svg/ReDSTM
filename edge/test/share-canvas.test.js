import assert from "node:assert/strict";
import test from "node:test";

import { AA_MAX_WIDTH, aaSceneSize, cardPalette, wrapText } from "../public/share-canvas.js";

// Every character is 10px wide.
const measure = (text) => [...text].length * 10;

test("quote lines break at word boundaries and keep paragraphs", () => {
  const { lines, truncated } = wrapText("하나 둘 셋 넷\n다섯", measure, 50, 9);
  assert.deepEqual(lines, ["하나 둘", "셋 넷", "다섯"]);
  assert.equal(truncated, false);
});

test("a word wider than the line is broken by characters", () => {
  assert.deepEqual(wrapText("가나다라마바사아", measure, 30, 9).lines, ["가나다", "라마바", "사아"]);
});

test("past nine lines the card ends with an ellipsis and says it continues", () => {
  const text = Array.from({ length: 12 }, (_, index) => `줄${index}`).join("\n");
  const { lines, truncated } = wrapText(text, measure, 60, 9);
  assert.equal(lines.length, 9);
  assert.equal(lines.at(-1), "줄8…");
  assert.equal(truncated, true);
});

test("card tones use the work colour, a light page or a dark page", () => {
  assert.equal(cardPalette(0, "work").background, "#D9ECFF");
  assert.equal(cardPalette(0, "work").band, "#316CA5");
  assert.equal(cardPalette(0, "light").background, "#FBFAF7");
  assert.equal(cardPalette(0, "dark").background, "#161514");
  assert.equal(cardPalette(42, "work").background, "#E9E9E9");
});

test("an AA scene keeps the AA line height and shrinks past 4,096px", () => {
  const narrow = aaSceneSize([[{ text: "（´∀｀）" }]], measure, 16);
  assert.equal(narrow.fontSize, 16);
  assert.equal(narrow.lineHeight, 18);
  const wide = aaSceneSize([[{ text: "＿".repeat(1000) }]], measure, 16);
  assert.ok(wide.width <= AA_MAX_WIDTH);
  assert.ok(wide.fontSize < 16);
  assert.equal(wide.lineHeight, wide.fontSize * 1.125);
});
