// Marks and notes (docs/24 §8.13, §12.4). A record keeps a sentence locator into the original
// text, never DOM positions, and deleting leaves a tombstone so a backup merge cannot revive it.
// Painting uses the Custom Highlight API only; the body DOM is never changed.

import { createLocator, modelOffset, modelRange, resolveLocator, sanitizeLocator } from "./text-model.js";

export const NOTE_LIMIT = 1000;
export const QUOTE_LIMIT = 10_000;
// Below the find highlights (priority 0, find-current registered last): find > mark/note (T21).
export const MARK_PRIORITY = -1;

// Original-text offsets of a selection inside the model, or null when it reaches outside.
export function selectionOffsets(model, range) {
  const start = modelOffset(model, range.startContainer, range.startOffset);
  const end = modelOffset(model, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  // Leading and trailing white space is not part of what was meant.
  const text = model.text.slice(start, end);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return end - trail > start + lead ? { start: start + lead, end: end - trail } : null;
}

// `context` is what an excerpt list shows and opens: { title, work, route } of the document.
export function annotationRecord({ model, start, end, rev = "", documentId, workId = "", context = {}, kind = "mark", note = "", now = new Date().toISOString(), id = crypto.randomUUID() }) {
  if (kind !== "mark" && kind !== "note") throw new TypeError("지원하지 않는 기록 종류");
  if (end - start > QUOTE_LIMIT) throw new RangeError("선택이 너무 깁니다");
  const locator = createLocator(model, start, end, rev);
  return {
    id, documentId, workId, locator, quote: locator.exact, note: String(note).slice(0, NOTE_LIMIT), tags: [], kind,
    context: {
      title: String(context.title ?? "").slice(0, 300), work: String(context.work ?? "").slice(0, 300),
      route: typeof context.route === "string" && context.route.startsWith("/") ? context.route.slice(0, 1000) : "",
    },
    createdAt: now, updatedAt: now,
  };
}

// 기록 › 발췌: every live record, newest first, narrowed by words found in its quote, note, tags,
// title or work (each word must appear; case and width do not matter).
export function excerptList(records, query = "") {
  const words = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  return records
    .filter((record) => !record.deletedAt && sanitizeLocator(record.locator))
    .filter((record) => {
      if (!words.length) return true;
      const haystack = [record.quote, record.note, ...(record.tags ?? []), record.context?.title, record.context?.work]
        .join("\n").normalize("NFKC").toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((left, right) => (right.createdAt > left.createdAt ? 1 : right.createdAt < left.createdAt ? -1 : 0));
}

// Excerpts as Markdown for keeping elsewhere (F4): one quote block per record with its note
// and where it came from.
export function excerptsMarkdown(records, origin = "") {
  const lines = ["# ReDSTM 발췌", ""];
  for (const record of records) {
    const where = [record.context?.work, record.context?.title].filter(Boolean).join(" › ") || "제목 없음";
    lines.push(...record.quote.split("\n").map((line) => `> ${line}`), "");
    if (record.note) lines.push(record.note, "");
    const link = record.context?.route ? ` (${origin}${record.context.route})` : "";
    lines.push(`— ${where} · ${record.createdAt.slice(0, 10)}${link}`, "", "---", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// A note is edited in place; clearing its text turns it back into a plain mark.
export function withNote(record, note, now = new Date().toISOString()) {
  const text = String(note).trim().slice(0, NOTE_LIMIT);
  return { ...record, note: text, kind: text ? "note" : "mark", updatedAt: now };
}

export function tombstone(record, now = new Date().toISOString()) {
  return { ...record, deletedAt: now, updatedAt: now };
}

// The live records of one document, in reading order.
export function documentAnnotations(records, documentId) {
  return records
    .filter((record) => record.documentId === documentId && !record.deletedAt && sanitizeLocator(record.locator))
    .sort((left, right) => left.locator.start - right.locator.start);
}

// Each record's place in the text as it is now; a sentence that no longer resolves stays listed
// (status "unresolved") instead of jumping to a first match.
export function placeAnnotations(model, records, rev = "") {
  return records.map((record) => {
    const resolved = resolveLocator(model, record.locator, rev);
    const range = resolved.status === "unresolved" ? null : modelRange(model, resolved.start, resolved.end);
    return { record, status: range ? resolved.status : "unresolved", start: resolved.start, end: resolved.end, range };
  });
}

// The placed record under an original-text offset (the most recent one when marks overlap).
export function annotationAt(placed, offset) {
  let found = null;
  for (const item of placed) {
    if (item.range && offset >= item.start && offset < item.end && (!found || item.record.updatedAt > found.record.updatedAt)) found = item;
  }
  return found;
}
