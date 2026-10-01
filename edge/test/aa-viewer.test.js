import assert from "node:assert/strict";
import test from "node:test";

import { clampAaZoom, createTapJudge, fitAaZoomValue, minimapScroll, minimapWindow, pinchAaZoom, scrollKeepingPoint } from "../public/aa-viewer.js";

test("AA zoom keeps its 10–300% range and three decimals", () => {
  assert.equal(clampAaZoom(0.01), 0.1);
  assert.equal(clampAaZoom(9), 3);
  assert.equal(clampAaZoom(0.87349), 0.873);
  assert.equal(clampAaZoom(1.0005), 1.001);
});

test("a pinch ends at a continuous zoom, never a 25% step (T30)", () => {
  assert.equal(pinchAaZoom(1, 0.873), 0.873);
  assert.equal(pinchAaZoom(0.5, 1.37), 0.685);
  assert.equal(pinchAaZoom(2.5, 2), 3);
  assert.equal(pinchAaZoom(0.2, 0.1), 0.1);
});

test("맞춤 only shrinks and floors to whole percent", () => {
  assert.equal(fitAaZoomValue(1, 360, 900), 0.4);
  assert.equal(fitAaZoomValue(1.5, 1000, 300), 1);
  assert.equal(fitAaZoomValue(1, 359, 400), 0.89);
});

test("zooming keeps the point between the fingers in place", () => {
  assert.deepEqual(scrollKeepingPoint({ scrollLeft: 100, scrollTop: 0, x: 50, y: 20, from: 1, to: 2 }), { left: 250, top: 20 });
  assert.deepEqual(scrollKeepingPoint({ scrollLeft: 0, scrollTop: 0, x: 50, y: 20, from: 2, to: 1 }), { left: 0, top: 0 });
});

test("a tap acts at once and a quick second tap undoes it into a double tap (T31)", () => {
  const calls = [];
  const judge = createTapJudge({ onTap: () => calls.push("tap"), onDoubleTap: () => calls.push("double") });
  assert.equal(judge(0), "single");
  assert.deepEqual(calls, ["tap"]);
  assert.equal(judge(250), "double");
  assert.deepEqual(calls, ["tap", "tap", "double"]);
  assert.equal(judge(400), "single");
  assert.equal(judge(800), "single");
});

test("the minimap shows the visible part of a wide picture and moves it", () => {
  assert.equal(minimapWindow({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }), null);
  assert.deepEqual(minimapWindow({ scrollLeft: 400, clientWidth: 400, scrollWidth: 1600 }), { left: 0.25, width: 0.25 });
  assert.deepEqual(minimapWindow({ scrollLeft: 1300, clientWidth: 400, scrollWidth: 1600 }), { left: 0.75, width: 0.25 });
  assert.equal(minimapScroll(0.5, { clientWidth: 400, scrollWidth: 1600 }), 600);
  assert.equal(minimapScroll(0, { clientWidth: 400, scrollWidth: 1600 }), 0);
  assert.equal(minimapScroll(1, { clientWidth: 400, scrollWidth: 1600 }), 1200);
});
