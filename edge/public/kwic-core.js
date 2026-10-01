import { findMatches } from "./find.js";
import { createLocator } from "./text-model.js";

// Filter before fetching or counting. A visit to episode 200 never opens episodes 6–199.
export function kwicScope(entries, { all = false, read = [], current = "", opened = [] } = {}) {
  const allowed = new Set([...read, ...opened, current]);
  return entries.filter((entry) => all || allowed.has(entry.documentId));
}

export function kwicMatches(text, query, rev = "") {
  return findMatches(text, query).map(({ start, end }) => ({
    locator: createLocator({ text, tm: 1 }, start, end, rev),
    before: text.slice(Math.max(0, start - 36), start),
    exact: text.slice(start, end), after: text.slice(end, end + 36),
  }));
}

// Four requests at most, partial failures are separate from zero matches, and abort stops backfill.
export async function runKwic(entries, { query, signal, load, onResult }) {
  let cursor = 0;
  let checked = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (!signal.aborted && cursor < entries.length) {
      const entry = entries[cursor++];
      let matches = [];
      let error = false;
      try { matches = kwicMatches(await load(entry, signal), query, entry.rev); }
      catch { if (signal.aborted) return; error = true; failed += 1; }
      if (signal.aborted) return;
      checked += 1;
      onResult({ entry, matches, error, checked, failed, total: entries.length });
    }
  }));
}
