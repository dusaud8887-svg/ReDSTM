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

const OWNER = "0123456789abcdef";

test("Blocked localStorage keeps the reader and verified owner's IndexedDB usable", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: OWNER }) }));
  await page.addInitScript((owner) => {
    localStorage.setItem("redstm.owner.v1", owner);
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === "redstm.legacyOwner.v1") throw new DOMException("blocked", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage) throw new DOMException("blocked", "SecurityError");
      return set.call(this, key, value);
    };
  }, OWNER);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: [] });
});

test("Switching accounts isolates legacy reading state and subsequent saves", async ({ page, context }) => {
  await useLongCollection(context, 3);
  const first = "0123456789abcdef";
  const second = "fedcba9876543210";
  let owner = first;
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: owner }) }));
  await page.goto("/read/board_a/2");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: ["board_a:2"] });
  owner = second;
  const other = await context.newPage();
  await other.goto("/saved?view=reading");
  await expect(other.locator("#archive-state")).toHaveText("보존본");
  const historyOf = (target, owner) => target.evaluate(async (owner) => {
    const { openStore } = await import("/store.js");
    const store = await openStore(owner);
    const copy = await store.get("meta", "legacy:redstm.userState.v2");
    const outbox = await store.getAll("outbox");
    store.close();
    return { history: Object.keys(JSON.parse(copy?.raw ?? '{"history":{}}').history), foreign: outbox.some((op) => op.value?.history?.["board_a:2"]) };
  }, owner);
  await expect.poll(() => historyOf(other, second)).toEqual({ history: [], foreign: false });
  await other.goto("/read/board_a/3");
  await expect.poll(() => historyOf(other, second)).toEqual({ history: ["board_a:3"], foreign: false });
  // The first tab still writes only its own key after another tab signs in as a different owner.
  await page.locator("#reader-pane").evaluate((element) => { element.scrollTop = 300; element.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: ["board_a:2"] });
  owner = first;
  await page.goto("/saved?view=reading");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: ["board_a:2"] });
});
test("A first verified owner with no remembered owner does not keep another owner's legacy state", async ({ page, context }) => {
  await useLongCollection(context, 3);
  const first = "0123456789abcdef";
  const second = "fedcba9876543210";
  let owner = first;
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: owner }) }));
  await page.goto("/read/board_a/2");
  const keys = (target, key) => target.evaluate((key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{"history":{}}').history), key);
  await expect.poll(() => keys(page, KEY)).toEqual(["board_a:2"]);
  // The legacy keys hold the first owner's records, but the remembered owner is gone.
  await page.evaluate(() => localStorage.removeItem("redstm.owner.v1"));
  await page.close();
  owner = second;
  const other = await context.newPage();
  await other.goto("/read/board_a/3");
  await other.locator("#reader-pane").evaluate((element) => { element.scrollTop = 300; element.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => keys(other, `${KEY}:${second}`)).toContain("board_a:3");
  expect(await keys(other, `${KEY}:${second}`)).not.toContain("board_a:2");
  expect(await keys(other, KEY)).toContain("board_a:2");
});
const KEY = "redstm.userState.v2";
const stateCopy = (page) => page.evaluate(async ([owner, key]) => {
  const { openStore } = await import("/store.js");
  const store = await openStore(owner);
  const copy = await store.get("meta", `legacy:${key}`);
  store.close();
  return { copy: copy?.raw ? Object.keys(JSON.parse(copy.raw).history) : null, local: Object.keys(JSON.parse(localStorage.getItem(key) ?? "{\"history\":{}}").history) };
}, [OWNER, KEY]);

test("P6-6 a reading state save that failed in localStorage comes back from the idb copy on the next start", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: OWNER }) }));
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem("fail-state")) return;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key) throw new DOMException("fixture quota", "QuotaExceededError");
      return setItem.call(this, name, value);
    };
  }, KEY);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: ["board_a:2"] });

  await page.evaluate(() => sessionStorage.setItem("fail-state", "1"));
  await page.goto("/read/board_a/3");
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
  await expect(page.locator("#archive-state")).toHaveText("로컬 저장 실패");
  await expect.poll(async () => (await stateCopy(page)).copy?.sort()).toEqual(["board_a:2", "board_a:3"]);
  expect((await stateCopy(page)).local).toEqual(["board_a:2"]);

  await page.evaluate(() => sessionStorage.removeItem("fail-state"));
  await page.goto("/");
  await expect.poll(async () => (await stateCopy(page)).local.sort()).toEqual(["board_a:2", "board_a:3"]);
});

test("P6-6 cleared localStorage reading state is restored from the idb copy, and an edited original wins", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: OWNER }) }));
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: ["board_a:2"], local: ["board_a:2"] });

  // Changes are made before the app starts: the open page saves its own state when it is left.
  await page.addInitScript((key) => {
    const change = sessionStorage.getItem("change-state");
    sessionStorage.removeItem("change-state");
    if (change === "clear") localStorage.removeItem(key);
    if (change === "edit") localStorage.setItem(key, JSON.stringify({ schema_version: 2, settings: {}, history: {}, bookmarks: {} }));
  }, KEY);
  await page.evaluate(() => sessionStorage.setItem("change-state", "clear"));
  await page.goto("/");
  await expect.poll(async () => (await stateCopy(page)).local).toEqual(["board_a:2"]);

  // An original changed outside this page (another older tab, a manual import) is newer than the copy.
  await page.evaluate(() => sessionStorage.setItem("change-state", "edit"));
  await page.goto("/");
  await expect.poll(() => stateCopy(page)).toEqual({ copy: [], local: [] });
});
