// Work header (docs/24 §8.6): the cover, and the barcode of the work's episodes under the title.
// TypeMoon collections and text works both describe their episodes as barcode entries; picking
// one on the barcode goes through the same path as picking its row in the list.

import { createBarcode } from "/barcode.js";
import { createTypeCover, workHue } from "/type-cover.js";

// size: "s" where the header stays fixed above a list (the text library), else M on phones, L wider.
export function fillWorkCover(host, { title, source, hueKey, progress = null, size = null }) {
  host.replaceChildren(createTypeCover({
    title, source, size: size ?? (matchMedia("(max-width: 759px)").matches ? "m" : "l"), hue: workHue(hueKey), progress, mine: true,
  }));
}

// entries: [{ position, label, missing, finished, current }] in reading order. Only the episode
// read last is "my place" on this screen; other half-read episodes count as unread.
export function episodeStates(entries) {
  return entries.map((entry) => ({
    ...entry,
    fresh: Boolean(entry.fresh),
    state: entry.missing ? "missing" : entry.current && !entry.finished ? "reading" : entry.finished ? "read" : "unread",
  }));
}

// One barcode per host, reused across works so its resize observer is not duplicated.
const barcodes = new WeakMap();
// unit: 편 for TypeMoon series (their header counts 편), 화 for text-library chapters.
export function showWorkBarcode(host, entries, onSelect, { unit = "화" } = {}) {
  let barcode = barcodes.get(host);
  if (!barcode) {
    barcode = { handler: onSelect };
    barcode.view = createBarcode({ host, unit, onSelect: (entry) => barcode.handler(entry) });
    barcodes.set(host, barcode);
  }
  barcode.handler = onSelect;
  host.hidden = entries.length < 2;
  barcode.view.update(episodeStates(entries));
}

// The saved (bookmarked) mark in a list row: an icon, not the word 저장, so it never reads together
// with the reading-state word next to it ("저장 완료"). Named for screen readers.
export function savedMark() {
  const mark = document.createElement("span");
  mark.className = "saved-mark";
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "저장한 글");
  mark.title = "저장한 글";
  mark.innerHTML = '<svg aria-hidden="true"><use href="#i-bookmark"/></svg>';
  return mark;
}
