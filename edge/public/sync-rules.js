// Device sync (docs/24 §12.7): the rules the Worker and the page share, so both settle a key the
// same way. A synced value is {at, data} or the tombstone {at, deleted: true}; `at` is the time of
// the reading action the entry records (when it was read, saved, marked) or, for an entry without
// such a time, when this device changed it.

// tm.* — TypeMoon reading state, text.* — the text library's, then the owner's IndexedDB records.
const KEY_PATTERN = /^(?:(?:tm\.h|tm\.b|tm\.view|text\.h|text\.b):[^\s]{1,400}|(?:tm\.later|text\.hidden):[^\s]{1,420}|text\.shelves|library|annotation:[A-Za-z0-9-]{1,100}|session:[A-Za-z0-9-]{1,100}|work:[^\s]{1,300})$/;
export const SYNC_VALUE_MAX_CHARS = 128 * 1024;

export function validSyncKey(key) {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validSyncValue(value) {
  if (!isRecord(value) || !Number.isFinite(value.at) || value.at < 0) return false;
  if (value.deleted === true) return Object.keys(value).length === 2;
  return isRecord(value.data) && Object.keys(value).length === 2;
}

// Key order does not matter: two equal entries written by different code paths compare equal.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isHistory = (key) => key.startsWith("tm.h:") || key.startsWith("text.h:");

// The value a key keeps when `incoming` reaches a store holding `stored`.
// - A deleted mark or note stays deleted (an old device cannot bring it back, T12).
// - Otherwise the later action wins; the same time is settled by content, so every side agrees.
// - A reading record keeps the furthest progress either side reached (docs/24 §12.7 maxProgress).
export function resolveSync(key, stored, incoming) {
  if (!stored) return incoming;
  if (key.startsWith("annotation:")) {
    if (stored.data?.deletedAt) return stored;
    if (incoming.data?.deletedAt) return incoming;
  }
  const order = incoming.at - stored.at || (stableJson(incoming) > stableJson(stored) ? 1 : stableJson(incoming) < stableJson(stored) ? -1 : 0);
  let winner = order > 0 ? incoming : stored;
  if (isHistory(key) && !stored.deleted && !incoming.deleted) {
    const progress = Math.max(stored.data.progress ?? 0, incoming.data.progress ?? 0);
    if (progress > (winner.data.progress ?? 0)) winner = { at: winner.at, data: { ...winner.data, progress } };
  }
  return winner;
}
