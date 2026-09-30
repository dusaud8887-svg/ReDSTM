// Find in the chapter (docs/24 §8.11, DESIGN §7.8). Matching runs on the text model's search copy
// and maps back to original offsets, so nothing is inserted into the body: hits are painted with
// the Custom Highlight API (redstm-find, redstm-find-current). Without it the bar still counts and
// moves. The position before the first move is kept so the reader can go back.

import { createTextModel, modelRange, searchCopy, sourceRange } from "./text-model.js";

export const MATCH_LIMIT = 1000;

// Pure: [{ start, end }] in original text offsets for every hit of query, in document order.
export function findMatches(text, query, copy = searchCopy(text)) {
  const wanted = searchCopy(String(query ?? "")).text.trim();
  if (!wanted) return [];
  const matches = [];
  for (let at = copy.text.indexOf(wanted); at >= 0 && matches.length < MATCH_LIMIT; at = copy.text.indexOf(wanted, at + wanted.length)) {
    const range = sourceRange(copy, at, at + wanted.length);
    if (range) matches.push(range);
  }
  return matches;
}

export function createFind({ bar, input, count, band, root, scroller, topInset = () => 0, session, overlays, onChange = () => {} }) {
  const highlights = globalThis.CSS?.highlights && globalThis.Highlight ? globalThis.CSS.highlights : null;
  let model = null;
  let copy = null;
  let generation = -1;
  let ranges = [];
  let current = -1;
  let returnAnchor = null;
  let moved = false;
  let timer = null;

  function ensureModel() {
    if (model && generation === session.generation && model.root === root()) return;
    model = createTextModel(root());
    copy = searchCopy(model.text);
    generation = session.generation;
  }

  function paint() {
    if (!highlights) return;
    highlights.set("redstm-find", new Highlight(...ranges));
    if (ranges[current]) highlights.set("redstm-find-current", new Highlight(ranges[current]));
    else highlights.delete("redstm-find-current");
  }

  function clearPaint() {
    highlights?.delete("redstm-find");
    highlights?.delete("redstm-find-current");
  }

  function drawBand() {
    const height = scroller.scrollHeight || 1;
    const offset = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const ticks = ranges.slice(0, 200).map((range, index) => {
      const tick = document.createElement("i");
      tick.style.left = `${Math.min(100, Math.max(0, ((range.getBoundingClientRect().top - offset) / height) * 100))}%`;
      if (index === current) tick.className = "current";
      return tick;
    });
    band.replaceChildren(...ticks);
  }

  function status() {
    const text = input.value.trim();
    count.textContent = !text ? "" : ranges.length ? `${current + 1}/${ranges.length}${ranges.length >= MATCH_LIMIT ? "+" : ""}` : "0/0";
    bar.dataset.empty = String(Boolean(text) && !ranges.length);
    onChange({ count: ranges.length, current });
  }

  // The first hit at or below the top of the screen, found by bisection over document order.
  function firstVisible() {
    const top = scroller.getBoundingClientRect().top + topInset();
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges[middle].getBoundingClientRect().bottom > top) high = middle;
      else low = middle + 1;
    }
    return ranges.length ? Math.min(low, ranges.length - 1) : -1;
  }

  function reveal() {
    const range = ranges[current];
    if (!range) return;
    if (!moved) {
      // Saving pauses while the keyboard is open, so the place is read from the adapter directly.
      returnAnchor = session.capturePosition();
      moved = true;
    }
    session.markUserScroll();
    const box = scroller.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    scroller.scrollTop += rect.top - box.top - scroller.clientHeight / 3;
    if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft += rect.left - box.left - scroller.clientWidth / 2;
  }

  function search() {
    ensureModel();
    ranges = findMatches(model.text, input.value, copy).map((match) => modelRange(model, match.start, match.end)).filter(Boolean);
    current = firstVisible();
    paint();
    drawBand();
    status();
  }

  // The first move shows the hit already selected (the first one on screen); later moves step.
  function step(delta) {
    if (!ranges.length) return;
    if (moved || delta < 0) current = (current + delta + ranges.length) % ranges.length;
    reveal();
    paint();
    drawBand();
    status();
  }

  function hide() {
    clearTimeout(timer);
    clearPaint();
    bar.hidden = true;
    document.body.classList.remove("find-open");
    if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = false;
    const anchor = moved ? returnAnchor : null;
    ranges = [];
    current = -1;
    moved = false;
    returnAnchor = null;
    return anchor;
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      clearTimeout(timer);
      if (!ranges.length || generation !== session.generation) search();
      step(event.shiftKey ? -1 : 1);
    }
  });

  return {
    // Call inside the opening gesture: the bar's CloseWatcher must belong to it.
    open(onClosed) {
      if (!bar.hidden) {
        input.focus();
        input.select();
        return;
      }
      bar.hidden = false;
      document.body.classList.add("find-open");
      // Chrome Android: keep the bar on top of the keyboard without resizing the page.
      if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true;
      overlays.openBar(bar.id, () => onClosed(hide()));
      input.focus();
      if (input.value.trim()) search();
    },
    close() { overlays.closeLayer(bar.id); },
    next: () => step(1),
    previous: () => step(-1),
    get isOpen() { return !bar.hidden; },
  };
}
