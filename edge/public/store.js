const KEYS = { annotations: "id", sessions: "id", works: "workKey", offline: "workKey" };

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
    const value = structuredClone(change.value);
    return { store: change.store, key, value, op: {
      opId: crypto.randomUUID(), key: `${change.store}:${key}`, value,
      baseRev: change.baseRev ?? 0, createdAt, attempts: 0, state: "pending",
    } };
  });
}

export async function writeTransaction(db, changes) {
  const planned = planChanges(changes);
  if (!planned.length) return [];
  const tx = db.transaction([...new Set(planned.map((change) => change.store)), "outbox"], "readwrite");
  try {
    for (const change of planned) {
      if (change.value === null) await tx.objectStore(change.store).delete(change.key);
      else await tx.objectStore(change.store).put(change.value);
      await tx.objectStore("outbox").add(change.op);
    }
    await tx.done;
    return planned.map((change) => change.op);
  } catch (error) {
    try { tx.abort(); } catch { /* an IDB request may already have aborted it */ }
    await tx.done.catch(() => {});
    throw error;
  }
}

export function pendingLegacy(records, committed) {
  return records.filter((record) => {
    const previous = committed.get(record.key);
    return !previous || record.raw !== previous.raw || record.updatedAt > previous.updatedAt;
  });
}

export async function openStore(ownerHash) {
  const name = storeName(ownerHash);
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
    blocking() { db.close(); },
  });
  const tx = db.transaction("meta", "readwrite");
  let device = await tx.store.get("deviceId");
  if (!device) {
    device = { key: "deviceId", value: crypto.randomUUID() };
    await tx.store.put(device);
  }
  await tx.done;
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
      await transaction.objectStore("meta").put({ ...record, key: `legacy:${record.key}` });
      await transaction.objectStore("outbox").add({
        opId: crypto.randomUUID(), key: `legacy:${record.key}`, value, baseRev: 0,
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
