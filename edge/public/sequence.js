// Pure reading-order helpers. Callers pass the canonical reading order (collection position,
// parsed chapter order, or a list frozen when the reader opened) — never a display sort.

export function adjacentInSequence(entries, currentIndex, direction, isAvailable = () => true) {
  if (direction !== 1 && direction !== -1) throw new RangeError("direction must be -1 or 1");
  if (!Array.isArray(entries) || !Number.isInteger(currentIndex) ||
      currentIndex < 0 || currentIndex >= entries.length) {
    return { kind: "not-in-sequence", target: null, skipped: [] };
  }
  const skipped = [];
  for (let index = currentIndex + direction; index >= 0 && index < entries.length; index += direction) {
    if (isAvailable(entries[index])) {
      return { kind: skipped.length ? "gap" : "ready", target: entries[index], skipped };
    }
    skipped.push(entries[index]);
  }
  return { kind: skipped.length ? "unavailable-tail" : "end", target: null, skipped };
}

// The last numbered marker wins: "2회차 …-31화" is episode 31, not 2.
export function episodeNumber(label) {
  const matches = [...String(label ?? "").normalize("NFKC").matchAll(/(\d+)\s*(?:화|話|회)(?!차)/g)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

// Episodes the label numbering skips between two adjacent entries, e.g. 31화 → 34화 is 2.
// Numbering that restarts or runs backwards (a new season at 1화) is not a gap.
export function labelGap(fromLabel, toLabel) {
  const from = episodeNumber(fromLabel);
  const to = episodeNumber(toLabel);
  if (from === null || to === null) return 0;
  return Math.max(0, to - from - 1);
}
