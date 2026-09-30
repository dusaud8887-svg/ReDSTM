// Work header (docs/24 §8.6): the cover, and the barcode of the work's episodes under the title.
// TypeMoon collections and text works both describe their episodes as barcode entries; picking
// one on the barcode goes through the same path as picking its row in the list.

import { createBarcode } from "/barcode.js";
import { createTypeCover, workHue } from "/type-cover.js";

export function fillWorkCover(host, { title, source, hueKey, progress = null }) {
  host.replaceChildren(createTypeCover({
    title, source, size: matchMedia("(max-width: 759px)").matches ? "m" : "l", hue: workHue(hueKey), progress, mine: true,
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
export function showWorkBarcode(host, entries, onSelect) {
  let barcode = barcodes.get(host);
  if (!barcode) {
    barcode = { handler: onSelect };
    barcode.view = createBarcode({ host, onSelect: (entry) => barcode.handler(entry) });
    barcodes.set(host, barcode);
  }
  barcode.handler = onSelect;
  host.hidden = entries.length < 2;
  barcode.view.update(episodeStates(entries));
}
