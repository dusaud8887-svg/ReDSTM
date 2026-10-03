// Continue-reading mini bar (DESIGN §7.3, docs/24 §8.1). It sits on the phone tab bar on every
// screen outside the Reader, hides while Home's own continue card is on screen, folds away while
// a list scrolls down and returns when it scrolls back up. CSS hides it in the Reader, with the
// keyboard open, and on wide screens.

const FOLD_DISTANCE = 10;
// Scroll positions set by code (the list header folding below) rather than by a finger; the
// direction trackers skip them so a fold does not read as a scroll the other way.
const quietTops = new WeakMap();

function quietScroll(scroller) {
  if (quietTops.get(scroller) !== scroller.scrollTop) return false;
  quietTops.delete(scroller);
  return true;
}

export function createMiniBar({ element, homeCard }) {
  const title = element.querySelector("[data-mini-title]");
  const detail = element.querySelector("[data-mini-detail]");
  let model = null;
  let cardVisible = false;
  const lastTops = new WeakMap();

  // A folded bar is out of sight, so it also leaves the tab order and the accessibility tree.
  function fold(folded) {
    element.classList.toggle("folded", folded);
    element.inert = folded;
    // The list gives the folded bar's row back (shell.css) instead of ending in an empty band.
    document.body.classList.toggle("mini-bar-folded", folded);
  }

  function update() {
    const show = Boolean(model) && !cardVisible;
    element.hidden = !show;
    document.body.classList.toggle("mini-bar-on", show);
    if (!show) fold(false);
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      cardVisible = entry.isIntersecting;
      update();
    }).observe(homeCard);
  }

  // Any list or page scroller outside the Reader folds the bar by direction.
  document.addEventListener("scroll", (event) => {
    const scroller = event.target;
    if (!(scroller instanceof Element) || element.hidden || document.body.classList.contains("reader-active")) return;
    const top = scroller.scrollTop;
    if (quietScroll(scroller)) {
      lastTops.set(scroller, top);
      return;
    }
    const last = lastTops.get(scroller) ?? 0;
    if (Math.abs(top - last) < FOLD_DISTANCE) return;
    lastTops.set(scroller, top);
    fold(top > last);
  }, { capture: true, passive: true });

  element.addEventListener("click", () => model?.open());

  return {
    // model: { title, detail, progress (0–1), open() } or null when there is nothing to continue.
    render(next) {
      model = next;
      if (model) {
        title.textContent = model.title;
        detail.textContent = model.detail ?? "";
        detail.hidden = !model.detail;
        element.querySelector(".mini-bar-dot").className = `mini-bar-dot hue-${model.hue ?? 9}`;
        element.style.setProperty("--mini-progress", `${Math.round(Math.min(1, Math.max(0, model.progress || 0)) * 100)}%`);
        element.setAttribute("aria-label", `이어 읽기: ${[model.title, model.detail].filter(Boolean).join(" · ")}`);
      }
      update();
    },
  };
}

// Phone list header (2026-10-03): the source switch, tabs, board picker and chips fold away while
// the list scrolls down and come back on any scroll up ("quick return", as Chrome's address bar).
// The list keeps what is under the finger in place: its scroll position moves by exactly the
// height the header gave up or took back. Only a person's scrolling folds it: lists restored to
// a saved position (Back, reload) keep their header.
const GESTURE_WINDOW = 1000;

export function createHeaderFold({ catalog, list, active }) {
  let lastTop = 0;
  let gestureAt = -Infinity;
  for (const type of ["touchstart", "touchmove", "wheel", "keydown"]) {
    list.addEventListener(type, () => { gestureAt = performance.now(); }, { passive: true });
  }

  function set(folded) {
    if (catalog.classList.contains("head-folded") === folded) return;
    const before = list.getBoundingClientRect().top;
    catalog.classList.toggle("head-folded", folded);
    const shift = before - list.getBoundingClientRect().top;
    if (!shift) return;
    list.scrollTop = Math.max(0, list.scrollTop - shift);
    lastTop = list.scrollTop;
    quietTops.set(list, list.scrollTop);
  }

  list.addEventListener("scroll", () => {
    const top = list.scrollTop;
    if (quietScroll(list)) {
      lastTop = top;
      return;
    }
    if (!active()) {
      set(false);
      lastTop = top;
      return;
    }
    // Momentum keeps scrolling after the finger lifts; a fling stays within the window.
    if (performance.now() - gestureAt > GESTURE_WINDOW) {
      lastTop = top;
      return;
    }
    if (Math.abs(top - lastTop) < FOLD_DISTANCE) return;
    set(top > lastTop && top > 48);
    lastTop = list.scrollTop;
  }, { passive: true });

  return { reset: () => set(false) };
}
