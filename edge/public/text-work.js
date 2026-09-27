// The server's chapter array is the reading order; view sorting only changes the list.
export function orderChapters(rows, mode) {
  const ordered = [...rows];
  if (mode === "latest") ordered.reverse();
  if (mode === "title") ordered.sort((left, right) =>
    String(left.label || "").localeCompare(String(right.label || ""), "ko-KR", { numeric: true }));
  return ordered;
}

export function migrateNovelState(state, items) {
  let changed = false;
  for (const item of items) {
    const currentPrefix = `novel:${item.work_id}:`;
    for (const alias of item.legacy_work_ids || []) {
      const oldPrefix = `novel:${alias}:`;
      if (oldPrefix === currentPrefix) continue;
      for (const [key, value] of Object.entries(state.history)) {
        if (!key.startsWith(oldPrefix)) continue;
        const next = currentPrefix + key.slice(oldPrefix.length);
        const existing = state.history[next];
        if (!existing || String(value.readAt || "") > String(existing.readAt || "")) {
          state.history[next] = value;
        }
        delete state.history[key];
        changed = true;
      }
      for (const [key, value] of Object.entries(state.bookmarks)) {
        if (!key.startsWith(oldPrefix)) continue;
        const next = currentPrefix + key.slice(oldPrefix.length);
        const existing = state.bookmarks[next];
        if (!existing || String(value.savedAt || "") > String(existing.savedAt || "")) {
          state.bookmarks[next] = { ...value, work: item };
        } else {
          existing.work = item;
        }
        delete state.bookmarks[key];
        changed = true;
      }
    }
  }
  return changed;
}
