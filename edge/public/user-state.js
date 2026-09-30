import { sanitizeShelfState } from "./text-shelves.js";

export const STATE_KEY = "redstm.userState.v2";

const boardPattern = /^[a-z0-9_]+$/;
const stablePostIdPattern = /^([a-z0-9_]+):([1-9]\d*)$/;
const objectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const themes = new Set(["system", "light", "dark"]);
const proseFonts = new Set(["serif", "sans"]);
const readerSurfaces = new Set(["default", "paper"]);
const proseAlignments = new Set(["start", "justify"]);
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
  ]) {
    pick(key, (value) => Number.isFinite(value) && value >= minimum && value <= maximum);
  }
  pick("proseFont", (value) => proseFonts.has(value));
  pick("proseAlign", (value) => proseAlignments.has(value));
  pick("readerSurface", (value) => readerSurfaces.has(value));
  pick("tapPaging", (value) => toggles.has(value));
  pick("aaAutoFit", (value) => toggles.has(value));
  pick("aaCanvasWidth", (value) => [null, 680, 800].includes(value));
  pick("aaBackground", (value) => typeof value === "string" && aaBackgroundPattern.test(value),
    (value) => value.toLowerCase());
  pick("aaPreserveStyles", (value) => typeof value === "boolean");
  return settings;
}

function timestampMap(value, timestampKey) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [identity, entry] of Object.entries(value)) {
    if (!validStablePostId(identity) || !isRecord(entry) || typeof entry[timestampKey] !== "string" ||
        Number.isNaN(Date.parse(entry[timestampKey]))) continue;
    result[identity] = { [timestampKey]: entry[timestampKey] };
    if (timestampKey === "readAt" && Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 1) {
      result[identity].progress = entry.progress;
    }
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

const textIdentityPattern = /^(?:novel|arcalive):[^\s]{1,300}$/;
const textHashPattern = /^[a-f0-9]{64}$/;
const textLanes = new Set(["novel", "arcalive"]);

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

// The text library's reading records and saved items (redstm.textState.v1). They live in their
// own localStorage key, so backups carry them as an optional `text` section.
export function sanitizeTextState(value) {
  const source = isRecord(value) ? value : {};
  const history = {};
  for (const [identity, record] of Object.entries(isRecord(source.history) ? source.history : {})) {
    if (!textIdentityPattern.test(identity) || !isRecord(record) || !validTimestamp(record.readAt)) continue;
    const kept = { readAt: record.readAt };
    if (Number.isFinite(record.progress) && record.progress >= 0 && record.progress <= 1) kept.progress = record.progress;
    if (Number.isFinite(record.scroll) && record.scroll >= 0) kept.scroll = record.scroll;
    if (Number.isInteger(record.offset) && record.offset >= 0) kept.offset = record.offset;
    if (Number.isFinite(record.anchorTop)) kept.anchorTop = record.anchorTop;
    if (Number.isInteger(record.total) && record.total >= 0) kept.total = record.total;
    for (const key of ["title", "work", "workId", "chapterId"]) {
      if (typeof record[key] === "string") kept[key] = record[key].slice(0, 300);
    }
    if (typeof record.anchor === "string") kept.anchor = record.anchor.slice(0, 500);
    if (typeof record.revision === "string" && textHashPattern.test(record.revision)) kept.revision = record.revision;
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
    const kept = { savedAt: saved.savedAt, lane: saved.lane, entry: safeCatalogState(saved.entry) };
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

// The backup file people download: normalized and indented for reading. The text library's
// state rides along when given.
export function exportUserState(state, textState = null) {
  const normalized = normalizeV2State(state, state?.settings);
  if (textState) normalized.text = sanitizeTextState(textState);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

// The localStorage copy: the same normalized state without indentation. It is rewritten on
// every scroll save, so its size matters more than its readability.
export function serializeUserState(state) {
  return JSON.stringify(normalizeV2State(state, state?.settings));
}

export function planImport(text, defaultSettings = {}) {
  const payload = JSON.parse(text);
  const suppliedSettings = sanitizeSettings(payload?.settings);
  const defaultedSettings = Object.keys(sanitizeSettings(defaultSettings))
    .filter((key) => !(key in suppliedSettings));
  let state;
  if (payload?.schema_version === 1) {
    state = migrateLegacyState(payload, defaultSettings);
  } else if (payload?.schema_version === 2) {
    state = normalizeV2State(payload, defaultSettings);
  } else {
    throw new Error("지원하지 않는 상태 파일 형식");
  }
  // Files exported before the text library existed have no `text`; importing them keeps the
  // text reading records already in this browser.
  const textState = payload?.schema_version === 2 && isRecord(payload.text) ? sanitizeTextState(payload.text) : null;
  return {
    state,
    text: textState,
    summary: {
      history: Object.keys(state.history).length,
      bookmarks: Object.keys(state.bookmarks).length,
      scroll: Object.keys(state.scroll).length,
      viewModes: Object.keys(state.viewModes).length,
      textHistory: textState ? Object.keys(textState.history).length : null,
      textBookmarks: textState ? Object.keys(textState.bookmarks).length : null,
      defaultedSettings,
    },
  };
}
