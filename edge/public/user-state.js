import { mergeShelfState, sanitizeShelfState } from "./text-shelves.js";
import { sanitizeLibrary, sanitizeWorkStyle } from "./library.js";
import { sanitizeLocator } from "./text-model.js";

export const STATE_KEY = "redstm.userState.v2";

export function stateStorageKey(key, owner) {
  if (!owner) return key;
  try {
    const legacyOwner = localStorage.getItem("redstm.legacyOwner.v1");
    return !legacyOwner || legacyOwner === owner ? key : `${key}:${owner}`;
  } catch { return `${key}:${owner}`; }
}

export async function claimLegacyOwner(owner) {
  const claim = () => {
    if (!localStorage.getItem("redstm.legacyOwner.v1")) {
      const previous = localStorage.getItem("redstm.owner.v1");
      localStorage.setItem("redstm.legacyOwner.v1", /^[a-f0-9]{16}$/.test(previous ?? "") ? previous : owner);
    }
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request("redstm-legacy-owner", claim);
    else claim();
  } catch { /* A blocked localStorage does not invalidate the verified identity or its IDB. */ }
}

// Count decoded bytes while reading, before retaining an oversized gzip expansion in memory.
export async function readBackupText(file, limit = 64 * 1_048_576) {
  if (file.size > 16 * 1_048_576) throw new Error("상태 파일은 16MB 이하여야 합니다");
  const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream();
  if (header[0] === 0x1f && header[1] === 0x8b) {
    if (typeof DecompressionStream !== "function") throw new Error("이 브라우저는 압축된 백업을 열 수 없습니다");
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("백업을 풀면 허용 크기를 넘습니다 (최대 64MB)");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const boardPattern = /^[a-z0-9_]+$/;
const stablePostIdPattern = /^([a-z0-9_]+):([1-9]\d*)$/;
const objectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const themes = new Set(["system", "light", "dark"]);
const proseFonts = new Set(["serif", "gowun", "sans"]);
const readerSurfaces = new Set(["default", "paper", "ink"]);
const proseAlignments = new Set(["start", "justify"]);
const readingModes = new Set(["scroll", "page", "continuous"]);
const toggles = new Set(["off", "on"]);
const aaBackgroundPattern = /^#[0-9a-f]{6}$/i;
const BOOKMARK_NOTE_LIMIT = 1000;
const BOOKMARK_TAG_LIMIT = 10;
const BOOKMARK_TAG_LENGTH = 30;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function postIdentity(summary) {
  if (
    !summary || !boardPattern.test(summary.board_id) ||
    !Number.isInteger(summary.external_post_id) || summary.external_post_id < 1
  ) return "";
  return `${summary.board_id}:${summary.external_post_id}`;
}

export function samePost(left, right) {
  const identity = postIdentity(left);
  return Boolean(identity && identity === postIdentity(right));
}

function validStablePostId(value) {
  return stablePostIdPattern.test(value);
}

// A reading profile (DESIGN §10: 낮 · 밤 …) holds these settings; a work may use one by name (이 작품만).
export const PROFILE_KEYS = [
  "proseSize", "lineHeight", "proseWidth", "proseMargin", "paragraphSpacing", "textIndent", "proseFont", "proseAlign",
  "readerSurface", "readerDim", "readerWarm", "readingMode",
];
const PROFILE_LIMIT = 6;
const WORK_PROFILE_LIMIT = 300;

function sanitizeProfiles(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const profiles = [];
  for (const profile of value) {
    const name = typeof profile?.name === "string" ? profile.name.trim().slice(0, 12) : "";
    if (!name || seen.has(name)) continue;
    const source = isRecord(profile.values) ? profile.values : {};
    const checked = sanitizeSettings(Object.fromEntries(PROFILE_KEYS.filter((key) => key in source).map((key) => [key, source[key]])));
    const values = Object.fromEntries(PROFILE_KEYS.filter((key) => key in checked).map((key) => [key, checked[key]]));
    if (!Object.keys(values).length) continue;
    seen.add(name);
    profiles.push({ name, values });
    if (profiles.length === PROFILE_LIMIT) break;
  }
  return profiles;
}

function sanitizeWorkProfiles(value, profiles) {
  if (!isRecord(value)) return {};
  const names = new Set(profiles.map((profile) => profile.name));
  return Object.fromEntries(Object.entries(value)
    .filter(([key, name]) => key.length > 0 && key.length <= 300 && names.has(name))
    .slice(0, WORK_PROFILE_LIMIT));
}

function sanitizeSettings(value, defaults = {}) {
  const source = isRecord(value) ? value : {};
  const fallback = isRecord(defaults) ? defaults : {};
  const settings = {};
  const pick = (key, valid, transform = (selected) => selected) => {
    const selected = valid(source[key]) ? source[key] : fallback[key];
    if (valid(selected)) settings[key] = transform(selected);
  };

  pick("theme", (value) => themes.has(value));
  for (const [key, minimum, maximum] of [
    ["proseSize", 15, 28], ["lineHeight", 1.4, 2.2],
    ["proseWidth", 560, 960], ["proseMargin", 12, 32], ["aaSize", 9, 24], ["aaZoom", 0.1, 3],
    ["readerDim", 0, 60], ["readerWarm", 0, 25], ["paragraphSpacing", 0, 2], ["textIndent", 0, 2],
  ]) {
    pick(key, (value) => Number.isFinite(value) && value >= minimum && value <= maximum);
  }
  pick("proseFont", (value) => proseFonts.has(value));
  pick("proseAlign", (value) => proseAlignments.has(value));
  pick("readerSurface", (value) => readerSurfaces.has(value));
  pick("tapPaging", (value) => toggles.has(value));
  pick("homeQuote", (value) => toggles.has(value));
  pick("readingMode", (value) => readingModes.has(value));
  pick("aaAutoFit", (value) => toggles.has(value));
  pick("aaCanvasWidth", (value) => [null, 680, 800].includes(value));
  pick("aaBackground", (value) => typeof value === "string" && aaBackgroundPattern.test(value),
    (value) => value.toLowerCase());
  pick("aaPreserveStyles", (value) => typeof value === "boolean");
  pick("aaBold", (value) => typeof value === "boolean" || value === "light");
  pick("autoScrollSpeed", (value) => Number.isInteger(value) && value >= 1 && value <= 10);
  if ("readingProfiles" in source || "readingProfiles" in fallback) {
    const profiles = sanitizeProfiles(source.readingProfiles ?? fallback.readingProfiles);
    if (profiles.length) settings.readingProfiles = profiles;
    const works = sanitizeWorkProfiles(source.workProfiles ?? fallback.workProfiles, profiles);
    if (Object.keys(works).length) settings.workProfiles = works;
  }
  return settings;
}

export function readingLocationFields(value) {
  const fields = {};
  if (Number.isInteger(value?.offset) && value.offset >= 0) fields.offset = value.offset;
  if (Number.isFinite(value?.anchorTop)) fields.anchorTop = value.anchorTop;
  if (typeof value?.anchor === "string") fields.anchor = value.anchor.slice(0, 500);
  if (typeof value?.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)) fields.revision = value.revision;
  for (const key of ["documentId", "workId"]) {
    if (typeof value?.[key] === "string") fields[key] = value[key].slice(0, 300);
  }
  const loc = sanitizeLocator(value?.loc);
  if (loc) fields.loc = loc;
  return fields;
}

function timestampMap(value, timestampKey) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [identity, entry] of Object.entries(value)) {
    if (!validStablePostId(identity) || !isRecord(entry) || typeof entry[timestampKey] !== "string" ||
        Number.isNaN(Date.parse(entry[timestampKey]))) continue;
    result[identity] = { [timestampKey]: canonicalTime(entry[timestampKey]) };
    if (timestampKey === "readAt" && Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 1) {
      result[identity].progress = entry.progress;
    }
    if (timestampKey === "readAt") Object.assign(result[identity], readingLocationFields(entry));
  }
  return result;
}

export function sanitizeBookmarkMetadata(note, tags) {
  const sanitizedNote = typeof note === "string" ? note.trim().slice(0, BOOKMARK_NOTE_LIMIT) : "";
  const sanitizedTags = [];
  const seen = new Set();
  for (const value of Array.isArray(tags) ? tags : []) {
    if (typeof value !== "string") continue;
    const tag = value.trim().slice(0, BOOKMARK_TAG_LENGTH);
    const identity = tag.normalize("NFKC").toLocaleLowerCase("ko-KR");
    if (!tag || seen.has(identity)) continue;
    seen.add(identity);
    sanitizedTags.push(tag);
    if (sanitizedTags.length === BOOKMARK_TAG_LIMIT) break;
  }
  return { note: sanitizedNote, tags: sanitizedTags };
}

function bookmarkMap(value) {
  const result = timestampMap(value, "savedAt");
  for (const [identity, entry] of Object.entries(result)) {
    const metadata = sanitizeBookmarkMetadata(value[identity].note, value[identity].tags);
    if (metadata.note) entry.note = metadata.note;
    if (metadata.tags.length) entry.tags = metadata.tags;
  }
  return result;
}

function scrollMap(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([identity, offset]) =>
    validStablePostId(identity) && Number.isFinite(offset) && offset >= 0));
}

function viewModeMap(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([identity, mode]) =>
    validStablePostId(identity) && (mode === "aa" || mode === "prose")));
}

// Per-post AA view: the zoom chosen for that picture and how far it was moved sideways.
const AA_VIEW_LIMIT = 300;
function aaViewMap(value) {
  if (!isRecord(value)) return {};
  const views = [];
  for (const [identity, view] of Object.entries(value)) {
    if (!validStablePostId(identity) || !isRecord(view)) continue;
    const kept = {};
    if (Number.isFinite(view.zoom) && view.zoom >= 0.1 && view.zoom <= 3) kept.zoom = view.zoom;
    // 맞춤 (an automatic fit) and a manual zoom are kept apart (docs/24 §8.16).
    if (kept.zoom !== undefined && view.fit === true) kept.fit = true;
    if (Number.isFinite(view.left) && view.left >= 0) kept.left = Math.round(view.left);
    if (!Object.keys(kept).length) continue;
    kept.at = Number.isFinite(view.at) && view.at > 0 ? Math.round(view.at) : 0;
    views.push([identity, kept]);
  }
  views.sort((left, right) => right[1].at - left[1].at);
  return Object.fromEntries(views.slice(0, AA_VIEW_LIMIT));
}

function safeCatalogState(value) {
  if (!isRecord(value)) return null;
  const copy = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : undefined;
    if (Array.isArray(item)) return item.map(copy).filter((entry) => entry !== undefined);
    if (!isRecord(item)) return undefined;
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => key !== "object_key")
      .map(([key, entry]) => [key, copy(entry)])
      .filter(([, entry]) => entry !== undefined));
  };
  return copy(value);
}

export function defaultUserState(defaultSettings = {}) {
  return {
    schema_version: 2,
    settings: sanitizeSettings(defaultSettings),
    history: {},
    bookmarks: {},
    scroll: {},
    viewModes: {},
    aaViews: {},
    lastCatalogState: null,
  };
}

function legacyIdentity(entry) {
  const summary = entry?.summary;
  const identity = postIdentity(summary);
  const key = objectKeyPattern.exec(summary?.object_key ?? "");
  if (!identity || !key || key[1] !== summary.board_id || Number(key[2]) !== summary.external_post_id) {
    return "";
  }
  return identity;
}

export function migrateLegacyState({ settings, history, bookmarks } = {}, defaultSettings = {}) {
  const state = defaultUserState(defaultSettings);
  state.settings = sanitizeSettings(settings, state.settings);
  state.viewModes = viewModeMap(settings?.viewModes);

  for (const entry of Array.isArray(history) ? history : []) {
    const identity = legacyIdentity(entry);
    if (!identity || Number.isNaN(Date.parse(entry.readAt))) continue;
    state.history[identity] = { readAt: entry.readAt };
    if (Number.isFinite(entry.scroll) && entry.scroll >= 0) state.scroll[identity] = entry.scroll;
  }
  for (const entry of Array.isArray(bookmarks) ? bookmarks : []) {
    const identity = legacyIdentity(entry);
    if (!identity || Number.isNaN(Date.parse(entry.savedAt))) continue;
    state.bookmarks[identity] = { savedAt: entry.savedAt };
  }
  return state;
}

function normalizeV2State(value, defaultSettings = {}) {
  if (!isRecord(value) || value.schema_version !== 2) {
    throw new Error("지원하지 않는 상태 파일 형식");
  }
  return {
    schema_version: 2,
    settings: sanitizeSettings(value.settings, defaultSettings),
    history: timestampMap(value.history, "readAt"),
    bookmarks: bookmarkMap(value.bookmarks),
    scroll: scrollMap(value.scroll),
    viewModes: viewModeMap(value.viewModes),
    aaViews: aaViewMap(value.aaViews),
    lastCatalogState: safeCatalogState(value.lastCatalogState),
  };
}

const textIdentityPattern = /^(?:novel|arcalive|manual):[^\s]{1,300}$/;
const textHashPattern = /^[a-f0-9]{64}$/;
const textLanes = new Set(["novel", "arcalive", "manual"]);

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// Imported times written with a zone offset are kept as the same instant in UTC, so every later
// comparison and sort sees one notation (R01). Times this app wrote (UTC, "Z") stay as they are.
function canonicalTime(value) {
  return /Z$/i.test(value) ? value : new Date(value).toISOString();
}

// The text library's reading records and saved items (redstm.textState.v1). They live in their
// own localStorage key, so backups carry them as an optional `text` section.
export function sanitizeTextState(value) {
  const source = isRecord(value) ? value : {};
  const history = {};
  for (const [identity, record] of Object.entries(isRecord(source.history) ? source.history : {})) {
    if (!textIdentityPattern.test(identity) || !isRecord(record) || !validTimestamp(record.readAt)) continue;
    const kept = { readAt: canonicalTime(record.readAt), ...readingLocationFields(record) };
    if (Number.isFinite(record.progress) && record.progress >= 0 && record.progress <= 1) kept.progress = record.progress;
    if (Number.isFinite(record.scroll) && record.scroll >= 0) kept.scroll = record.scroll;
    if (Number.isInteger(record.total) && record.total >= 0) kept.total = record.total;
    for (const key of ["title", "work", "workId", "chapterId"]) {
      if (typeof record[key] === "string") kept[key] = record[key].slice(0, 300);
    }
    for (const key of ["route", "listRoute"]) {
      if (typeof record[key] === "string" && record[key].startsWith("/text?")) kept[key] = record[key].slice(0, 2000);
    }
    history[identity] = kept;
  }
  const bookmarks = {};
  for (const [identity, saved] of Object.entries(isRecord(source.bookmarks) ? source.bookmarks : {})) {
    if (
      !textIdentityPattern.test(identity) || !isRecord(saved) || !validTimestamp(saved.savedAt) ||
      !textLanes.has(saved.lane) || !isRecord(saved.entry) || !textHashPattern.test(saved.entry.sha256 ?? "")
    ) continue;
    const kept = { savedAt: canonicalTime(saved.savedAt), lane: saved.lane, entry: safeCatalogState(saved.entry) };
    if (isRecord(saved.work)) kept.work = safeCatalogState(saved.work);
    if (typeof saved.title === "string") kept.title = saved.title.slice(0, 300);
    const metadata = sanitizeBookmarkMetadata(saved.note, saved.tags);
    if (metadata.note) kept.note = metadata.note;
    if (metadata.tags.length) kept.tags = metadata.tags;
    bookmarks[identity] = kept;
  }
  // Personal shelves ride along only when the source has them (older backups do not).
  return { schema_version: 1, history, bookmarks, ...(Array.isArray(source.shelves) ? sanitizeShelfState(source) : {}) };
}

export const BACKUP_FORMAT = "redstm-backup";

// The backup file people download: the TypeMoon reading state and the text library's state
// (history, bookmarks, shelves) as separate sections, normalized and indented for reading.
// Schema 4 adds `records` — the owner's marks and notes (tombstones included) and reading
// sessions — when this device has them; without them the file stays schema 3.
export function exportUserState(state, textState = null, { exportedAt = new Date().toISOString(), records = null } = {}) {
  const { schema_version: _version, ...typemoon } = normalizeV2State(state, state?.settings);
  return `${JSON.stringify({
    format: BACKUP_FORMAT,
    schema_version: records ? 4 : 3,
    exported_at: exportedAt,
    typemoon,
    ...(textState ? { text: sanitizeTextState(textState) } : {}),
    ...(records ? { records: sanitizeRecords(records) } : {}),
  }, null, 2)}\n`;
}

// Times are compared as instants, not as text: "09:00+09:00" is earlier than "00:30Z" on the same
// day (R01). An unreadable time loses; an equal time keeps the record already here.
function instant(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function newer(left, right, key) {
  return instant(right?.[key]) > instant(left?.[key]);
}

const recordIdPattern = /^[A-Za-z0-9-]{1,100}$/;
const shortText = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

function sanitizeAnnotation(value) {
  if (!isRecord(value) || !recordIdPattern.test(value.id ?? "") || typeof value.documentId !== "string" || !value.documentId) return null;
  const locator = sanitizeLocator(value.locator);
  if (!locator || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) return null;
  const kind = value.kind === "note" ? "note" : "mark";
  const context = isRecord(value.context) ? value.context : {};
  return {
    id: value.id, documentId: value.documentId.slice(0, 300), workId: shortText(value.workId, 300), locator, quote: locator.exact,
    note: shortText(value.note, BOOKMARK_NOTE_LIMIT), tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string").slice(0, BOOKMARK_TAG_LIMIT).map((tag) => tag.slice(0, BOOKMARK_TAG_LENGTH)) : [],
    kind,
    context: {
      title: shortText(context.title, 300), work: shortText(context.work, 300),
      route: typeof context.route === "string" && context.route.startsWith("/") ? context.route.slice(0, 1000) : "",
    },
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(validTimestamp(value.deletedAt) ? { deletedAt: value.deletedAt } : {}),
    ...(recordIdPattern.test(value.conflictOf ?? "") ? { conflictOf: value.conflictOf } : {}),
  };
}

function sanitizeSession(value) {
  if (!isRecord(value) || !recordIdPattern.test(value.id ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(value.day ?? "")) return null;
  const spans = Array.isArray(value.spans)
    ? value.spans.filter((span) => Array.isArray(span) && Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[1] > span[0]).slice(0, 2000)
      .map(([start, end]) => [start, end])
    : [];
  if (!spans.length) return null;
  return {
    id: value.id, deviceId: shortText(value.deviceId, 100), workKey: shortText(value.workKey, 300), documentId: shortText(value.documentId, 300),
    day: value.day, start: spans[0][0], end: spans.at(-1)[1], spans,
    activeMs: Number.isFinite(value.activeMs) && value.activeMs >= 0 ? value.activeMs : 0,
    chars: Number.isFinite(value.chars) && value.chars >= 0 ? Math.round(value.chars) : 0, endOfWork: value.endOfWork === true,
  };
}

export function sanitizeRecords(value) {
  const source = isRecord(value) ? value : {};
  const list = (items, sanitize) => (Array.isArray(items) ? items.map(sanitize).filter(Boolean) : []);
  return { annotations: list(source.annotations, sanitizeAnnotation), sessions: list(source.sessions, sanitizeSession),
    ...(Array.isArray(source.works) ? { works: list(source.works, sanitizeWorkStyle) } : {}),
    ...(isRecord(source.library) ? { library: sanitizeLibrary(source.library) } : {}),
  };
}

// Marks and notes from a backup, merged into this device's (T22). A deletion is permanent: once
// either side has a tombstone the record stays deleted. Otherwise the later edit wins, and when the
// two sides were edited differently the other edit is kept beside it as a 충돌 사본 (P5-2) instead
// of being lost. Returns only the records that change, ready to write in one transaction.
const sameEdit = (left, right) => left.note === right.note && left.kind === right.kind &&
  JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []);
const conflictId = (record) => `${record.id.slice(0, 80)}-c${instant(record.updatedAt).toString(36)}`.slice(0, 100);

export function mergeAnnotationRecords(current, incoming) {
  const mine = new Map(current.map((record) => [record.id, record]));
  const changes = [];
  for (const record of incoming) {
    const here = mine.get(record.id);
    if (!here) {
      changes.push(record);
      continue;
    }
    if (here.deletedAt) continue;
    if (record.deletedAt) {
      changes.push({ ...here, ...record });
      continue;
    }
    if (sameEdit(here, record)) {
      if (newer(here, record, "updatedAt")) changes.push(record);
      continue;
    }
    const [winner, loser] = newer(here, record, "updatedAt") ? [record, here] : [here, record];
    if (winner === record) changes.push(record);
    const copy = { ...loser, id: conflictId(loser), conflictOf: loser.id };
    if (!mine.has(copy.id)) changes.push(copy);
  }
  return changes;
}

// Reading sessions: the same session keeps the copy that reaches further.
export function mergeSessionRecords(current, incoming) {
  const mine = new Map(current.map((session) => [session.id, session]));
  return incoming.filter((session) => !mine.has(session.id) || session.end > mine.get(session.id).end);
}

// 합쳐서 가져오기: each post keeps its most recent reading record (and the furthest progress),
// saved posts and view choices are united, and this browser's settings stay.
export function mergeUserStates(current, incoming) {
  const merged = normalizeV2State(current, current?.settings);
  const other = normalizeV2State(incoming, current?.settings);
  for (const [identity, record] of Object.entries(other.history)) {
    const mine = merged.history[identity];
    const progress = Math.max(mine?.progress ?? 0, record.progress ?? 0);
    if (!mine || newer(mine, record, "readAt")) {
      merged.history[identity] = { ...record };
      if (other.scroll[identity] !== undefined) merged.scroll[identity] = other.scroll[identity];
    }
    if (progress > 0) merged.history[identity].progress = progress;
  }
  for (const [identity, saved] of Object.entries(other.bookmarks)) {
    if (!merged.bookmarks[identity] || newer(merged.bookmarks[identity], saved, "savedAt")) merged.bookmarks[identity] = saved;
  }
  merged.viewModes = { ...other.viewModes, ...merged.viewModes };
  for (const [identity, view] of Object.entries(other.aaViews)) {
    if (!merged.aaViews[identity] || (view.at ?? 0) > (merged.aaViews[identity].at ?? 0)) merged.aaViews[identity] = view;
  }
  return normalizeV2State(merged, current?.settings);
}

// The same for the text library; shelves with the same name become one.
export function mergeTextStates(current, incoming) {
  const merged = sanitizeTextState(current);
  const other = sanitizeTextState(incoming);
  for (const [identity, record] of Object.entries(other.history)) {
    const mine = merged.history[identity];
    const progress = Math.max(mine?.progress ?? 0, record.progress ?? 0);
    if (!mine || newer(mine, record, "readAt")) merged.history[identity] = { ...record };
    if (progress > 0) merged.history[identity].progress = progress;
  }
  for (const [identity, saved] of Object.entries(other.bookmarks)) {
    if (!merged.bookmarks[identity] || newer(merged.bookmarks[identity], saved, "savedAt")) merged.bookmarks[identity] = saved;
  }
  if (Array.isArray(other.shelves)) {
    const shelves = mergeShelfState(
      { shelves: merged.shelves ?? [], workShelves: merged.workShelves ?? {} },
      { shelves: other.shelves, workShelves: other.workShelves },
    );
    merged.shelves = shelves.shelves;
    merged.workShelves = shelves.workShelves;
  }
  return merged;
}

// Bound history and its pixel positions by UTF-16 storage size, including sentence locators.
// Keep the most recently read records; bookmarks have their own lifetime.
export function limitHistoryForStorage(state, limit = 1_048_576) {
  const history = {};
  const scroll = {};
  let size = 4;
  const records = Object.entries(state.history).sort((a, b) => Date.parse(b[1].readAt) - Date.parse(a[1].readAt));
  for (const [identity, record] of records) {
    const offset = state.scroll[identity] ?? 0;
    const bytes = 2 * (JSON.stringify(identity).length * 2 + JSON.stringify(record).length + JSON.stringify(offset).length + 4);
    if (size + bytes > limit) break;
    size += bytes;
    history[identity] = record;
    scroll[identity] = offset;
  }
  return { ...state, history, scroll };
}

// The localStorage copy: the same normalized state without indentation. It is rewritten on
// every scroll save, so its size matters more than its readability.
export function serializeUserState(state) {
  return JSON.stringify(normalizeV2State(state, state?.settings));
}

export function planImport(text, defaultSettings = {}) {
  const payload = JSON.parse(text);
  const suppliedSettings = sanitizeSettings(payload?.schema_version >= 3 ? payload?.typemoon?.settings : payload?.settings);
  const defaultedSettings = Object.keys(sanitizeSettings(defaultSettings))
    .filter((key) => !(key in suppliedSettings));
  let state;
  if (payload?.schema_version === 1) {
    state = migrateLegacyState(payload, defaultSettings);
  } else if (payload?.schema_version === 2) {
    state = normalizeV2State(payload, defaultSettings);
  } else if ((payload?.schema_version === 3 || payload?.schema_version === 4) && payload.format === BACKUP_FORMAT && isRecord(payload.typemoon)) {
    state = normalizeV2State({ ...payload.typemoon, schema_version: 2 }, defaultSettings);
  } else {
    throw new Error("지원하지 않는 상태 파일 형식");
  }
  // Files exported before the text library existed have no `text`; importing them keeps the
  // text reading records already in this browser.
  const textState = payload?.schema_version >= 2 && isRecord(payload.text) ? sanitizeTextState(payload.text) : null;
  const records = payload?.schema_version === 4 && isRecord(payload.records) ? sanitizeRecords(payload.records) : null;
  return {
    state,
    text: textState,
    records,
    summary: {
      history: Object.keys(state.history).length,
      bookmarks: Object.keys(state.bookmarks).length,
      scroll: Object.keys(state.scroll).length,
      viewModes: Object.keys(state.viewModes).length,
      textHistory: textState ? Object.keys(textState.history).length : null,
      textBookmarks: textState ? Object.keys(textState.bookmarks).length : null,
      shelves: textState?.shelves ? textState.shelves.length : null,
      exportedAt: payload?.schema_version >= 3 && typeof payload.exported_at === "string" ? payload.exported_at : null,
      annotations: records ? records.annotations.filter((record) => !record.deletedAt).length : null,
      sessions: records ? records.sessions.length : null,
      defaultedSettings,
    },
  };
}
