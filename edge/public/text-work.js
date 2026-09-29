// The work a novel reading record belongs to. Keys are `novel:<work_id>:<chapter_id>` and both
// ids contain colons (`novel:<uuid>`, `novel:<site>:<work>:<chapter>`), so a key cannot be split by
// pattern. The key's prefix is matched against the known work ids first (aliases re-key records,
// see moveNovelStateKey); the record's own workId covers works not in the loaded catalog.
export function novelRecordWorkId(key, record, knownWorkIds) {
  if (!key.startsWith("novel:")) return null;
  for (let boundary = key.indexOf(":", 6); boundary > 0; boundary = key.indexOf(":", boundary + 1)) {
    const candidate = key.slice(6, boundary);
    if (knownWorkIds.has(candidate)) return candidate;
  }
  return typeof record?.workId === "string" && record.workId ? record.workId : null;
}

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
