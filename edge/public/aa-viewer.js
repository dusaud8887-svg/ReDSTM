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
