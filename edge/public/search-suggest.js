// Korean title suggestions (docs/24 §8.4, 부록 C): exact or partial matches first, then initial
// consonants (초성), then similar titles (jamo-level fuzzy match for typos like 세이바 → 세이버).
// Only metadata (work and board titles) is matched here; the post search stays in its Worker.
// The Hangul and fuzzy libraries are passed in so this module runs in the browser and in Node.

const GROUP_LIMIT = 20;
export const NORMALIZE_VERSION = 1;

export function normalizeTitle(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// items: [{ key, title, kind, meta? }]
export function createSuggestIndex(items, { hangul, UFuzzy }) {
  const fuzzy = new UFuzzy({
    unicode: true,
    interSplit: "[^\\p{L}\\d']+", intraSplit: "[a-z][A-Z]", intraBound: "[a-z][A-Z]",
    intraChars: "[\\p{L}\\d']",
    intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1,
  });
  const rows = items.map((item) => {
    const normal = normalizeTitle(item.title);
    // For each syllable, where its jamo start in the disassembled title, to map fuzzy ranges back.
    const starts = [];
    let jamo = "";
    for (const character of normal) {
      starts.push(jamo.length);
      jamo += hangul.disassemble(character);
    }
    return { item, normal, jamo, starts, choseong: hangul.getChoseong(normal) };
  });
  return { rows, haystack: rows.map((row) => row.jamo), fuzzy, hangul };
}

function syllableRanges(row, jamoRanges) {
  const ranges = [];
  for (let index = 0; index < jamoRanges.length; index += 2) {
    const start = jamoRanges[index];
    const end = jamoRanges[index + 1];
    let from = 0;
    while (from + 1 < row.starts.length && row.starts[from + 1] <= start) from += 1;
    let to = from;
    while (to < row.starts.length && row.starts[to] < end) to += 1;
    const last = ranges.at(-1);
    if (last && last[1] >= from) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
}

// Returns { query, normalizeVersion, exact[], choseong[], similar[], qwerty } where each hit is
// { item, ranges: [[start, end], ...] } over the normalised title's characters.
export function suggest(index, query, { limit = GROUP_LIMIT } = {}) {
  const wanted = normalizeTitle(query);
  const empty = { query: wanted, normalizeVersion: NORMALIZE_VERSION, exact: [], choseong: [], similar: [], qwerty: "" };
  if (!wanted) return empty;
  const { rows, hangul } = index;
  const seen = new Set();
  const exact = [];
  for (const row of rows) {
    const at = row.normal.indexOf(wanted);
    if (at < 0) continue;
    exact.push({ item: row.item, ranges: [[at, at + wanted.length]], score: (at === 0 ? 0 : 1) + row.normal.length / 1000 });
  }
  exact.sort((left, right) => left.score - right.score);
  for (const hit of exact) seen.add(hit.item.key);

  // NFKC turns compatibility jamo (ㄷ) into conjoining jamo, so 초성 uses the input as typed.
  const compact = String(query).replace(/\s/g, "");
  const choseong = [];
  if (compact && [...compact].every((character) => hangul.canBeChoseong(character))) {
    for (const row of rows) {
      if (seen.has(row.item.key)) continue;
      const at = row.choseong.replace(/\s/g, "").indexOf(compact);
      if (at >= 0) choseong.push({ item: row.item, ranges: [] });
    }
    for (const hit of choseong) seen.add(hit.item.key);
  }

  const similar = [];
  if (wanted.length >= 2) {
    const needle = hangul.disassemble(wanted);
    const [indexes, info, order] = index.fuzzy.search(index.haystack, needle, 0, 1e3);
    if (indexes && info && order) {
      for (const position of order) {
        const rowIndex = info.idx[position];
        const row = rows[rowIndex];
        if (seen.has(row.item.key)) continue;
        similar.push({ item: row.item, ranges: syllableRanges(row, info.ranges[position]) });
        if (similar.length >= limit) break;
      }
    }
  }

  // Nothing found and the input looks like Hangul typed on a Latin layout: offer the conversion.
  let qwerty = "";
  if (!exact.length && !choseong.length && !similar.length && /^[a-z\s]+$/i.test(query.trim())) {
    const converted = hangul.convertQwertyToHangul(query.trim());
    if (converted && converted !== query.trim()) qwerty = converted;
  }
  return {
    query: wanted, normalizeVersion: NORMALIZE_VERSION, qwerty,
    exact: exact.slice(0, limit).map(({ item, ranges }) => ({ item, ranges })),
    choseong: choseong.slice(0, limit), similar,
  };
}

// Answers only the latest request: a slower earlier answer never replaces a newer one (T19).
export function createSuggester(getIndex) {
  let queryId = 0;
  return {
    async request(query, render) {
      const id = ++queryId;
      const index = await getIndex();
      if (id !== queryId || !index) return false;
      render(suggest(index, query), id);
      return true;
    },
    cancel() { queryId += 1; },
    get queryId() { return queryId; },
  };
}
