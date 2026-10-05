import assert from "node:assert/strict";
import test from "node:test";

import { aaInertiaStep, clampAaZoom, createTapJudge, fitAaZoomValue, isSceneHeader, minimapScroll, minimapWindow, pinchAaZoom, sceneAt, sceneTarget, sceneY, scrollKeepingPoint } from "../public/aa-viewer.js";

test("AA inertia preserves direction and distance across frame rates", () => {
  const whole = aaInertiaStep(1.2, .8, 480);
  for (const dt of [8, 16, 24, 48]) {
    let vx = 1.2;
    let vy = .8;
    let x = 0;
    let y = 0;
    for (let elapsed = 0; elapsed < 480; elapsed += dt) {
      const step = aaInertiaStep(vx, vy, dt);
      x += step.x;
      y += step.y;
      vx = step.vx;
      vy = step.vy;
      assert.ok(Math.abs(vx / vy - 1.5) < 1e-10);
    }
    assert.ok(Math.abs(x - whole.x) < 1e-10);
    assert.ok(Math.abs(y - whole.y) < 1e-10);
  }
});

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

test("scenes start only at the original 레스 header lines", () => {
  for (const line of [
    "2405 ： ◆nXsLRB5hfY ： 2024/11/29(金) 22:44:32 ID:udvPw2Ed",
    "3324 ： 隔壁内の名無しさん ： 2025/01/18(土) 18:49:39.36 ID:sQnTeehH",
    "83 ： 名無しさん＠狐板 ： 2022/08/18(木) 00:36:59 ID:EVfAk+RG",
  ]) assert.equal(isSceneHeader(line), true, line);
  for (const line of [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "    │제24회 동탁은 후궁을 불태우고 원가를 멸망시키다. 계속",
    "2024/11/29 에 올렸다",
    "（　´∀｀）",
    `1 ： ${"가".repeat(300)} ： 2024/11/29`,
  ]) assert.equal(isSceneHeader(line), false, line);
});

test("the current scene and ‹ › targets follow the header positions", () => {
  const tops = [100, 500, 900];
  assert.equal(sceneAt(tops, 0), 0);
  assert.equal(sceneAt(tops, 497), 0);
  assert.equal(sceneAt(tops, 500), 1);
  assert.equal(sceneAt(tops, 2000), 2);
  assert.equal(sceneTarget(tops, 0, 1), 1);
  assert.equal(sceneTarget(tops, 100, 1), 1);
  assert.equal(sceneTarget(tops, 900, 1), -1);
  assert.equal(sceneTarget(tops, 500, -1), 0);
  assert.equal(sceneTarget(tops, 100, -1), -1);
  assert.equal(sceneTarget(tops, 700, -1), 1);
  // At the end of the scroll the last header on screen is the current scene.
  assert.equal(sceneY(tops, { scrollTop: 300, clientHeight: 700, scrollHeight: 2000, offset: 60 }), 360);
  assert.equal(sceneY(tops, { scrollTop: 300, clientHeight: 700, scrollHeight: 1000, offset: 60 }), 900);
});
