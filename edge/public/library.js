import { sanitizeShelfState } from "./text-shelves.js";

export const DEFAULT_VIEWS = [
  { id: "new", name: "새 화 있는 작품", conditions: { fresh: true } },
  { id: "reading", name: "읽는 중", conditions: { read: "reading" } },
  { id: "aa", name: "AA 모음", conditions: { aa: true } },
  { id: "finished", name: "다 읽은 작품", conditions: { read: "finished" } },
  { id: "short", name: "10화 이하", conditions: { maxChapters: 10 } },
];
const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value) => Number.isFinite(Date.parse(value ?? ""));
const name = (value) => typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 30) : "";

export function sanitizeConditions(value) {
  const source = record(value) ? value : {};
  const result = {};
  if (["typemoon", "novel", "arcalive"].includes(source.source)) result.source = source.source;
  if (["unread", "reading", "finished"].includes(source.read)) result.read = source.read;
  for (const key of ["fresh", "aa", "pinned"]) if (source[key] === true) result[key] = true;
  if (Number.isInteger(source.maxChapters) && source.maxChapters > 0 && source.maxChapters <= 10000) result.maxChapters = source.maxChapters;
  if (/^s[a-z0-9]{1,15}$/.test(source.shelfId ?? "")) result.shelfId = source.shelfId;
  return result;
}

export function sanitizeLibrary(value) {
  const source = record(value) ? value : {};
  const shelves = sanitizeShelfState(source).shelves;
  const ids = new Set();
  const views = [];
  for (const view of Array.isArray(source.views) ? source.views : DEFAULT_VIEWS) {
    const label = name(view?.name);
    if (!label || !/^[a-z0-9-]{1,60}$/.test(view?.id ?? "") || ids.has(view.id)) continue;
    ids.add(view.id);
    views.push({ id: view.id, name: label, conditions: sanitizeConditions(view.conditions) });
    if (views.length >= 50) break;
  }
  return { key: "library", shelves, views, updatedAt: time(source.updatedAt) ? new Date(source.updatedAt).toISOString() : "1970-01-01T00:00:00.000Z" };
}

export function sanitizeWorkStyle(value) {
  if (!record(value) || typeof value.workKey !== "string" || value.workKey.length > 300 ||
      !/^(?:typemoon:(?:collection|post):|novel:|arcalive:)/.test(value.workKey) || !time(value.updatedAt)) return null;
  const kept = { workKey: value.workKey, updatedAt: new Date(value.updatedAt).toISOString() };
  if (Number.isInteger(value.hue) && value.hue >= 0 && value.hue < 10) kept.hue = value.hue;
  if (typeof value.note === "string") kept.note = value.note.slice(0, 1000);
  if (typeof value.pinned === "boolean") kept.pinned = value.pinned;
  if (/^s[a-z0-9]{1,15}$/.test(value.shelfId ?? "")) kept.shelfId = value.shelfId;
  if (time(value.deletedAt)) kept.deletedAt = new Date(value.deletedAt).toISOString();
  return kept;
}

export function matchesView(work, conditions, style = {}) {
  const query = sanitizeConditions(conditions);
  return (!query.source || work.source === query.source) && (!query.read || work.read === query.read) &&
    (!query.fresh || work.fresh === true) && (!query.aa || work.aa === true) &&
    (!query.pinned || (!style.deletedAt && style.pinned === true)) &&
    (!query.shelfId || (!style.deletedAt && style.shelfId === query.shelfId)) &&
    (!query.maxChapters || (work.chapters > 0 && work.chapters <= query.maxChapters));
}

// A later configuration replaces the older one as a unit: removed views stay removed.
export function mergeLibrary(current, incoming) {
  const mine = sanitizeLibrary(current);
  const other = sanitizeLibrary(incoming);
  return !record(current) || Date.parse(other.updatedAt) > Date.parse(mine.updatedAt) ? other : mine;
}

export function mergeWorkStyles(current, incoming) {
  const mine = new Map(current.map(sanitizeWorkStyle).filter(Boolean).map((item) => [item.workKey, item]));
  const changed = new Map();
  for (const value of incoming) {
    const other = sanitizeWorkStyle(value);
    if (!other) continue;
    const previous = changed.get(other.workKey) || mine.get(other.workKey);
    if (!previous || Date.parse(other.updatedAt) > Date.parse(previous.updatedAt)) changed.set(other.workKey, other);
  }
  return [...changed.values()];
}
