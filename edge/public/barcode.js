// Episode barcode (DESIGN §7.4, docs/24 §8.6). The whole run of a long work on one line: episodes
// in order (or by length when asked), grouped into bins about 3px wide. The bar is one scrub area
// — never a button per episode — and a released scrub opens a magnified strip to pick one.

const STATE_RANK = { reading: 3, missing: 2, unread: 1, read: 0 };
export const BIN_TARGET = 3;

// entries: [{ position, label?, state: "read"|"reading"|"unread"|"missing", fresh?, weight? }]
export function barcodeModel(entries, width, { mode = "order", target = BIN_TARGET } = {}) {
  const count = entries.length;
  if (!count || !(width > 0)) return { bins: [], width: Math.max(0, width || 0) };
  const binCount = Math.max(1, Math.min(count, Math.floor(width / target)));
  const edges = new Array(binCount + 1);
  if (mode === "length") {
    // Each bin ends where the running length passes its share; every bin keeps one episode.
    const ends = [];
    let total = 0;
    for (const entry of entries) {
      total += Math.max(1, Number(entry.weight) || 1);
      ends.push(total);
    }
    edges[0] = 0;
    let index = 0;
    for (let bin = 1; bin < binCount; bin += 1) {
      const goal = (total * bin) / binCount;
      while (index < count && ends[index] <= goal) index += 1;
      edges[bin] = Math.min(Math.max(index, edges[bin - 1] + 1), count - (binCount - bin));
    }
    edges[binCount] = count;
  } else {
    for (let bin = 0; bin <= binCount; bin += 1) edges[bin] = Math.floor((bin * count) / binCount);
  }
  const bins = [];
  for (let bin = 0; bin < binCount; bin += 1) {
    const from = edges[bin];
    const to = edges[bin + 1];
    let state = "read";
    let fresh = false;
    for (let index = from; index < to; index += 1) {
      const entry = entries[index];
      if (STATE_RANK[entry.state] > STATE_RANK[state]) state = entry.state;
      fresh ||= Boolean(entry.fresh);
    }
    bins.push({ from, to, state, fresh, x: (width * bin) / binCount, w: width / binCount });
  }
  return { bins, width };
}

export function barcodeSummary(entries) {
  let read = 0;
  let missing = 0;
  let fresh = 0;
  for (const entry of entries) {
    if (entry.state === "read") read += 1;
    if (entry.state === "missing") missing += 1;
    if (entry.fresh) fresh += 1;
  }
  return [
    `${entries.length.toLocaleString("ko-KR")}화 중 ${read.toLocaleString("ko-KR")}화 읽음`,
    missing ? `${missing.toLocaleString("ko-KR")}화 보존 안 됨` : "",
    fresh ? `새 ${fresh.toLocaleString("ko-KR")}화` : "",
  ].filter(Boolean).join(" · ");
}

const STATE_LABEL = { read: "모두 읽음", reading: "읽는 중", unread: "안 읽음 포함", missing: "보존 누락 포함" };
export function binLabel(entries, bin) {
  const first = entries[bin.from];
  const last = entries[bin.to - 1];
  const name = (entry) => entry.label ?? `${entry.position}화`;
  const range = bin.to - bin.from > 1 ? `${name(first)}–${name(last)}` : name(first);
  return `${range} · ${STATE_LABEL[bin.state]}${bin.fresh ? " · 새 화" : ""}`;
}

const SVG = "http://www.w3.org/2000/svg";
function drawBins(svg, model, height) {
  const nodes = [];
  for (const bin of model.bins) {
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", bin.x.toFixed(2));
    rect.setAttribute("y", "3");
    rect.setAttribute("width", Math.max(0.5, bin.w - (bin.w > 2 ? 0.6 : 0)).toFixed(2));
    rect.setAttribute("height", String(height - 3));
    rect.setAttribute("class", `bin ${bin.state}`);
    nodes.push(rect);
    if (bin.fresh) {
      const mark = document.createElementNS(SVG, "rect");
      mark.setAttribute("x", bin.x.toFixed(2));
      mark.setAttribute("y", "0");
      mark.setAttribute("width", Math.max(0.5, bin.w).toFixed(2));
      mark.setAttribute("height", "2");
      mark.setAttribute("class", "bin-fresh");
      nodes.push(mark);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${model.width} ${height}`);
  svg.replaceChildren(...nodes);
}

// A small, non-interactive barcode for lists, Home and the chapter end.
export function miniBarcode(entries, width = 160, height = 8) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "barcode-mini");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "none");
  drawBins(svg, barcodeModel(entries, width, { target: 2 }), height);
  return svg;
}

// The full barcode with scrubbing, a bubble, the magnified strip and a keyboard path.
export function createBarcode({ host, onSelect, mode = "order" }) {
  host.classList.add("barcode");
  host.innerHTML = "";
  const track = document.createElement("div");
  track.className = "barcode-track";
  track.tabIndex = 0;
  track.setAttribute("role", "slider");
  track.setAttribute("aria-valuemin", "1");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "none");
  const cursor = document.createElement("span");
  cursor.className = "barcode-cursor";
  cursor.hidden = true;
  const bubble = document.createElement("span");
  bubble.className = "barcode-bubble";
  bubble.hidden = true;
  track.append(svg, cursor, bubble);
  const summary = document.createElement("p");
  summary.className = "barcode-summary";
  const legend = document.createElement("p");
  legend.className = "barcode-legend";
  legend.innerHTML = '<i class="read"></i>읽음 <i class="reading"></i>읽는 중 <i class="unread"></i>안 읽음 <i class="missing"></i>보존 안 됨 <i class="fresh"></i>새 화';
  const strip = document.createElement("div");
  strip.className = "barcode-strip";
  strip.hidden = true;
  host.append(summary, track, legend, strip);

  let entries = [];
  let model = { bins: [], width: 0 };
  let active = -1;
  let chosen = null;

  function layout() {
    const width = Math.round(track.clientWidth) || 320;
    const started = performance.now();
    model = barcodeModel(entries, width, { mode });
    drawBins(svg, model, 24);
    host.dataset.renderMs = (performance.now() - started).toFixed(2);
    track.setAttribute("aria-valuemax", String(Math.max(1, model.bins.length)));
  }

  function point(bin) {
    active = Math.max(0, Math.min(model.bins.length - 1, bin));
    const current = model.bins[active];
    if (!current) return;
    const text = binLabel(entries, current);
    bubble.textContent = text;
    bubble.hidden = false;
    cursor.hidden = false;
    const left = ((current.x + current.w / 2) / model.width) * 100;
    cursor.style.left = `${left}%`;
    bubble.style.left = `clamp(0px, calc(${left}% - 60px), calc(100% - 120px))`;
    track.setAttribute("aria-valuenow", String(active + 1));
    track.setAttribute("aria-valuetext", text);
  }

  function binAt(clientX) {
    const box = track.getBoundingClientRect();
    return Math.floor(((clientX - box.left) / box.width) * model.bins.length);
  }

  function magnify() {
    const bin = model.bins[active];
    if (!bin) return;
    bubble.hidden = true;
    const list = document.createElement("div");
    list.className = "barcode-strip-list";
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", binLabel(entries, bin));
    chosen = null;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "barcode-go";
    go.textContent = "이 회차로";
    go.disabled = true;
    for (let index = bin.from; index < bin.to; index += 1) {
      const entry = entries[index];
      const option = document.createElement("button");
      option.type = "button";
      option.className = `barcode-option ${entry.state}`;
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", "false");
      option.textContent = entry.label ?? `${entry.position}화`;
      option.disabled = entry.state === "missing";
      option.addEventListener("click", () => {
        for (const other of list.children) other.setAttribute("aria-checked", String(other === option));
        chosen = entry;
        go.disabled = false;
      });
      list.append(option);
    }
    go.addEventListener("click", () => chosen && onSelect(chosen));
    strip.replaceChildren(list, go);
    strip.hidden = false;
    (list.querySelector('[aria-checked="false"]:not(:disabled)') ?? go).focus({ preventScroll: true });
  }

  track.addEventListener("pointerdown", (event) => {
    if (!model.bins.length) return;
    track.setPointerCapture(event.pointerId);
    point(binAt(event.clientX));
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture(event.pointerId)) point(binAt(event.clientX));
  });
  track.addEventListener("pointerup", (event) => {
    if (!track.hasPointerCapture(event.pointerId)) return;
    track.releasePointerCapture(event.pointerId);
    magnify();
  });
  track.addEventListener("pointercancel", () => { bubble.hidden = true; cursor.hidden = true; });
  track.addEventListener("keydown", (event) => {
    if (!model.bins.length) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      point(Number.isFinite(step) ? (active < 0 ? 0 : active + step) : step < 0 ? 0 : model.bins.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (active < 0) point(0);
      magnify();
    }
  });
  track.addEventListener("blur", () => { bubble.hidden = true; });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout()) : null;
  resize?.observe(track);

  return {
    update(next) {
      entries = next;
      const text = barcodeSummary(entries);
      summary.textContent = text;
      track.setAttribute("aria-label", `회차 바코드: ${text}`);
      strip.hidden = true;
      active = -1;
      cursor.hidden = true;
      bubble.hidden = true;
      layout();
      // A slider always names a value; before any scrub it is the first bin.
      track.setAttribute("aria-valuenow", "1");
      track.setAttribute("aria-valuetext", model.bins[0] ? binLabel(entries, model.bins[0]) : text);
    },
    destroy() { resize?.disconnect(); },
  };
}
