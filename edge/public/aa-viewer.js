// AA viewer (docs/24 §8.16, DESIGN §8.4). The zoom range, its precision and the fit formula are
// the pre-redesign values moved here unchanged; the pinch only changes how a gesture reaches them.

// setAaZoom: 10–300%, rounded to the third decimal place. Never snapped to 25% steps.
export function clampAaZoom(value) {
  return Math.round(Math.max(0.1, Math.min(3, value)) * 1000) / 1000;
}

// fitAaZoom: the zoom at which the widest line fits the stage; it only shrinks.
export function fitAaZoomValue(current, available, content) {
  return Math.min(1, Math.floor(current * (available / content) * 100) / 100);
}

// A pinch ends at the zoom it started from times the fingers' scale, as a continuous value.
export function pinchAaZoom(start, scale) {
  return clampAaZoom(start * scale);
}

// After a zoom from `from` to `to`, the scroll that keeps the content under a point (relative to
// the stage's top-left corner) at the same place on screen.
export function scrollKeepingPoint({ scrollLeft, scrollTop, x, y, from, to }) {
  const ratio = to / from;
  return { left: Math.max(0, (scrollLeft + x) * ratio - x), top: Math.max(0, (scrollTop + y) * ratio - y) };
}

// One tap acts at once; a second tap within `delay` undoes it and becomes a double tap, so a
// single tap never waits to find out.
export function createTapJudge({ onTap, onDoubleTap, delay = 300 }) {
  let last = -Infinity;
  return (time) => {
    if (time - last <= delay) {
      last = -Infinity;
      onTap();
      onDoubleTap();
      return "double";
    }
    last = time;
    onTap();
    return "single";
  };
}

// Minimap (DESIGN §8.4): the visible part of a wide picture as a share of its whole width.
export function minimapWindow({ scrollLeft, clientWidth, scrollWidth }) {
  if (!(scrollWidth > clientWidth + 1)) return null;
  const width = clientWidth / scrollWidth;
  return { left: Math.min(1 - width, Math.max(0, scrollLeft / scrollWidth)), width };
}

// A point on the minimap (0–1 across it) becomes the scroll that centres the view there.
export function minimapScroll(ratio, { clientWidth, scrollWidth }) {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.round(Math.min(max, Math.max(0, ratio * scrollWidth - clientWidth / 2)));
}

// Scene moves (DESIGN §8.4) follow only a clear block boundary of the original: the header line of
// each 레스, `2405 ： ◆nXsLRB5hfY ： 2024/11/29(金) 22:44:32 ID:udvPw2Ed` (298 of 300 sampled AA posts).
const RES_HEADER = /^\s*\d{1,5}\s*[：:].{0,80}?[：:]\s*\d{4}\/\d{1,2}\/\d{1,2}.{0,60}$/u;
export function isSceneHeader(line) {
  const text = line.trim();
  return text.length <= 200 && RES_HEADER.test(text);
}

// Rounded scroll offsets and sub-pixel line tops count as the same place within this many px.
const SCENE_SLACK = 2;

// The position scenes are judged at: the line under the toolbar, or at the end of the scroll the
// last header on screen (a short last scene can never reach the toolbar).
export function sceneY(tops, { scrollTop, clientHeight, scrollHeight, offset }) {
  const y = scrollTop + offset;
  if (scrollTop + clientHeight < scrollHeight - SCENE_SLACK) return y;
  const visible = tops.filter((top) => top < scrollTop + clientHeight);
  return visible.length ? Math.max(y, visible.at(-1)) : y;
}

// The scene shown at scroll offset `y`: the last header at or above it (the first before any).
export function sceneAt(tops, y) {
  let low = 0;
  let high = tops.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (tops[middle] <= y + SCENE_SLACK) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

// The header a ‹ or › moves to from `y`, or -1 at either end. Text before the first header belongs
// to scene 1; ‹ inside a scene first returns to its own header.
export function sceneTarget(tops, y, direction) {
  const current = sceneAt(tops, y);
  if (direction > 0) return current + 1 < tops.length ? current + 1 : -1;
  return tops[current] < y - SCENE_SLACK ? current : current - 1;
}


// The same time-based decay on both axes preserves a fling's angle at any frame rate.
export function aaInertiaStep(vx, vy, milliseconds) {
  const decay = Math.exp(-milliseconds / 240);
  return { x: vx * 240 * (1 - decay), y: vy * 240 * (1 - decay), vx: vx * decay, vy: vy * decay };
}

// Native touch scrolling can lock a gesture to its first axis even in a two-axis scroller.
// Keep single-finger AA pans as one vector; two fingers remain the existing pinch gesture.
export function createAaPan(element, { enabled, scrollers, onMove = () => {} }) {
  let drag = null;
  let frame = 0;
  function cancel() {
    drag = null;
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function moveBy(targets, dx, dy) {
    const { horizontal, vertical } = targets;
    const x = horizontal.scrollLeft;
    const y = vertical.scrollTop;
    const left = Math.max(0, Math.min(horizontal.scrollWidth - horizontal.clientWidth, x + dx));
    const top = Math.max(0, Math.min(vertical.scrollHeight - vertical.clientHeight, y + dy));
    horizontal.scrollLeft = left;
    vertical.scrollTop = top;
    return { x: horizontal.scrollLeft - x, y: vertical.scrollTop - y, hitX: left !== x + dx, hitY: top !== y + dy };
  }
  element.addEventListener("touchstart", (event) => {
    cancel();
    if (!enabled() || event.touches.length !== 1) return;
    const touch = event.touches[0];
    drag = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp,
      startX: touch.clientX, startY: touch.clientY, vx: 0, vy: 0, moving: false, targets: scrollers() };
  }, { passive: true });
  element.addEventListener("touchmove", (event) => {
    if (!drag) return;
    if (!enabled() || event.touches.length !== 1 || String(getSelection() ?? "")) return cancel();
    const touch = Array.from(event.touches).find((point) => point.identifier === drag.id);
    if (!touch) return cancel();
    if (!drag.moving && Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) < 5) return;
    drag.moving = true;
    event.preventDefault();
    const dt = Math.max(1, event.timeStamp - drag.time);
    const moved = moveBy(drag.targets, drag.x - touch.clientX, drag.y - touch.clientY);
    const blend = 1 - Math.exp(-dt / 45);
    drag.vx += (moved.x / dt - drag.vx) * blend;
    drag.vy += (moved.y / dt - drag.vy) * blend;
    if (moved.hitX) drag.vx = 0;
    if (moved.hitY) drag.vy = 0;
    drag.x = touch.clientX;
    drag.y = touch.clientY;
    drag.time = event.timeStamp;
    onMove();
  }, { passive: false });
  element.addEventListener("touchend", (event) => {
    const released = drag;
    drag = null;
    if (!released?.moving || event.touches.length || event.timeStamp - released.time > 80 ||
        matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const speed = Math.hypot(released.vx, released.vy);
    const scale = Math.min(1, 4 / Math.max(speed, .001));
    let vx = released.vx * scale;
    let vy = released.vy * scale;
    let previous = performance.now();
    const tick = (now) => {
      frame = 0;
      if (!enabled() || !element.isConnected) return;
      const step = aaInertiaStep(vx, vy, now - previous);
      previous = now;
      const moved = moveBy(released.targets, step.x, step.y);
      vx = moved.hitX ? 0 : step.vx;
      vy = moved.hitY ? 0 : step.vy;
      onMove();
      if (Math.hypot(vx, vy) > .02) frame = requestAnimationFrame(tick);
    };
    if (speed > .02) frame = requestAnimationFrame(tick);
  }, { passive: true });
  element.addEventListener("touchcancel", cancel, { passive: true });
  element.addEventListener("wheel", cancel, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  return { cancel };
}
