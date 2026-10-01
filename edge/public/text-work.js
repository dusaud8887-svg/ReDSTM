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

// Reading times compare as instants: a time written with a zone offset sorts by when it was,
// not by its text (R01).
function readTime(record) {
  const time = Date.parse(record?.readAt ?? "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function moveNovelStateKey(state, oldKey, next, work) {
  if (oldKey === next) return false;
  const record = state.history[oldKey];
  if (record) {
    const existing = state.history[next];
    if (!existing || readTime(record) > readTime(existing)) {
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

// Newtomi novel chapters start with "# <title>", "# <source url>", then a blank line (Newtomi
// core/novel_text.py); an older export put the URL on its own line after a bare "#". Only these
// wrappers are lifted out of the body; any other "#" or URL stays part of the text. Oracle bodies
// have no wrapper, so their source link comes from the chapter entry instead.
export function novelBody(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines[0]?.startsWith("# ")) return { text: String(text), sourceUrl: "" };
  const inline = /^#\s+(https?:\/\/\S+)\s*$/.exec(lines[1] ?? "")?.[1];
  const separate = lines[1]?.trim() === "#" && /^https?:\/\/\S+$/.test(lines[2]?.trim() ?? "")
    ? lines[2].trim() : "";
  const url = inline || separate;
  if (!url) return { text: String(text), sourceUrl: "" };
  let start = inline ? 2 : 3;
  while (start < lines.length && !lines[start].trim()) start += 1;
  return { text: lines.slice(start).join("\n"), sourceUrl: url };
}

// Arcalive exports carry a "# title … ---" front-matter block; keep the body and its source URL.
export function arcaliveBody(text) {
  const raw = String(text);
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines[0]?.startsWith("# ")) return { text: raw, sourceUrl: "" };
  const separator = lines.findIndex((line, index) => index > 0 && index < 16 && line === "---");
  if (separator < 0) return { text: raw, sourceUrl: "" };
  const url = lines.slice(1, separator).map((line) => /^-\s*url:\s*(https?:\/\/\S+)\s*$/i.exec(line)?.[1]).find(Boolean) ?? "";
  return { text: lines.slice(separator + 1).join("\n").replace(/^\n+/, ""), sourceUrl: url };
}

// Detail only the resume paths read: the latest record of each work (Home 이어서 읽기, 읽던 작품,
// new-chapter counts) and the most recent reads keep routes, titles, and exact positions. Older
// records keep when they were read and how far; an unfinished one also keeps its position. A full
// record is ~800 characters, so 10,000 of them alone would pass the ~5 MB localStorage quota.
const DETAIL_FIELDS = ["route", "listRoute", "title", "work", "total"];
const POSITION_FIELDS = ["anchor", "offset", "anchorTop", "scroll", "revision", "chapterId", "loc", "documentId"];

export function compactTextHistory(history, { keepRecent = 50 } = {}) {
  const entries = Object.entries(history)
    .filter(([, record]) => record && typeof record === "object")
    .sort(([, left], [, right]) => readTime(right) - readTime(left) || 0);
  const latestPerWork = new Set();
  const seenWorks = new Set();
  for (const [key, record] of entries) {
    const work = typeof record.workId === "string" && record.workId ? record.workId : key;
    if (seenWorks.has(work)) continue;
    seenWorks.add(work);
    latestPerWork.add(key);
  }
  let changed = false;
  entries.forEach(([key, record], index) => {
    if (typeof record.progress === "number" && record.progress !== Math.round(record.progress * 1000) / 1000) {
      record.progress = Math.round(record.progress * 1000) / 1000;
      changed = true;
    }
    if (index < keepRecent || latestPerWork.has(key)) return;
    const finished = (record.progress ?? 0) >= 0.95;
    for (const field of [...DETAIL_FIELDS, ...(finished ? POSITION_FIELDS : [])]) {
      if (field in record) {
        delete record[field];
        changed = true;
      }
    }
    // The key already starts with its work id; keep workId only where it disagrees (aliases).
    if (typeof record.workId === "string" && key.startsWith(`novel:${record.workId}:`)) {
      delete record.workId;
      changed = true;
    }
  });
  return changed;
}

// Oldest records dropped until the serialized state fits the budget (saved items stay).
export function trimTextState(state, maxChars) {
  let size = JSON.stringify(state).length;
  if (size <= maxChars) return 0;
  const keys = Object.keys(state.history)
    .sort((left, right) => readTime(state.history[left]) - readTime(state.history[right]) || 0);
  let removed = 0;
  for (const key of keys) {
    if (size <= maxChars) break;
    size -= JSON.stringify(key).length + JSON.stringify(state.history[key]).length + 2;
    delete state.history[key];
    removed += 1;
  }
  return removed;
}
