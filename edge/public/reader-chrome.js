// Reader chrome pieces (docs/24 §8.7): the chapter-end card's place in the work — a small barcode
// and "N/M화" — and the collapsed progress badge. app.js owns the Reader; this only draws.

import { miniBarcode } from "/barcode.js";

// run: { position, total, unit, entries: [{ position, state }] } or null outside a work.
export function renderChapterRun(host, label, run) {
  host.hidden = !run || run.total < 2;
  if (host.hidden) return;
  const bar = host.querySelector(".chapter-end-barcode");
  bar.replaceChildren(miniBarcode(run.entries, 240, 8));
  label.textContent = `${run.position.toLocaleString("ko-KR")}/${run.total.toLocaleString("ko-KR")}${run.unit}`;
}

// The badge shown while the tools are folded: the part of the chapter read, as a whole percent.
export function progressBadge(ratio) {
  return `${Math.round(Math.min(1, Math.max(0, Number(ratio) || 0)) * 100)}%`;
}
