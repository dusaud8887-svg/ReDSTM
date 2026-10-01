// Page mode (docs/24 §8.10, S1): the body is laid out in CSS columns one page wide and moved with
// a transform, never scroll-snap. Every page sits at the same height side by side, so the reading
// place is the first character at or right of the current page's left edge (not below a top line).
// Positions are stored as the same sentence locators as scroll mode; page numbers are derived.

import { createLocator, createTextModel, modelOffset, modelPosition, resolveLocator } from "./text-model.js";

const QUOTE_LENGTH = 48;

// Pure geometry: one page is the content width; the gap is both side margins, so a move of
// width + gap shows exactly the next column.
export function pageGeometry({ paneWidth, paneHeight, margin, maxWidth, top = 0, bottom = 0 }) {
  const width = Math.max(120, Math.min(maxWidth, paneWidth - 2 * margin));
  const gap = Math.max(16, paneWidth - width);
  return { width, gap, step: width + gap, height: Math.max(160, paneHeight - top - bottom), left: (paneWidth - width) / 2 };
}

export function pageCount(scrollWidth, geometry) {
  return Math.max(1, Math.ceil((scrollWidth + geometry.gap) / geometry.step - 0.01));
}

// Which page a point at x (relative to the first page's left edge) falls on.
export function pageAt(x, geometry, pages) {
  return Math.max(0, Math.min(pages - 1, Math.floor((x + geometry.gap / 2) / geometry.step)));
}

// Release of a swipe: past a fifth of the page or a quick flick turns it (DESIGN §8.2).
export function swipeTarget(page, pages, dx, elapsed, width) {
  const velocity = Math.abs(dx) / Math.max(1, elapsed);
  if (Math.abs(dx) < width * 0.2 && velocity <= 0.3) return page;
  return Math.max(0, Math.min(pages - 1, page + (dx < 0 ? 1 : -1)));
}

function textNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.trim()) nodes.push(node);
  return nodes;
}

function charRect(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(node.data.length, offset + 1));
  return range.getClientRects()[0] ?? null;
}

// First character on or after screen x = left, in document order (columns run left to right).
export function capturePagedAnchor(container, left, rev = "") {
  const nodes = textNodes(container);
  const model = createTextModel(container);
  let low = 0;
  let high = nodes.length;
  const nodeRight = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right;
  };
  while (low < high) {
    const middle = (low + high) >> 1;
    if (nodeRight(nodes[middle]) > left + 1) high = middle;
    else low = middle + 1;
  }
  const node = nodes[low];
  if (!node) return null;
  let first = 0;
  let last = node.data.length - 1;
  while (first < last) {
    const middle = (first + last) >> 1;
    const rect = charRect(node, middle);
    if (rect && rect.left >= left - 1) last = middle;
    else first = middle + 1;
  }
  const start = modelOffset(model, node, first);
  return start === null ? null : { loc: createLocator(model, start, start + QUOTE_LENGTH, rev), viewportOffset: 0 };
}

// The screen x of a stored place, to find its page; null when the text no longer holds it.
export function anchorLeft(container, anchor, rev = "") {
  if (!anchor?.loc) return null;
  const model = createTextModel(container);
  const resolved = resolveLocator(model, anchor.loc, rev);
  if (resolved.status === "unresolved") return null;
  const position = modelPosition(model, resolved.start);
  if (!position) return null;
  return charRect(position.node, Math.min(position.offset, Math.max(0, position.node.data.length - 1)))?.left ?? null;
}
