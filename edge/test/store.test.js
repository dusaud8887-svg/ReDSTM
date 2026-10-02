import assert from "node:assert/strict";
import test from "node:test";
import { capabilities, featureEnabled } from "../public/capabilities.js";
import { haptic } from "../public/haptics.js";
import { pendingLegacy, planChanges, storeName, writeTransaction } from "../public/store.js";

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
    assert.deepEqual(stores, ["works", "outbox"]);
    assert.equal(mode, "readwrite");
    return {
      objectStore(store) { return {
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

test("capability fallbacks and flags are explicit; sync and unverified defaults stay off", (context) => {
  const previous = globalThis.localStorage;
  context.after(() => { globalThis.localStorage = previous; });
  globalThis.localStorage = { getItem: () => '{"kwic":true,"tts":true,"sync":true,"haptics":"true"}' };
  assert.equal(featureEnabled("kwic"), true);
  assert.equal(featureEnabled("tts"), false);
  assert.equal(featureEnabled("sync"), false);
  assert.equal(featureEnabled("haptics"), false);
  assert.equal(featureEnabled("pageMode"), false);
  assert.equal(capabilities.closeWatcher.detect(), false);
  assert.equal(capabilities.closeWatcher.keeps, "닫기 가능");
  for (const capability of Object.values(capabilities)) assert.equal(capability.minVerified, "");
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
