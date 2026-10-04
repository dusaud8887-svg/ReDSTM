const KEYS = { annotations: "id", sessions: "id", works: "workKey", offline: "workKey", meta: "key" };

export function storeName(ownerHash) {
  if (typeof ownerHash !== "string" || !/^[a-f0-9]{16}$/.test(ownerHash)) throw new TypeError("검증된 계정 식별자가 필요합니다");
  return `redstm:${ownerHash}`;
}

export function planChanges(changes, createdAt = new Date().toISOString()) {
  return changes.map((change) => {
    const keyPath = KEYS[change.store];
    if (!Object.hasOwn(KEYS, change.store)) throw new TypeError("지원하지 않는 저장소");
    if (change.value === null && change.store !== "offline") throw new TypeError("기록 삭제는 tombstone으로 저장합니다");
    const key = change.value === null ? change.key : change.value?.[keyPath];
    if (typeof key !== "string" || !key || key.length > 300) throw new TypeError("잘못된 기록 식별자");
    if (change.baseRev !== undefined && (!Number.isSafeInteger(change.baseRev) || change.baseRev < 0)) throw new TypeError("잘못된 revision");
    if (change.store === "meta" && key !== "library") throw new TypeError("지원하지 않는 사용자 설정");
    const value = structuredClone(change.value);
    return { store: change.store, key, value, op: {
      opId: crypto.randomUUID(), key: `${change.store}:${key}`, value,
      baseRev: change.baseRev ?? 0, createdAt, attempts: 0, state: "pending",
    } };
  });
}

// Nothing sends the outbox yet (sync is M5), so a record saved again would queue another full
// copy each time. A new operation replaces the previous one for the same record while that one is
// still unsent and untried, the rule bridgeLegacy already applies to whole states; an operation
// that was attempted stays, so a send in flight is never lost. meta "pending:<op key>" names it.
const pendingKey = (opKey) => `pending:${opKey}`;

async function supersede(tx, op) {
  const meta = tx.objectStore("meta");
  const outbox = tx.objectStore("outbox");
  const marker = await meta.get(pendingKey(op.key));
  if (marker) {
    const previous = await outbox.get(marker.opId);
    if (previous?.state === "pending" && previous.attempts === 0) await outbox.delete(previous.opId);
  }
  await outbox.add(op);
  await meta.put({ key: pendingKey(op.key), opId: op.opId });
}

export async function writeTransaction(db, changes) {
  const planned = planChanges(changes);
  if (!planned.length) return [];
  const tx = db.transaction([...new Set([...planned.map((change) => change.store), "meta", "outbox"])], "readwrite");
  try {
    for (const change of planned) {
      if (change.value === null) await tx.objectStore(change.store).delete(change.key);
      else await tx.objectStore(change.store).put(change.value);
      await supersede(tx, change.op);
    }
    await tx.done;
    return planned.map((change) => change.op);
  } catch (error) {
    try { tx.abort(); } catch { /* an IDB request may already have aborted it */ }
    await tx.done.catch(() => {});
    throw error;
  }
}

// The backlog written before supersede(): keep the newest unsent, untried operation per record
// (and every attempted one), and leave a marker so later writes replace it. Returns how many went.
export async function compactOutbox(db) {
  const tx = db.transaction(["meta", "outbox"], "readwrite");
  const outbox = tx.objectStore("outbox");
  const meta = tx.objectStore("meta");
  const newest = new Map();
  const stale = [];
  for (const op of await outbox.getAll()) {
    if (op.key.startsWith("legacy:") || op.state !== "pending" || op.attempts !== 0) continue;
    const kept = newest.get(op.key);
    if (!kept) newest.set(op.key, op);
    else if (op.createdAt > kept.createdAt) {
      stale.push(kept);
      newest.set(op.key, op);
    } else stale.push(op);
  }
  for (const op of stale) await outbox.delete(op.opId);
  for (const op of newest.values()) {
    if (!await meta.get(pendingKey(op.key))) await meta.put({ key: pendingKey(op.key), opId: op.opId });
  }
  await tx.done;
  return stale.length;
}

export function pendingLegacy(records, committed) {
  return records.filter((record) => {
    const previous = committed.get(record.key);
    return !previous || record.raw !== (previous.sourceRaw ?? previous.raw) || record.updatedAt > previous.updatedAt;
  });
}

export async function openStore(ownerHash, { onClosed } = {}) {
  const name = storeName(ownerHash);
  let closed = false;
  const { openDB } = await import("/vendor/idb@8.0.3/idb.js");
  const db = await openDB(name, 1, {
    upgrade(database) {
      const annotations = database.createObjectStore("annotations", { keyPath: "id" });
      annotations.createIndex("byDocument", "documentId");
      annotations.createIndex("byWork", "workId");
      annotations.createIndex("byUpdated", "updatedAt");
      const sessions = database.createObjectStore("sessions", { keyPath: "id" });
      sessions.createIndex("byDay", "day");
      sessions.createIndex("byWork", "workKey");
      database.createObjectStore("works", { keyPath: "workKey" });
      database.createObjectStore("offline", { keyPath: "workKey" });
      database.createObjectStore("outbox", { keyPath: "opId" });
      database.createObjectStore("meta", { keyPath: "key" });
    },
    // Another tab needs a newer schema: let it upgrade. This connection is gone for good, so the
    // store reports it (onClosed) and the app opens a fresh one on its next use.
    blocking() {
      db.close();
      closed = true;
      onClosed?.();
    },
  });
  const tx = db.transaction("meta", "readwrite");
  let device = await tx.store.get("deviceId");
  if (!device) {
    device = { key: "deviceId", value: crypto.randomUUID() };
    await tx.store.put(device);
  }
  await tx.done;
  await compactOutbox(db).catch(() => {});
  const events = new EventTarget();
  const channelName = `${name}:changes`;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;
  const emit = (detail) => events.dispatchEvent(new CustomEvent("change", { detail }));
  if (channel) channel.onmessage = (event) => emit(event.data);
  const storageChanged = (event) => { if (event.key === channelName && event.newValue) emit({ external: true }); };
  if (!channel) globalThis.addEventListener("storage", storageChanged);
  const locked = (callback) => navigator.locks?.request ? navigator.locks.request("redstm-store", callback) : callback();
  const notify = (keys) => {
    const message = { keys, deviceId: device.value };
    if (channel) channel.postMessage(message);
    else {
      try { localStorage.setItem(channelName, crypto.randomUUID()); } catch { /* notification cannot undo a committed write */ }
    }
    emit(message);
  };
  async function bridgeLegacy(record) {
    const transaction = db.transaction(["meta", "outbox"], "readwrite");
    const value = JSON.parse(record.raw);
    try {
      const previous = await transaction.objectStore("meta").get(`legacy:${record.key}`);
      const opId = crypto.randomUUID();
      // A full state supersedes its unsent predecessor. Keep attempted operations, and never
      // compact annotations/tombstones here. The original migration bytes remain a rollback copy.
      if (previous?.pendingOpId) {
        const pending = await transaction.objectStore("outbox").get(previous.pendingOpId);
        if (pending?.state === "pending" && pending.attempts === 0) await transaction.objectStore("outbox").delete(pending.opId);
      }
      await transaction.objectStore("meta").put({ ...record, key: `legacy:${record.key}`,
        sourceRaw: record.sourceRaw ?? record.raw, originalRaw: previous?.originalRaw ?? record.raw, pendingOpId: opId });
      await transaction.objectStore("outbox").add({
        opId, key: `legacy:${record.key}`, value, baseRev: 0,
        createdAt: record.updatedAt, attempts: 0, state: "pending",
      });
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch { /* already aborted */ }
      await transaction.done.catch(() => {});
      throw error;
    }
  }
  return {
    name, deviceId: device.value,
    get closed() { return closed; },
    get: (store, key) => db.get(store, key),
    getAll: (store) => db.getAll(store),
    async commit(changes) {
      const operations = await locked(() => writeTransaction(db, changes));
      if (operations.length) notify(operations.map((op) => op.key));
      return operations;
    },
    readLegacy(key, fallback = null) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    async writeLegacy(key, value) {
      const raw = JSON.stringify(value);
      if (typeof raw !== "string") throw new TypeError("JSON 기록이 필요합니다");
      // Keep the existing localStorage key and bytes, even if the IDB/outbox write fails.
      await locked(async () => {
        localStorage.setItem(key, raw);
        await bridgeLegacy({ key, raw, updatedAt: value?.updatedAt || new Date().toISOString() });
      });
      notify([key]);
    },
    // sourceRaw: the localStorage bytes when this state was saved (a queued write must not record
    // a later localStorage value as the one it supersedes).
    async writeState(key, raw, sourceRaw = localStorage.getItem(key) ?? raw) {
      if (!["redstm.userState.v2", "redstm.textState.v1"].includes(key) || typeof raw !== "string") throw new TypeError("잘못된 읽기 상태");
      const value = JSON.parse(raw);
      if (value?.schema_version !== (key === "redstm.userState.v2" ? 2 : 1)) throw new TypeError("지원하지 않는 읽기 상태");
      await locked(() => bridgeLegacy({ key, raw, sourceRaw, updatedAt: new Date().toISOString() }));
      notify([key]);
    },
    async reconcileLegacy(keys) {
      return locked(async () => {
        const records = [];
        const committed = new Map();
        for (const key of keys) {
          const raw = localStorage.getItem(key);
          if (raw === null) continue;
          const value = JSON.parse(raw);
          records.push({ key, raw, updatedAt: value?.updatedAt || "" });
          committed.set(key, await db.get("meta", `legacy:${key}`));
        }
        const pending = pendingLegacy(records, committed);
        for (const record of pending) await bridgeLegacy({ ...record, updatedAt: record.updatedAt || new Date().toISOString() });
        if (pending.length) notify(pending.map((record) => record.key));
        return pending.length;
      });
    },
    subscribe(callback) {
      const listener = (event) => callback(event.detail);
      events.addEventListener("change", listener);
      return () => events.removeEventListener("change", listener);
    },
    close() {
      channel?.close();
      globalThis.removeEventListener("storage", storageChanged);
      db.close();
    },
  };
}
