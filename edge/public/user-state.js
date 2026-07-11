const boardPattern = /^[a-z0-9_]+$/;
// Accept both extensions so state files exported before the zstd transport
// switch keep importing; the current exporter emits .json.zst keys.
const objectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const themes = new Set(["system", "light", "dark"]);

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

function validEntry(entry, timestampKey) {
  const summary = entry?.summary;
  const objectKey = objectKeyPattern.exec(summary?.object_key ?? "");
  return Boolean(
    postIdentity(summary) && objectKey && objectKey[1] === summary.board_id &&
    Number(objectKey[2]) === summary.external_post_id &&
    !Number.isNaN(Date.parse(entry[timestampKey])),
  );
}

function mergeEntries(current, incoming, timestampKey, limit) {
  const merged = new Map();
  for (const entry of [...current, ...incoming]) {
    if (!validEntry(entry, timestampKey)) continue;
    const key = postIdentity(entry.summary);
    const previous = merged.get(key);
    if (!previous || Date.parse(entry[timestampKey]) > Date.parse(previous[timestampKey])) {
      merged.set(key, entry);
    }
  }
  return [...merged.values()]
    .sort((left, right) => Date.parse(right[timestampKey]) - Date.parse(left[timestampKey]))
    .slice(0, limit);
}

function importedSettings(value, defaults) {
  if (!value || typeof value !== "object") return { ...defaults };
  const settings = { ...defaults };
  if (themes.has(value.theme)) settings.theme = value.theme;
  for (const [key, minimum, maximum] of [
    ["proseSize", 15, 24], ["lineHeight", 1.4, 2.2],
    ["proseWidth", 560, 960], ["aaSize", 9, 20],
  ]) {
    if (Number.isFinite(value[key]) && value[key] >= minimum && value[key] <= maximum) {
      settings[key] = value[key];
    }
  }
  return settings;
}

export function exportUserState(settings, history, bookmarks) {
  return `${JSON.stringify({
    schema_version: 1,
    exported_at: new Date().toISOString(),
    settings,
    history,
    bookmarks,
  }, null, 2)}\n`;
}

export function importUserState(text, current, defaults) {
  const payload = JSON.parse(text);
  if (payload?.schema_version !== 1) throw new Error("지원하지 않는 상태 파일 형식");
  return {
    settings: importedSettings(payload.settings, defaults),
    history: mergeEntries(current.history, payload.history ?? [], "readAt", 500),
    bookmarks: mergeEntries(current.bookmarks, payload.bookmarks ?? [], "savedAt", 5_000),
  };
}
