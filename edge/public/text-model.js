// Coordinates always refer to the original UTF-16 text, never a search copy.
const BLOCKS = new Set(["P", "DIV", "LI", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"]);
const EXCLUDED = "#comments, .media-failed, .media-retry, figcaption, button, script, style, [data-reader-ui]";

const models = new WeakMap();

export function createTextModel(root) {
  const cached = models.get(root);
  if (cached && !cached.observer.takeRecords().length) return cached.model;
  cached?.observer.disconnect();
  let text = "";
  // The last character is tracked instead of asking the growing string: endsWith() flattens the
  // concatenated text on every block, which made a 20 MB document take seconds per capture.
  let last = "";
  const segments = [];
  const positions = new WeakMap();
  const newline = () => { if (text && last !== "\n") { text += "\n"; last = "\n"; } };
  function visit(node) {
    if (node.nodeType === 3) {
      const start = text.length;
      text += node.data;
      if (node.data.length) last = node.data[node.data.length - 1];
      if (node.data.length) {
        const segment = { node, start, end: text.length };
        segments.push(segment);
        positions.set(node, segment);
      }
      return;
    }
    if (node !== root && (node.tagName === "RT" || node.matches?.(EXCLUDED))) return;
    if (node.tagName === "BR") { newline(); return; }
    const block = node !== root && BLOCKS.has(node.tagName);
    if (block) newline();
    for (const child of node.childNodes ?? []) visit(child);
    if (block) newline();
  }
  visit(root);
  const rawNodes = [];
  const rawPositions = new WeakMap();
  let rawOffset = 0;
  const walker = root.ownerDocument?.createTreeWalker(root, 4);
  for (let node = walker?.nextNode(); node; node = walker.nextNode()) {
    rawNodes.push({ node, start: rawOffset, end: rawOffset + node.data.length });
    rawPositions.set(node, rawOffset);
    rawOffset += node.data.length;
  }
  const model = { tm: 1, text, segments, positions, root, rawNodes, rawPositions,
    rawText: root.textContent ?? "", visibleSegments: segments.filter(({ node }) => node.data.trim()) };
  const Observer = root.ownerDocument?.defaultView?.MutationObserver;
  if (Observer) {
    const observer = new Observer(() => { models.delete(root); observer.disconnect(); });
    observer.observe(root, { childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ["class", "id", "data-reader-ui"] });
    models.set(root, { model, observer });
  }
  return model;
}

export function searchCopy(text) {
  const starts = [];
  const ends = [];
  let normalized = "";
  // Track whitespace without repeatedly flattening the growing normalized string.
  let space = false;
  const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text);
  for (const { segment, index } of graphemes) {
    const value = segment.normalize("NFKC");
    for (const character of value) {
      if (/\s/u.test(character)) {
        if (space) { ends[ends.length - 1] = index + segment.length; continue; }
        normalized += " ";
        space = true;
        starts.push(index);
        ends.push(index + segment.length);
      } else {
        normalized += character;
        space = false;
        for (let unit = 0; unit < character.toLowerCase().length; unit += 1) {
          starts.push(index);
          ends.push(index + segment.length);
        }
      }
    }
  }
  // Contextual case conversion (e.g. Greek final sigma) has the same coordinate lengths.
  return { text: normalized.toLowerCase(), starts, ends };
}

export function sourceRange(copy, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > copy.text.length) return null;
  return { start: copy.starts[start], end: copy.ends[end - 1] };
}

export function modelOffset(model, node, offset) {
  const segment = model.positions.get(node);
  return segment ? segment.start + Math.max(0, Math.min(offset, segment.end - segment.start)) : null;
}

export function modelPosition(model, offset, end = false) {
  if (!Number.isInteger(offset) || offset < 0 || offset > model.text.length) return null;
  let low = 0;
  let high = model.segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const segment = model.segments[middle];
    if (offset < segment.end || (end && offset <= segment.end)) high = middle;
    else low = middle + 1;
  }
  const segment = model.segments[low];
  if (segment) return { node: segment.node, offset: Math.max(0, offset - segment.start) };
  const last = model.segments.at(-1);
  return last ? { node: last.node, offset: last.end - last.start } : null;
}

export function modelRange(model, start, end) {
  const first = modelPosition(model, start);
  const last = modelPosition(model, end, true);
  if (!first || !last || end < start) return null;
  const range = model.root.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  return range;
}

export function createLocator(model, start, end = start + 48, rev = "") {
  start = Math.max(0, Math.min(model.text.length, Math.trunc(start)));
  end = Math.max(start, Math.min(model.text.length, Math.trunc(end)));
  return {
    v: 2, tm: 1, rev, start, end, exact: model.text.slice(start, end),
    prefix: model.text.slice(Math.max(0, start - 32), start), suffix: model.text.slice(end, end + 32),
  };
}

export function sanitizeLocator(loc) {
  if (loc?.v !== 2 || loc.tm !== 1 || !Number.isInteger(loc.start) || loc.start < 0 ||
      !Number.isInteger(loc.end) || loc.end <= loc.start || typeof loc.exact !== "string" ||
      loc.exact.length > 10_000 || loc.exact.length !== loc.end - loc.start ||
      typeof loc.rev !== "string" || !/^(?:[a-f0-9]{64})?$/.test(loc.rev) ||
      typeof loc.prefix !== "string" || loc.prefix.length > 32 ||
      typeof loc.suffix !== "string" || loc.suffix.length > 32) return null;
  const { v, tm, rev, start, end, exact, prefix, suffix } = loc;
  return { v, tm, rev, start, end, exact, prefix, suffix };
}

function contextScore(text, start, loc) {
  let score = 0;
  for (let length = 1; length <= loc.prefix.length; length += 1) {
    if (text[start - length] !== loc.prefix[loc.prefix.length - length]) break;
    score += 1;
  }
  for (let index = 0; index < loc.suffix.length; index += 1) {
    if (text[start + loc.exact.length + index] !== loc.suffix[index]) break;
    score += 1;
  }
  return score;
}

export function resolveLocator(model, supplied, rev = "") {
  const loc = sanitizeLocator(supplied);
  if (!loc) return { status: "unresolved" };
  const text = model.text;
  if (loc.rev === rev && text.slice(loc.start, loc.end) === loc.exact) {
    return { status: "exact", start: loc.start, end: loc.end };
  }
  const candidates = [];
  for (let index = text.indexOf(loc.exact); index >= 0; index = text.indexOf(loc.exact, index + 1)) {
    candidates.push({ start: index, score: contextScore(text, index, loc), distance: Math.abs(index - loc.start) });
  }
  candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
  const [first, second] = candidates;
  if (!first || (second && first.score === second.score && first.distance === second.distance)) return { status: "unresolved" };
  return { status: "candidate", start: first.start, end: first.start + loc.exact.length };
}

// A locator short enough for a QR code or a link (docs/24 P5-1): up to 32 characters of the
// sentence and 12 of context, base64url JSON. Decoding goes back through sanitizeLocator.
export function encodeLocator(loc) {
  const clean = sanitizeLocator(loc);
  if (!clean) return "";
  const exact = clean.exact.slice(0, 32);
  const compact = { r: clean.rev, s: clean.start, x: exact, p: clean.prefix.slice(-12), f: clean.suffix.slice(0, 12) };
  const bytes = new TextEncoder().encode(JSON.stringify(compact));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeLocator(value) {
  try {
    const binary = atob(String(value).replaceAll("-", "+").replaceAll("_", "/"));
    const compact = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    return sanitizeLocator({
      v: 2, tm: 1, rev: compact.r, start: compact.s, end: compact.s + String(compact.x ?? "").length, exact: compact.x, prefix: compact.p, suffix: compact.f,
    });
  } catch {
    return null;
  }
}
