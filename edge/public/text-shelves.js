// Personal shelves for novel works: one shelf per work (a folder, not tags), kept in the text
// reading state (redstm.textState.v1) next to history and bookmarks. Works with no shelf are
// 미분류. A hidden shelf keeps its works out of the 전체 list (e.g. 안 볼 작품).

export const UNSORTED = "unsorted";
const SHELF_ID = /^s[a-z0-9]{1,15}$/;
const NAME_LIMIT = 30;
const SHELF_LIMIT = 50;
const WORK_ID_LIMIT = 300;

// Offered once, the first time the state has no shelves; each can be renamed or removed.
export const STARTER_SHELVES = [
  { id: "slater", name: "찜 · 나중에 볼 작품", hidden: false },
  { id: "sdone", name: "다 본 작품", hidden: false },
  { id: "sskip", name: "안 볼 작품", hidden: true },
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanName(value) {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT) : "";
}

// Shelves and assignments that are safe to keep (storage, backups): valid ids, unique names,
// assignments only to existing shelves.
export function sanitizeShelfState(value) {
  const source = isRecord(value) ? value : {};
  const shelves = [];
  const ids = new Set();
  const names = new Set();
  for (const shelf of Array.isArray(source.shelves) ? source.shelves : []) {
    const name = cleanName(shelf?.name);
    const key = name.toLocaleLowerCase("ko-KR");
    if (!isRecord(shelf) || !SHELF_ID.test(shelf.id ?? "") || ids.has(shelf.id) || !name || names.has(key)) continue;
    ids.add(shelf.id);
    names.add(key);
    shelves.push({ id: shelf.id, name, hidden: shelf.hidden === true });
    if (shelves.length === SHELF_LIMIT) break;
  }
  const workShelves = {};
  for (const [workId, shelfId] of Object.entries(isRecord(source.workShelves) ? source.workShelves : {})) {
    if (typeof workId === "string" && workId.length <= WORK_ID_LIMIT && workId.startsWith("novel:") && ids.has(shelfId)) {
      workShelves[workId] = shelfId;
    }
  }
  return { shelves, workShelves };
}

// Gives a state its shelves: the starter set on first use, otherwise its own list cleaned.
// Returns true when the state changed.
export function ensureShelves(state) {
  if (!Array.isArray(state.shelves)) {
    state.shelves = STARTER_SHELVES.map((shelf) => ({ ...shelf }));
    state.workShelves = isRecord(state.workShelves) ? state.workShelves : {};
    return true;
  }
  const before = JSON.stringify([state.shelves, state.workShelves]);
  const clean = sanitizeShelfState(state);
  state.shelves = clean.shelves;
  state.workShelves = clean.workShelves;
  return JSON.stringify([state.shelves, state.workShelves]) !== before;
}

export function shelfOf(state, workId) {
  return state.workShelves?.[workId] ?? UNSORTED;
}

export function shelfName(state, shelfId) {
  if (shelfId === UNSORTED) return "미분류";
  return state.shelves?.find((shelf) => shelf.id === shelfId)?.name ?? "미분류";
}

export function hiddenShelfIds(state) {
  return new Set((state.shelves ?? []).filter((shelf) => shelf.hidden).map((shelf) => shelf.id));
}

export function setWorkShelf(state, workId, shelfId) {
  if (!workId) return false;
  const previous = state.workShelves[workId] ?? UNSORTED;
  if (shelfId === UNSORTED || !state.shelves.some((shelf) => shelf.id === shelfId)) delete state.workShelves[workId];
  else state.workShelves[workId] = shelfId;
  return previous !== (state.workShelves[workId] ?? UNSORTED);
}

function newShelfId(state) {
  const taken = new Set(state.shelves.map((shelf) => shelf.id));
  for (;;) {
    const id = `s${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

// Returns the new shelf's id, or an error code: "name_empty", "name_taken", "too_many".
export function addShelf(state, name, { hidden = false } = {}) {
  const clean = cleanName(name);
  if (!clean) return { error: "name_empty" };
  if (state.shelves.length >= SHELF_LIMIT) return { error: "too_many" };
  if (state.shelves.some((shelf) => shelf.name.toLocaleLowerCase("ko-KR") === clean.toLocaleLowerCase("ko-KR"))) {
    return { error: "name_taken" };
  }
  const id = newShelfId(state);
  state.shelves.push({ id, name: clean, hidden: hidden === true });
  return { id };
}

export function renameShelf(state, shelfId, name) {
  const clean = cleanName(name);
  const shelf = state.shelves.find((item) => item.id === shelfId);
  if (!shelf || !clean) return { error: "name_empty" };
  if (state.shelves.some((item) => item.id !== shelfId && item.name.toLocaleLowerCase("ko-KR") === clean.toLocaleLowerCase("ko-KR"))) {
    return { error: "name_taken" };
  }
  shelf.name = clean;
  return { id: shelfId };
}

export function setShelfHidden(state, shelfId, hidden) {
  const shelf = state.shelves.find((item) => item.id === shelfId);
  if (shelf) shelf.hidden = hidden === true;
  return Boolean(shelf);
}

// Its works go back to 미분류.
export function removeShelf(state, shelfId) {
  const before = state.shelves.length;
  state.shelves = state.shelves.filter((shelf) => shelf.id !== shelfId);
  for (const [workId, assigned] of Object.entries(state.workShelves)) {
    if (assigned === shelfId) delete state.workShelves[workId];
  }
  return state.shelves.length !== before;
}

export function moveShelf(state, shelfId, delta) {
  const index = state.shelves.findIndex((shelf) => shelf.id === shelfId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.shelves.length) return false;
  const [shelf] = state.shelves.splice(index, 1);
  state.shelves.splice(target, 0, shelf);
  return true;
}

// Work counts per shelf (UNSORTED included) over the given works.
export function shelfCounts(state, works) {
  const counts = new Map([[UNSORTED, 0], ...state.shelves.map((shelf) => [shelf.id, 0])]);
  for (const work of works) {
    const shelf = shelfOf(state, work.work_id);
    const key = counts.has(shelf) ? shelf : UNSORTED;
    counts.set(key, counts.get(key) + 1);
  }
  return counts;
}

// A work republished under a new canonical id keeps its shelf (legacy_work_ids are its aliases).
export function migrateShelfAliases(state, works) {
  let changed = false;
  for (const work of works) {
    if (state.workShelves[work.work_id]) continue;
    const alias = (work.legacy_work_ids ?? []).find((id) => state.workShelves[id]);
    if (!alias) continue;
    state.workShelves[work.work_id] = state.workShelves[alias];
    delete state.workShelves[alias];
    changed = true;
  }
  return changed;
}

// Import: shelves are matched by name so the same shelf on two devices merges into one.
export function mergeShelfState(current, incoming) {
  const clean = sanitizeShelfState(incoming);
  const idMap = new Map();
  for (const shelf of clean.shelves) {
    const existing = current.shelves.find((item) => item.name.toLocaleLowerCase("ko-KR") === shelf.name.toLocaleLowerCase("ko-KR"));
    if (existing) idMap.set(shelf.id, existing.id);
    else if (current.shelves.length < SHELF_LIMIT) {
      const id = current.shelves.some((item) => item.id === shelf.id) ? newShelfId(current) : shelf.id;
      current.shelves.push({ ...shelf, id });
      idMap.set(shelf.id, id);
    }
  }
  for (const [workId, shelfId] of Object.entries(clean.workShelves)) {
    if (idMap.has(shelfId)) current.workShelves[workId] = idMap.get(shelfId);
  }
  return current;
}
