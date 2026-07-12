export const STATE_KEY = "redstm.userState.v2";

const boardPattern = /^[a-z0-9_]+$/;
const stablePostIdPattern = /^([a-z0-9_]+):([1-9]\d*)$/;
const objectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const themes = new Set(["system", "light", "dark"]);
const proseFonts = new Set(["serif", "sans"]);
const aaBackgroundPattern = /^#[0-9a-f]{6}$/i;

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
    ["proseSize", 15, 24], ["lineHeight", 1.4, 2.2],
    ["proseWidth", 560, 960], ["aaSize", 9, 24], ["aaZoom", 0.1, 3],
  ]) {
    pick(key, (value) => Number.isFinite(value) && value >= minimum && value <= maximum);
  }
  pick("proseFont", (value) => proseFonts.has(value));
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
    if (!validStablePostId(identity) || !isRecord(entry) ||
        Number.isNaN(Date.parse(entry[timestampKey]))) continue;
    result[identity] = { [timestampKey]: entry[timestampKey] };
    if (timestampKey === "readAt" && Number.isFinite(entry.progress) && entry.progress >= 0 && entry.progress <= 1) {
      result[identity].progress = entry.progress;
    }
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
    bookmarks: timestampMap(value.bookmarks, "savedAt"),
    scroll: scrollMap(value.scroll),
    viewModes: viewModeMap(value.viewModes),
    lastCatalogState: safeCatalogState(value.lastCatalogState),
  };
}

export function exportUserState(state) {
  const normalized = normalizeV2State(state, state?.settings);
  return `${JSON.stringify(normalized, null, 2)}\n`;
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
  return {
    state,
    summary: {
      history: Object.keys(state.history).length,
      bookmarks: Object.keys(state.bookmarks).length,
      scroll: Object.keys(state.scroll).length,
      viewModes: Object.keys(state.viewModes).length,
      defaultedSettings,
    },
  };
}
