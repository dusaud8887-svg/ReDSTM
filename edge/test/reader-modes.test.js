import assert from "node:assert/strict";
import test from "node:test";

import { pageAt, pageCount, pageGeometry, swipeTarget } from "../public/reader-modes.js";

test("a page is the text width and one move shows exactly the next column", () => {
  const phone = pageGeometry({ paneWidth: 384, paneHeight: 844, margin: 20, maxWidth: 760, top: 56, bottom: 80 });
  assert.deepEqual(phone, { width: 344, gap: 40, step: 384, height: 708, left: 20 });
  const wide = pageGeometry({ paneWidth: 1100, paneHeight: 900, margin: 20, maxWidth: 720 });
  assert.equal(wide.width, 720);
  assert.equal(wide.step, 1100);
  assert.equal(wide.left, 190);
});

test("page count and page lookup never make an empty last page", () => {
  const geometry = { width: 344, gap: 40, step: 384 };
  // Ten columns: the last one ends at 10 × 384 − 40.
  assert.equal(pageCount(10 * 384 - 40, geometry), 10);
  assert.equal(pageCount(344, geometry), 1);
  assert.equal(pageCount(0, geometry), 1);
  assert.equal(pageAt(0, geometry, 10), 0);
  assert.equal(pageAt(383, geometry, 10), 1);
  assert.equal(pageAt(9 * 384 + 10, geometry, 10), 9);
  assert.equal(pageAt(99_999, geometry, 10), 9);
});

test("a swipe turns the page past a fifth of its width or on a quick flick", () => {
  assert.equal(swipeTarget(3, 10, -60, 400, 344), 3);
  assert.equal(swipeTarget(3, 10, -80, 400, 344), 4);
  assert.equal(swipeTarget(3, 10, 30, 50, 344), 2);
  assert.equal(swipeTarget(0, 10, 200, 100, 344), 0);
  assert.equal(swipeTarget(9, 10, -200, 100, 344), 9);
});
