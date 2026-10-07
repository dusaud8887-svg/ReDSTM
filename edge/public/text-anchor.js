// Sentence-level reading anchors: the character offset of the first visible line, so a font-size
// change, a revision change, or a late layout shift can bring the same sentence back into view.
import { createLocator, createTextModel, modelOffset, modelPosition, resolveLocator } from "./text-model.js";

const QUOTE_LENGTH = 48;

function locate(model, target) {
  let low = 0;
  let high = model.rawNodes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (target < model.rawNodes[middle].end) high = middle;
    else low = middle + 1;
  }
  const segment = model.rawNodes[low] ?? model.rawNodes.at(-1);
  return segment ? { node: segment.node, offset: Math.max(0, Math.min(target - segment.start, segment.node.data.length - 1)) } : null;
}

// A skipped plain-text chunk has no line boxes (content-visibility: auto). Measuring a
// saved place inside one looks like a missing sentence, and the reader then saves the top.
// Lay out every chunk from the start through the one that holds this node. Later chunks
// stay skipped. A place in the unchunked tail needs every chunk above it at its real height.
function revealChunksThrough(node) {
  const chunk = node?.parentElement?.closest?.(".text-chunk") ?? null;
  const root = chunk?.parentElement ?? node?.parentElement?.closest?.(".archive-body");
  if (!root) return;
  for (const child of root.children) {
    if (!child.classList?.contains("text-chunk")) continue;
    child.style.contentVisibility = "visible";
    if (chunk && child === chunk) return;
  }
}

function rectAt(position) {
  const range = document.createRange();
  const end = Math.min(position.node.data.length, position.offset + 1);
  range.setStart(position.node, Math.min(position.offset, end));
  range.setEnd(position.node, end);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return rect && (rect.height || rect.top) ? rect : null;
}

function nodeBottom(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  return rect.height ? rect.bottom : (node.parentElement?.closest(".text-chunk")?.getBoundingClientRect().bottom ?? rect.bottom);
}

// First character of a text node whose line ends below `top` (binary search over layout rects).
function firstVisibleOffset(node, top) {
  let low = 0;
  let high = node.data.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = rectAt({ node, offset: middle });
    if (rect && rect.bottom > top) high = middle;
    else low = middle + 1;
  }
  return low;
}

// Uses layout geometry rather than hit testing, so an open settings sheet or backdrop over the
// text does not hide it. topInset skips sticky chrome covering the top of the scrollport.
export function captureTextAnchor(container, scroller, topInset = 0, rev = "") {
  if (!container?.isConnected || !scroller) return null;
  const top = scroller.getBoundingClientRect().top + topInset;
  if (container.getBoundingClientRect().bottom <= top) return null;
  const model = createTextModel(container);
  const segments = model.visibleSegments;
  // The binary search assumes text bottoms grow in DOM order. That holds for flowing prose, but a
  // table, float, or columns put later nodes beside earlier ones, and the search can land on text
  // far below the screen. Such a pick is checked, then the earlier nodes are scanned in order.
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (nodeBottom(segments[middle].node) > top) high = middle;
    else low = middle + 1;
  }
  let node = segments[low]?.node;
  let local = node ? firstVisibleOffset(node, top) : 0;
  let rect = node ? rectAt({ node, offset: local }) : null;
  if (!rect || rect.top >= scroller.getBoundingClientRect().bottom) {
    const earlier = segments.slice(0, low).find((segment) => nodeBottom(segment.node) > top);
    if (earlier) {
      node = earlier.node;
      local = firstVisibleOffset(node, top);
      rect = rectAt({ node, offset: local });
    }
  }
  if (node) {
    const offset = model.rawPositions.get(node) + local;
    const start = modelOffset(model, node, local);
    return {
      offset,
      quote: model.rawText.slice(offset, offset + QUOTE_LENGTH),
      viewportOffset: rect ? rect.top - top : 0,
      ...(start !== null ? { loc: createLocator(model, start, start + QUOTE_LENGTH, rev) } : {}),
    };
  }
  return null;
}

// Prefers the exact offset when the text still matches the quote, otherwise searches the quote
// (a revised body), and reports false so callers can fall back to a stored pixel position.
export function restoreTextAnchor(container, scroller, anchor, topInset = 0, rev = "") {
  if (!container?.isConnected || !scroller || !anchor) return false;
  const model = createTextModel(container);
  const text = model.rawText;
  if (anchor.loc) {
    const resolved = resolveLocator(model, anchor.loc, rev);
    if (resolved.status === "unresolved") return false;
    const position = modelPosition(model, resolved.start);
    if (position) revealChunksThrough(position.node);
    const rect = position && rectAt(position);
    if (!rect) return false;
    const top = scroller.getBoundingClientRect().top + topInset;
    scroller.scrollTop += rect.top - top - (Number(anchor.viewportOffset) || 0);
    return true;
  }
  let target = Number.isInteger(anchor.offset) && anchor.offset >= 0 ? anchor.offset : -1;
  if (anchor.quote && text.slice(target, target + anchor.quote.length) !== anchor.quote) {
    target = text.indexOf(anchor.quote);
  }
  if (target < 0 || target > text.length) return false;
  const position = locate(model, target);
  if (position) revealChunksThrough(position.node);
  const rect = position && rectAt(position);
  if (!rect) return false;
  const top = scroller.getBoundingClientRect().top + topInset;
  scroller.scrollTop += rect.top - top - (Number(anchor.viewportOffset) || 0);
  return true;
}
