// Device sync (docs/24 §12.7): the owner's reading records follow them to every signed-in device.
// Each record becomes one key (sync-rules.js); a sync compares this device's records with the last
// server values it saw, pulls what other devices changed, settles both sides with the shared rules
// and pushes what is left. Display settings stay per device (font size differs on a phone).
import { resolveSync, stableJson } from "./sync-rules.js";
import { mergeShelfState } from "./text-shelves.js";

const PUSH_BATCH = 100;
// A family that empties at once while the server still holds this many of its entries lost its
// storage (site data cleared, another browser profile); it is restored instead of deleted everywhere.
const STORAGE_LOSS_MIN = 3;
const ENTRY_FAMILIES = ["tm.h", "tm.b", "tm.later", "tm.view", "text.h", "text.b", "text.hidden"];
const HISTORY_FAMILIES = new Set(["tm.h", "text.h"]);

const time = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const familyOf = (key) => (key.includes(":") ? key.slice(0, key.indexOf(":")) : key);

// When the action an entry records happened, or 0 for entries without such a time.
export function intrinsicTime(key, data) {
  switch (familyOf(key)) {
    case "tm.h": case "text.h": return time(data.readAt);
    case "tm.b": case "text.b": return time(data.savedAt);
    case "tm.later": case "text.hidden": return time(data.at);
    case "annotation": case "work": return Math.max(time(data.updatedAt), time(data.deletedAt));
    case "session": return Number.isFinite(data.end) ? data.end : 0;
    case "library": return time(data.updatedAt);
    default: return 0;
  }
}

// This device's records as sync keys. userState is the TypeMoon state (schema 2), textState the text
// library's (schema 1), records the owner's IndexedDB stores.
export function stateEntries({ userState, textState, records = {} }) {
  const entries = new Map();
  const add = (prefix, map, shape = (value) => value) => {
    for (const [id, value] of Object.entries(isRecord(map) ? map : {})) {
      if (isRecord(value) || typeof value === "string") entries.set(`${prefix}:${id}`, shape(value, id));
    }
  };
  if (userState) {
    add("tm.h", userState.history, (record, id) => (Number.isFinite(userState.scroll?.[id]) && userState.scroll[id] > 0
      ? { ...record, scroll: userState.scroll[id] } : { ...record }));
    add("tm.b", userState.bookmarks);
    add("tm.later", userState.later);
    add("tm.view", userState.viewModes, (mode) => ({ mode }));
  }
  if (textState) {
    add("text.h", textState.history);
    add("text.b", textState.bookmarks);
    add("text.hidden", textState.hidden);
    if (Array.isArray(textState.shelves)) entries.set("text.shelves", { shelves: textState.shelves, workShelves: textState.workShelves ?? {} });
  }
  for (const record of records.annotations ?? []) entries.set(`annotation:${record.id}`, record);
  for (const record of records.sessions ?? []) entries.set(`session:${record.id}`, record);
  for (const record of records.works ?? []) entries.set(`work:${record.workKey}`, record);
  if (records.library) entries.set("library", records.library);
  return entries;
}

// What this device last agreed with the server on, per key: `v` the server value, `echo` how the
// entry looked here once applied (null: not kept here). Comparing with the echo, a field an older app
// version drops or a record pruned for space is not mistaken for this device's own change.
function baseline(known) {
  if (!known) return null;
  if (known.echo !== undefined) return known.echo;
  return known.v.deleted ? null : stableJson(known.v.data);
}

// The values this device would push: every entry changed since the last sync, and deletions of
// entries it had agreed on. `at` is the reading action's time when the entry records a newer one;
// otherwise (an edited note, a changed view) the change happens now and comes after what it saw.
export function planCandidates(entries, base, now, initialized) {
  const candidates = new Map();
  for (const [key, data] of entries) {
    const known = base[key];
    if (stableJson(data) === baseline(known)) continue;
    const own = intrinsicTime(key, data);
    let at;
    if (!known) at = own || (initialized ? now : 0);
    else if (known.v.deleted) at = own || Math.max(now, known.v.at + 1);
    else if (own > intrinsicTime(key, known.v.data)) at = own;
    else at = Math.max(now, known.v.at + 1);
    candidates.set(key, { at, data });
  }
  const restore = new Map();
  for (const prefix of ENTRY_FAMILIES) {
    const local = [...entries.keys()].filter((key) => familyOf(key) === prefix);
    const agreed = Object.entries(base).filter(([key, known]) => familyOf(key) === prefix && !known.v.deleted);
    const missing = agreed.filter(([key, known]) => !entries.has(key) && baseline(known) !== null);
    if (!missing.length) continue;
    if (!local.length && agreed.length >= STORAGE_LOSS_MIN) {
      for (const [key, known] of agreed) restore.set(key, known.v);
      continue;
    }
    const oldestKept = HISTORY_FAMILIES.has(prefix) ? Math.min(...local.map((key) => intrinsicTime(key, entries.get(key)))) : Number.NEGATIVE_INFINITY;
    for (const [key, known] of missing) {
      // Older than every record kept here: pruned for space, not deleted by the reader.
      if (intrinsicTime(key, known.v.data) < oldestKept) continue;
      candidates.set(key, { at: Math.max(now, known.v.at + 1), deleted: true });
    }
  }
  return { candidates, restore };
}

// A pulled row against this device: an unsent change settles with it by the shared rule; otherwise
// the row is taken as it is. Returns the value this device should now hold, or undefined to keep.
export function settleRow(row, candidates, entries, now, initialized) {
  const candidate = candidates.get(row.key);
  if (candidate) {
    if (row.key === "text.shelves" && !initialized && !row.value.deleted && !candidate.deleted) {
      // A first sync unites shelves by name instead of keeping one device's list.
      const merged = mergeShelfState(structuredClone(row.value.data), candidate.data);
      const data = { shelves: merged.shelves, workShelves: merged.workShelves };
      if (stableJson(data) === stableJson(row.value.data)) {
        candidates.delete(row.key);
        return stableJson(candidate.data) === stableJson(data) ? undefined : row.value;
      }
      const value = { at: Math.max(now, row.value.at + 1), data };
      candidates.set(row.key, value);
      return value;
    }
    const winner = resolveSync(row.key, row.value, candidate);
    if (stableJson(winner) === stableJson(candidate)) return undefined;
    if (stableJson(winner) === stableJson(row.value)) candidates.delete(row.key);
    else candidates.set(row.key, winner);
    return winner;
  }
  const local = entries.get(row.key);
  if (row.value.deleted) return local === undefined ? undefined : row.value;
  return local !== undefined && stableJson(local) === stableJson(row.value.data) ? undefined : row.value;
}

// Server values applied to this device's states. Returns the states that changed and the records
// to write; a record's own tombstone (deletedAt) is a value, so a sync tombstone never removes one.
export function applyEntries({ userState, textState }, changes) {
  let tm = null;
  let text = null;
  const records = [];
  const userCopy = () => (tm ??= structuredClone(userState));
  const textCopy = () => (text ??= structuredClone(textState));
  for (const [key, value] of changes) {
    const prefix = familyOf(key);
    const id = key.slice(prefix.length + 1);
    const data = value.deleted ? null : value.data;
    if (prefix === "tm.h") {
      const state = userCopy();
      if (data) {
        const { scroll, ...record } = data;
        state.history[id] = record;
        if (Number.isFinite(scroll)) state.scroll[id] = scroll;
        else delete state.scroll[id];
      } else {
        delete state.history[id];
        delete state.scroll[id];
      }
    } else if (prefix === "tm.b" || prefix === "tm.later" || prefix === "tm.view") {
      const state = userCopy();
      const field = { "tm.b": "bookmarks", "tm.later": "later", "tm.view": "viewModes" }[prefix];
      state[field] ??= {};
      if (data) state[field][id] = prefix === "tm.view" ? data.mode : data;
      else delete state[field][id];
    } else if (prefix === "text.h" || prefix === "text.b" || prefix === "text.hidden") {
      const state = textCopy();
      const field = { "text.h": "history", "text.b": "bookmarks", "text.hidden": "hidden" }[prefix];
      state[field] ??= {};
      if (data) state[field][id] = data;
      else delete state[field][id];
    } else if (prefix === "text.shelves") {
      if (data) Object.assign(textCopy(), { shelves: data.shelves, workShelves: data.workShelves ?? {} });
    } else if (data && prefix === "annotation") records.push({ store: "annotations", value: data });
    else if (data && prefix === "session") records.push({ store: "sessions", value: data });
    else if (data && prefix === "work") records.push({ store: "works", value: data });
    else if (data && prefix === "library") records.push({ store: "meta", value: data });
  }
  return { userState: tm, textState: text, records };
}

// A mark or note edited here that lost to a different edit elsewhere: kept beside the winner as a
// 충돌 사본 (P5-2) instead of being lost. A deletion on either side is not a conflict.
function lostEdit(key, mine, kept) {
  if (!key.startsWith("annotation:") || !mine || mine.deleted || kept.deleted || mine.data.deletedAt || kept.data?.deletedAt) return null;
  const same = (left, right) => left.note === right.note && left.kind === right.kind && stableJson(left.tags ?? []) === stableJson(right.tags ?? []);
  return same(mine.data, kept.data) ? null : mine.data;
}

export class SyncError extends Error {
  constructor(kind, message = kind) {
    super(message);
    this.kind = kind;
  }
}

async function call(fetchImpl, path, init = {}) {
  let response;
  try {
    response = await fetchImpl(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } });
  } catch {
    throw new SyncError("offline");
  }
  const json = (response.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json");
  // An Access sign-in page (a redirect or HTML) means the session ended; a JSON 403 that sync is not
  // available for this account.
  if (response.redirected || (!json && [200, 401, 403].includes(response.status))) throw new SyncError("auth");
  const body = json ? await response.json().catch(() => null) : null;
  if (response.status === 403) throw new SyncError("unavailable");
  if (!response.ok || !body) throw new SyncError(response.status >= 500 ? "server" : "rejected", `HTTP ${response.status}`);
  return body;
}

// One sync run. `local` reads and writes this device's records:
//   read() → { userState, textState, records }; apply(changes) writes server values here.
// `meta` keeps {rev, initialized, base} between runs. Returns counts for the status line.
export async function syncOnce({ fetchImpl = fetch, local, meta, deviceId, now = () => Date.now() }) {
  const saved = (await meta.get()) ?? { rev: 0, initialized: false, base: {} };
  const base = { ...saved.base };
  const startedAt = now();
  const before = stateEntries(await local.read());
  const { candidates, restore } = planCandidates(before, base, startedAt, saved.initialized);
  const adopt = new Map(restore);
  const conflicts = [];
  let rev = saved.rev;
  let pulled = 0;
  for (let more = true; more;) {
    const page = await call(fetchImpl, `/api/v1/sync/pull?since=${rev}`);
    for (const row of page.rows) {
      pulled += 1;
      base[row.key] = { v: row.value };
      const mine = candidates.get(row.key);
      const value = settleRow(row, candidates, before, startedAt, saved.initialized);
      if (value !== undefined) adopt.set(row.key, value);
      else adopt.delete(row.key);
      const lost = value !== undefined && lostEdit(row.key, mine, value);
      if (lost) conflicts.push(lost);
    }
    rev = page.rev;
    more = page.more === true;
  }
  // Values already adopted from a pull are not sent back unless the settlement changed them.
  const ops = [...candidates].map(([key, value]) => ({ opId: crypto.randomUUID(), key, value }));
  const pushedValues = new Map(ops.map((op) => [op.key, op.value]));
  for (let index = 0; index < ops.length; index += PUSH_BATCH) {
    const answer = await call(fetchImpl, "/api/v1/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, ops: ops.slice(index, index + PUSH_BATCH) }),
    });
    for (const row of answer.rows) {
      base[row.key] = { v: row.value };
      const sent = pushedValues.get(row.key);
      if (sent && stableJson(row.value) === stableJson(sent)) {
        // Kept as sent: this device already shows it.
        if (!adopt.has(row.key)) base[row.key].echo = sent.deleted ? null : stableJson(sent.data);
        continue;
      }
      adopt.set(row.key, row.value);
      const lost = lostEdit(row.key, sent, row.value);
      if (lost) conflicts.push(lost);
    }
  }
  if (adopt.size || conflicts.length) await local.apply(adopt, conflicts);
  // How each adopted entry looks here now (null: not kept, e.g. pruned or refused by this version).
  if (adopt.size) {
    const after = stateEntries(await local.read());
    for (const key of adopt.keys()) {
      if (!base[key]) continue;
      base[key].echo = after.has(key) ? stableJson(after.get(key)) : null;
    }
  }
  await meta.put({ rev, initialized: true, base, syncedAt: new Date(now()).toISOString() });
  return { pulled, pushed: ops.length, applied: adopt.size, conflicts: conflicts.length, startedAt };
}

// Pending changes for a page being closed: sent with keepalive, no answer awaited. The next run
// sends them again if this one was lost; an equal value changes nothing on the server.
export async function pushOnLeave({ fetchImpl = fetch, local, meta, deviceId, now = () => Date.now() }) {
  const saved = await meta.get();
  if (!saved?.initialized) return 0;
  const { candidates } = planCandidates(stateEntries(await local.read()), saved.base, now(), true);
  const ops = [];
  let size = 0;
  for (const [key, value] of candidates) {
    const op = { opId: crypto.randomUUID(), key, value };
    size += JSON.stringify(op).length;
    // keepalive bodies are limited to 64 KB; the rest waits for the next run.
    if (size > 60_000 || ops.length >= PUSH_BATCH) break;
    ops.push(op);
  }
  if (!ops.length) return 0;
  try {
    await fetchImpl("/api/v1/sync/push", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ deviceId, ops }),
    });
  } catch { /* the next run sends them */ }
  return ops.length;
}
