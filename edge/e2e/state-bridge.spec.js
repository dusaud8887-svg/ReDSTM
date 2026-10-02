import { expect, test } from "@playwright/test";
import { useLongCollection } from "./typemoon-fixture.js";

test("P6-6 state migration preserves source bytes and rollback, bounds pending states and aborts both writes", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { openStore } = await import("/store.js");
    const key = "redstm.userState.v2";
    const original = ' {"schema_version":2,"settings":{"theme":"dark"},"history":{},"bookmarks":{}}\n';
    localStorage.setItem(key, original);
    const store = await openStore("a".repeat(16));
    const migrated = await store.reconcileLegacy([key]);
    const initial = await store.get("meta", `legacy:${key}`);
    for (let index = 0; index < 12; index++) await store.writeState(key, JSON.stringify({ schema_version: 2, settings: { proseSize: 18 + index }, history: {}, bookmarks: {} }));
    const before = await store.get("meta", `legacy:${key}`);
    const pending = (await store.getAll("outbox")).filter((operation) => operation.key === `legacy:${key}`);
    const reconciled = await store.reconcileLegacy([key]);
    const afterReconcile = await store.get("meta", `legacy:${key}`);
    const add = IDBObjectStore.prototype.add;
    let failed = false;
    try {
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === "outbox") throw new DOMException("fixture quota", "QuotaExceededError");
        return add.apply(this, args);
      };
      await store.writeState(key, JSON.stringify({ schema_version: 2, settings: { proseSize: 99 }, history: {}, bookmarks: {} }));
    } catch { failed = true; }
    finally { IDBObjectStore.prototype.add = add; }
    const after = await store.get("meta", `legacy:${key}`);
    const operations = await store.getAll("outbox");
    const other = await openStore("b".repeat(16));
    const otherRecord = await other.get("meta", `legacy:${key}`);
    const source = localStorage.getItem(key);
    store.close(); other.close();
    return { original, migrated, initialRaw: initial.raw, source, originalRaw: before.originalRaw,
      pendingCount: pending.length, latest: pending[0].value.settings.proseSize, reconciled,
      sameAfterReconcile: afterReconcile.raw === before.raw, failed, sameAfterAbort: after.raw === before.raw,
      sameOperation: operations.length === 1 && operations[0].opId === pending[0].opId, otherRecord };
  });
  expect(result.migrated).toBe(1);
  expect(result.initialRaw).toBe(result.original);
  expect(result.originalRaw).toBe(result.original);
  expect(result.source).toBe(result.original);
  expect(result.pendingCount).toBe(1);
  expect(result.latest).toBe(29);
  expect(result.reconciled).toBe(0);
  expect(result.sameAfterReconcile).toBe(true);
  expect(result.failed).toBe(true);
  expect(result.sameAfterAbort).toBe(true);
  expect(result.sameOperation).toBe(true);
  expect(result.otherRecord).toBeUndefined();
});
