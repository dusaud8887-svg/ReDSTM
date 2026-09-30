// Continue-reading mini bar (DESIGN §7.3, docs/24 §8.1). It sits on the phone tab bar on every
// screen outside the Reader, hides while Home's own continue card is on screen, folds away while
// a list scrolls down and returns when it scrolls back up. CSS hides it in the Reader, with the
// keyboard open, and on wide screens.

const FOLD_DISTANCE = 10;

export function createMiniBar({ element, homeCard }) {
  const title = element.querySelector("[data-mini-title]");
  const detail = element.querySelector("[data-mini-detail]");
  let model = null;
  let cardVisible = false;
  const lastTops = new WeakMap();

  function update() {
    const show = Boolean(model) && !cardVisible;
    element.hidden = !show;
    document.body.classList.toggle("mini-bar-on", show);
    if (!show) element.classList.remove("folded");
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
    const last = lastTops.get(scroller) ?? 0;
    if (Math.abs(top - last) < FOLD_DISTANCE) return;
    lastTops.set(scroller, top);
    element.classList.toggle("folded", top > last);
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
        element.style.setProperty("--mini-progress", `${Math.round(Math.min(1, Math.max(0, model.progress || 0)) * 100)}%`);
        element.setAttribute("aria-label", `이어 읽기: ${[model.title, model.detail].filter(Boolean).join(" · ")}`);
      }
      update();
    },
  };
}
