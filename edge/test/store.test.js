import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, featureEnabled } from "../public/capabilities.js";
import { haptic } from "../public/haptics.js";
import { compactOutbox, pendingLegacy, planChanges, storeName, writeTransaction } from "../public/store.js";

test("store namespaces and operation keys stay separated, with tombstones retained", () => {
  assert.notEqual(storeName("a".repeat(16)), storeName("b".repeat(16)));
  assert.throws(() => storeName("guest"), TypeError);
  const value = { id: "note-1", deletedAt: "2026-09-30T00:00:00Z", quote: "발췌" };
  const [change] = planChanges([{ store: "annotations", value }]);
  assert.equal(change.op.key, "annotations:note-1");
  assert.equal(change.op.value.deletedAt, value.deletedAt);
  assert.equal(change.op.state, "pending");
  assert.notEqual(change.value, value);
  assert.throws(() => planChanges([{ store: "annotations", key: "note-1", value: null }]), TypeError);
  assert.throws(() => planChanges([{ store: "outbox", value: { opId: "fake" } }]), TypeError);
  assert.throws(() => planChanges([{ store: "works", value: {} }]), TypeError);
});

test("a failed outbox insertion aborts the same transaction that writes the user's record", async () => {
  let aborted = false;
  let writes = 0;
  const db = { transaction(stores, mode) {
    assert.deepEqual(stores, ["works", "meta", "outbox"]);
    assert.equal(mode, "readwrite");
    return {
      objectStore(store) { return {
        async get() { return undefined; },
        async put() { assert.equal(store, "works"); writes += 1; },
        async add() { assert.equal(store, "outbox"); throw new Error("quota"); },
      }; },
      abort() { aborted = true; writes = 0; },
      get done() { return aborted ? Promise.reject(new Error("aborted")) : Promise.resolve(); },
    };
  } };
  await assert.rejects(writeTransaction(db, [{ store: "works", value: { workKey: "work:1" } }]), /quota/);
  assert.equal(aborted, true);
  assert.equal(writes, 0);
});

test("legacy reconciliation catches the gap after a local write, including a backward clock", () => {
  const committed = new Map([["position", { raw: '{"scroll":1}', updatedAt: "2026-09-30" }]]);
  const original = { key: "position", raw: '{"scroll":2}', updatedAt: "2026-09-29" };
  assert.deepEqual(pendingLegacy([original], committed), [original]);
  assert.deepEqual(pendingLegacy([{ ...original, raw: '{"scroll":1}', updatedAt: "2026-09-30" }], committed), []);
  assert.equal(original.raw, '{"scroll":2}');
});

test("an unchanged legacy source cannot overwrite newer IDB state after a mirror failure", () => {
  const original = { key: "position", raw: '{"scroll":1}', updatedAt: "" };
  const committed = new Map([["position", { raw: '{"scroll":2}', sourceRaw: original.raw, updatedAt: "2026-10-02" }]]);
  assert.deepEqual(pendingLegacy([original], committed), []);
  const changed = { ...original, raw: '{"scroll":3}' };
  assert.deepEqual(pendingLegacy([changed], committed), [changed]);
});

test("capability fallbacks and flags are explicit; unverified defaults stay off and sync can be turned off", (context) => {
  const previous = globalThis.localStorage;
  context.after(() => { globalThis.localStorage = previous; });
  globalThis.localStorage = { getItem: () => '{"kwic":true,"tts":true,"sync":true,"haptics":"true"}' };
  assert.equal(featureEnabled("kwic"), true);
  assert.equal(featureEnabled("tts"), false);
  assert.equal(featureEnabled("sync"), true);
  assert.equal(featureEnabled("haptics"), false);
  assert.equal(featureEnabled("pageMode"), false);
  assert.equal(capabilities.closeWatcher.detect(), false);
  assert.equal(capabilities.closeWatcher.keeps, "닫기 가능");
  for (const capability of Object.values(capabilities)) assert.equal(capability.minVerified, "");
  // Sync is on unless the flag turns it off (docs/24 §12.7).
  globalThis.localStorage = { getItem: () => '{"sync":false}' };
  assert.equal(featureEnabled("sync", true), false);
  globalThis.localStorage = { getItem: () => null };
  assert.equal(featureEnabled("sync", true), true);
});

test("haptics require opt-in, a gesture, and motion permission; only named actions vibrate", (context) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalStorage = globalThis.localStorage;
  const originalMatchMedia = globalThis.matchMedia;
  context.after(() => {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
    globalThis.localStorage = originalStorage;
    globalThis.matchMedia = originalMatchMedia;
  });
  const durations = [];
  let reduced = false;
  const navigator = { userActivation: { isActive: true }, vibrate: (duration) => { durations.push(duration); return true; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  globalThis.localStorage = { getItem: () => '{"haptics":true}' };
  globalThis.matchMedia = () => ({ matches: reduced });
  assert.equal(haptic("page"), true);
  assert.equal(haptic("save"), true);
  assert.equal(haptic("pull"), true);
  assert.equal(haptic("error"), false);
  assert.equal(haptic("toString"), false);
  reduced = true;
  assert.equal(haptic("mark"), false);
  reduced = false;
  navigator.userActivation.isActive = false;
  assert.equal(haptic("next"), false);
  navigator.userActivation.isActive = true;
  assert.equal(haptic("mark", false), false);
  globalThis.localStorage = { getItem: () => '{"haptics":false}' };
  assert.equal(haptic("mark"), false);
  assert.deepEqual(durations, [8, 12, 15]);
});

// A minimal in-memory IDB stand-in: object stores keyed by their keyPath, one shared transaction.
function memoryDb() {
  const stores = { meta: new Map(), outbox: new Map(), sessions: new Map(), annotations: new Map() };
  const keyOf = { meta: "key", outbox: "opId", sessions: "id", annotations: "id" };
  const db = {
    stores,
    transaction() {
      return {
        objectStore(name) { return {
          async get(key) { return stores[name].get(key); },
          async getAll() { return [...stores[name].values()]; },
          async put(value) { stores[name].set(value[keyOf[name]], structuredClone(value)); },
          async add(value) {
            if (stores[name].has(value[keyOf[name]])) throw new Error("ConstraintError");
            stores[name].set(value[keyOf[name]], structuredClone(value));
          },
          async delete(key) { stores[name].delete(key); },
        }; },
        abort() {},
        done: Promise.resolve(),
      };
    },
  };
  return db;
}

test("saving the same record again replaces its unsent outbox operation, never an attempted one", async () => {
  const db = memoryDb();
  for (const minutes of [1, 2, 3]) await writeTransaction(db, [{ store: "sessions", value: { id: "s1", minutes } }]);
  await writeTransaction(db, [{ store: "sessions", value: { id: "s2", minutes: 1 } }]);
  const queued = () => [...db.stores.outbox.values()];
  assert.deepEqual(queued().map((op) => [op.key, op.value.minutes]).sort(), [["sessions:s1", 3], ["sessions:s2", 1]]);
  // A send was attempted: that operation stays, and the next save queues beside it.
  for (const op of queued()) if (op.key === "sessions:s1") op.attempts = 1;
  await writeTransaction(db, [{ store: "sessions", value: { id: "s1", minutes: 4 } }]);
  assert.equal(queued().filter((op) => op.key === "sessions:s1").length, 2);
  assert.equal(db.stores.sessions.get("s1").minutes, 4);
});

test("the backlog from before the rule keeps the newest untried operation per record", async () => {
  const db = memoryDb();
  const op = (opId, key, createdAt, extra = {}) => ({ opId, key, value: {}, baseRev: 0, createdAt, attempts: 0, state: "pending", ...extra });
  for (const item of [
    op("a1", "sessions:s1", "2026-10-01"), op("a2", "sessions:s1", "2026-10-03"), op("a3", "sessions:s1", "2026-10-02"),
    op("b1", "annotations:n1", "2026-10-01"), op("c1", "sessions:s9", "2026-09-01", { attempts: 2 }),
    op("c2", "sessions:s9", "2026-09-02"), op("l1", "legacy:redstm.userState.v2", "2026-10-01"),
  ]) db.stores.outbox.set(item.opId, item);
  assert.equal(await compactOutbox(db), 2);
  assert.deepEqual([...db.stores.outbox.keys()].sort(), ["a2", "b1", "c1", "c2", "l1"]);
  assert.equal(db.stores.meta.get("pending:sessions:s1").opId, "a2");
  // The next save of s1 replaces a2 through its marker.
  await writeTransaction(db, [{ store: "sessions", value: { id: "s1", minutes: 9 } }]);
  assert.equal([...db.stores.outbox.values()].filter((item) => item.key === "sessions:s1").length, 1);
});
