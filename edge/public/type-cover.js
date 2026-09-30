// Typographic covers (DESIGN §2.5, §7.2): a work is recognised by its title set in the display
// serif on its own hue, never by a borrowed image. The hue comes from a stable work key so the
// same work keeps its colour on every screen and device.

export const HUE_COUNT = 10;
const HUE_NAMES = ["쪽", "청", "녹", "올리브", "황토", "주", "자", "보", "남", "먹"];

// FNV-1a 32-bit over UTF-16 code units.
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Stable keys: typemoon:collection:<id>, novel:<work_id>, arcalive:<board>:<work>, or a post.
export function workKey({ source, id, board = "" }) {
  if (source === "typemoon") return `typemoon:collection:${id}`;
  if (source === "typemoon-post") return `typemoon:post:${board}:${id}`;
  if (source === "arcalive") return `arcalive:${board}:${id}`;
  return `novel:${id}`;
}

export function workHue(key, override) {
  if (Number.isInteger(override) && override >= 0 && override < HUE_COUNT) return override;
  return fnv1a(String(key)) % HUE_COUNT;
}

export function hueName(hue) {
  return HUE_NAMES[hue] ?? "";
}

// The letter on a small cover: the first letter of the title after any bracketed tag such as
// "[AA]" or "【단편】" and after leading punctuation. Grapheme-aware so a composed syllable or an
// emoji stays whole.
const leadingTags = /^(?:\s*(?:\[[^\]]*\]|【[^】]*】|\([^)]*\)|〈[^〉]*〉|<[^>]*>))+\s*/u;
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;
export function coverInitial(title) {
  const text = String(title ?? "").replace(leadingTags, "").replace(/^[\s\p{P}]+/u, "") || String(title ?? "").trim();
  if (!text) return "?";
  if (segmenter) return segmenter.segment(text)[Symbol.iterator]().next().value.segment.toUpperCase();
  return [...text][0].toUpperCase();
}

// size: "s" (32×44, one letter), "m" (104×148) or "l" (128×182) with the full title and source.
// progress is 0–1 or null; mine marks the one work that is "my place" on this screen (ribbon).
export function createTypeCover({ title, source = "", size = "m", hue = 0, newCount = 0, progress = null, mine = false, offline = false }) {
  const cover = document.createElement("span");
  cover.className = `type-cover size-${size} hue-${hue}`;
  cover.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "type-cover-title";
  name.textContent = size === "s" ? coverInitial(title) : String(title ?? "");
  cover.append(name);
  if (size !== "s" && source) {
    const origin = document.createElement("span");
    origin.className = "type-cover-source";
    origin.textContent = source;
    cover.append(origin);
  }
  if (newCount > 0) cover.append(Object.assign(document.createElement("span"), { className: "type-cover-new" }));
  if (Number.isFinite(progress) && progress > 0) {
    const bar = document.createElement("span");
    bar.className = `type-cover-progress${mine ? " mine" : ""}`;
    bar.style.setProperty("--cover-progress", `${Math.round(Math.min(1, progress) * 100)}%`);
    cover.append(bar);
  }
  if (offline) cover.append(Object.assign(document.createElement("span"), { className: "type-cover-offline" }));
  return cover;
}
