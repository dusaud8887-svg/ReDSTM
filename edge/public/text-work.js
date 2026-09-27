// The server's chapter array is the reading order; view sorting only changes the list.
export function orderChapters(rows, mode) {
  const ordered = [...rows];
  if (mode === "latest") ordered.reverse();
  if (mode === "title") ordered.sort((left, right) =>
    String(left.label || "").localeCompare(String(right.label || ""), "ko-KR", { numeric: true }));
  return ordered;
}

function moveNovelStateKey(state, oldKey, next, work) {
  if (oldKey === next) return false;
  const record = state.history[oldKey];
  if (record) {
    const existing = state.history[next];
    if (!existing || String(record.readAt || "") > String(existing.readAt || "")) {
      state.history[next] = record;
    }
    delete state.history[oldKey];
  }
  const saved = state.bookmarks[oldKey];
  if (saved) {
    const existing = state.bookmarks[next];
    if (!existing || String(saved.savedAt || "") > String(existing.savedAt || "")) {
      state.bookmarks[next] = { ...saved, work };
    } else {
      existing.work = work;
    }
    delete state.bookmarks[oldKey];
  }
  return Boolean(record || saved);
}

export function migrateNovelState(state, items) {
  let changed = false;
  for (const item of items) {
    const currentPrefix = `novel:${item.work_id}:`;
    for (const alias of item.legacy_work_ids || []) {
      const oldPrefix = `novel:${alias}:`;
      if (oldPrefix === currentPrefix) continue;
      for (const key of new Set([...Object.keys(state.history), ...Object.keys(state.bookmarks)])) {
        if (!key.startsWith(oldPrefix)) continue;
        const next = currentPrefix + key.slice(oldPrefix.length);
        changed = moveNovelStateKey(state, key, next, item) || changed;
      }
    }
  }
  return changed;
}

export function migrateNovelChapterState(state, work, chapters) {
  let changed = false;
  const workIds = [work.work_id, ...(work.legacy_work_ids || [])];
  for (const chapter of chapters) {
    const next = `novel:${work.work_id}:${chapter.chapter_id}`;
    for (const workId of workIds) {
      for (const chapterId of chapter.legacy_chapter_ids || []) {
        const oldKey = `novel:${workId}:${chapterId}`;
        changed = moveNovelStateKey(state, oldKey, next, work) || changed;
      }
    }
  }
  return changed;
}
