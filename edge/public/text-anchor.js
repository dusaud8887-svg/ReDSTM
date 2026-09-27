// Sentence-level reading anchors: the character offset of the first visible line, so a font-size
// change, a revision change, or a late layout shift can bring the same sentence back into view.

const QUOTE_LENGTH = 48;

function textNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

function locate(container, target) {
  let total = 0;
  for (const node of textNodes(container)) {
    // A boundary offset belongs to the next node's first character, not the previous node's end.
    if (target < total + node.data.length) return { node, offset: Math.max(0, target - total) };
    total += node.data.length;
  }
  const nodes = textNodes(container);
  const last = nodes.at(-1);
  return last ? { node: last, offset: Math.max(0, last.data.length - 1) } : null;
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
  return range.getBoundingClientRect().bottom;
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
export function captureTextAnchor(container, scroller, topInset = 0) {
  if (!container?.isConnected || !scroller) return null;
  const top = scroller.getBoundingClientRect().top + topInset;
  if (container.getBoundingClientRect().bottom <= top) return null;
  let total = 0;
  for (const node of textNodes(container)) {
    if (node.data.trim() && nodeBottom(node) > top) {
      const local = firstVisibleOffset(node, top);
      const rect = rectAt({ node, offset: local });
      const offset = total + local;
      return {
        offset,
        quote: container.textContent.slice(offset, offset + QUOTE_LENGTH),
        viewportOffset: rect ? rect.top - top : 0,
      };
    }
    total += node.data.length;
  }
  return null;
}

// Prefers the exact offset when the text still matches the quote, otherwise searches the quote
// (a revised body), and reports false so callers can fall back to a stored pixel position.
export function restoreTextAnchor(container, scroller, anchor, topInset = 0) {
  if (!container?.isConnected || !scroller || !anchor) return false;
  const text = container.textContent ?? "";
  let target = Number.isInteger(anchor.offset) && anchor.offset >= 0 ? anchor.offset : -1;
  if (anchor.quote && text.slice(target, target + anchor.quote.length) !== anchor.quote) {
    target = text.indexOf(anchor.quote);
  }
  if (target < 0 || target > text.length) return false;
  const position = locate(container, target);
  const rect = position && rectAt(position);
  if (!rect) return false;
  const top = scroller.getBoundingClientRect().top + topInset;
  scroller.scrollTop += rect.top - top - (Number(anchor.viewportOffset) || 0);
  return true;
}
