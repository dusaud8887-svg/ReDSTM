import { expect, test } from "@playwright/test";

import { useLongCollection } from "./typemoon-fixture.js";

// docs/24 §12.6. Requests a service worker makes reach only context-level routes, so this spec
// allows the worker and mocks on the browser context.
test.use({ serviceWorkers: "allow" });

// httpCredentials do not reach a service worker's own requests (its script, precache and fetches);
// production uses the Access cookie. Here every request carries the Basic header itself. Routes
// added later (the fixtures) take precedence and answer before this one.
test.beforeEach(async ({ context }, testInfo) => {
  const { username, password } = testInfo.project.use.httpCredentials ?? { username: "reader", password: "test-secret" };
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  await context.route("**/*", (route) => route.continue({ headers: { ...route.request().headers(), authorization: basic } }));
});

async function controlled(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

const cachedPaths = (page) => page.evaluate(async () => {
  const found = {};
  for (const key of await caches.keys()) {
    found[key] = (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname);
  }
  return found;
});

test("The service worker precaches the shell, never caches who-am-I, and opens the shell offline", async ({ page, context }) => {
  await useLongCollection(context, 3);
  await page.goto("/");
  await controlled(page);
  const caches = await cachedPaths(page);
  const precache = Object.entries(caches).find(([key]) => key.startsWith("workbox-precache"))?.[1] ?? [];
  expect(precache).toEqual(expect.arrayContaining(["/", "/app.js", "/styles/reader.css", "/fonts/pretendard@1.3.9/core.woff2"]));
  expect(precache).not.toContain("/ops.js");
  expect(Object.values(caches).flat()).not.toContain("/api/v1/me");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#home-title")).toBeVisible();
  await context.setOffline(false);
});

test("An HTML sign-in page instead of an archive object is not cached and the page says the sign-in expired", async ({ page, context }) => {
  await useLongCollection(context, 3);
  await page.goto("/");
  await controlled(page);
  await context.route("**/archive/posts/board_a/2-*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Sign in</title>" }));
  await page.goto("/read/board_a/2");
  await expect(page.locator("#auth-dialog")).toBeVisible();
  const caches = await cachedPaths(page);
  expect(Object.values(caches).flat().filter((path) => path.startsWith("/archive/posts/board_a/2-"))).toEqual([]);
});

// P4-2 / T08: a work is saved for offline reading through the worker, shows its state in words,
// becomes partial when a file fails, resumes, appears in settings and is removed again.
test("A work is saved on this device, resumes after a failed file, and is removed", async ({ page, context }) => {
  const owner = "0123456789abcdef";
  await useLongCollection(context, 3);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: owner }) }));
  await page.goto("/");
  await controlled(page);
  let failing = true;
  await context.route("**/archive/posts/board_a/2-*", (route) => (failing ? route.fulfill({ status: 500, body: "" }) : route.fallback()));
  await page.goto("/collections/1");
  const control = page.locator("#collection-offline");
  await expect(control).toBeVisible();
  await expect(page.locator("#offline-state")).toHaveText("글만 저장 · 이미지는 온라인에서");
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText("일부만 저장됨 · 2/3편 (1편 실패)");
  await expect(page.locator("#offline-save")).toHaveText("이어서 저장");
  failing = false;
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨 · \d/);
  await expect(page.locator("#offline-save")).toBeHidden();
  const saved = await cachedPaths(page);
  expect((saved[`offline-v1-${owner}`] ?? []).filter((path) => path.startsWith("/archive/posts/board_a/")).length).toBe(3);
  // The snapshot survives a reload.
  await page.reload();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨/);
  await page.goto("/settings");
  await expect(page.locator("#offline-storage")).toContainText("이 기기에 저장한 작품 1개");
  await page.goto("/collections/1");
  await page.locator("#offline-delete").click();
  await expect(page.locator("#offline-state")).toHaveText("글만 저장 · 이미지는 온라인에서");
  await expect.poll(async () => ((await cachedPaths(page))[`offline-v1-${owner}`] ?? []).length).toBe(0);
});

async function saveCollection(page, context, owner) {
  await useLongCollection(context, 3);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: owner }) }));
  await page.goto("/");
  await controlled(page);
  await page.goto("/collections/1");
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨/);
}

test("A first visit directly to a work enables saving when the worker becomes ready", async ({ page, context }) => {
  await useLongCollection(context, 3);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await page.goto("/collections/1");
  await expect(page.locator("#offline-save")).toBeVisible();
  await expect(page.locator("#offline-save")).toBeEnabled();
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨/);
});

// P4-3 / T07: started with no network, the shell comes from the cache and the saved work opens
// from its snapshot, down to an episode's text.
test("Offline from the start, a saved work and its episode open from this device", async ({ page, context }) => {
  await saveCollection(page, context, "0123456789abcdef");
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.locator("#offline-works")).toBeVisible();
  await page.locator("#offline-works-list button").first().click();
  await expect(page.locator("#collection-title")).toHaveText("긴 연재");
  await page.locator('.collection-entry[data-key="2"]').click();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#archive-body")).toContainText("2편 본문 1");
  await context.setOffline(false);
});

// T09: an expired sign-in (an HTML page where data was asked for) opens a sheet instead of quietly
// showing an older answer; the saved works are one choice.
test("An expired sign-in opens a sheet that offers signing in again or the saved works", async ({ page, context }) => {
  await saveCollection(page, context, "0123456789abcdef");
  // The archive pointer is never a saved file, so it goes to the network and meets the sign-in page.
  await context.route("**/archive/release.json", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Sign in</title>" }));
  await context.route("**/api/v1/me", (route) => route.fulfill({ status: 403, body: "Authentication required" }));
  await page.goto("/");
  const sheet = page.locator("#auth-dialog");
  await expect(sheet).toBeVisible();
  await page.locator("#auth-saved").click();
  await expect(sheet).toBeHidden();
  await expect(page.locator("#offline-works")).toBeVisible();
  await page.locator("#offline-works-list button").first().click();
  await expect(page.locator("#collection-title")).toHaveText("긴 연재");
  await page.locator('.collection-entry[data-key="2"]').click();
  await expect(page.locator("#archive-body")).toContainText("2편 본문 1");
});

// §12.6.3: another account's records on this device are never opened and can be deleted.
test("Another account's namespace stays closed and can be deleted from settings", async ({ page, context }) => {
  await saveCollection(page, context, "0123456789abcdef");
  await context.unroute("**/api/v1/me");
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "fedcba9876543210" }) }));
  await page.goto("/collections/1");
  await expect(page.locator("#offline-state")).toHaveText("글만 저장 · 이미지는 온라인에서");
  await page.goto("/settings");
  await expect(page.locator("#other-account")).toBeVisible();
  await page.locator("#other-account-delete").click();
  await expect(page.locator("#other-account")).toBeHidden();
  const left = await page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name));
  expect(left).not.toContain("redstm:0123456789abcdef");
  expect(Object.keys(await cachedPaths(page)).filter((name) => name.endsWith("-0123456789abcdef"))).toEqual([]);
});

// P4-4 / T24: 앱 캐시 지우기 removes the worker and every cache it filled; the records stay.
test("앱 캐시 지우기 unregisters the worker and empties its caches", async ({ page, context }) => {
  await saveCollection(page, context, "0123456789abcdef");
  await page.goto("/settings");
  page.once("dialog", (dialog) => dialog.accept());
  await Promise.all([page.waitForEvent("load"), page.locator("#reset-app-cache").click()]);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((name) => name.includes("offline-v1")).length)).toBe(0);
  // The owner's database (marks, notes, the saved-work records) is not part of the cache.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name))).toContain("redstm:0123456789abcdef");
  await page.goto("/collections/1");
  await expect(page.locator("#offline-save")).toBeVisible();
  await expect(page.locator("#offline-state")).toContainText("저장이 중단됨");
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨/);
});

test("Resetting caches also makes another account's saved works resumable", async ({ page, context }) => {
  const firstOwner = "0123456789abcdef";
  await saveCollection(page, context, firstOwner);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "fedcba9876543210" }) }));
  await page.goto("/settings");
  await expect(page.locator("#other-account")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await Promise.all([page.waitForEvent("load"), page.locator("#reset-app-cache").click()]);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: firstOwner }) }));
  await page.goto("/collections/1");
  await expect(page.locator("#offline-save")).toBeVisible();
  await page.locator("#offline-save").click();
  await expect(page.locator("#offline-state")).toHaveText(/^이 기기에 저장됨/);
});

test("A failed snapshot write does not start an untracked offline download", async ({ page, context }) => {
  await useLongCollection(context, 3);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  let downloads = 0;
  await context.route("**/archive/posts/**", (route) => { downloads += 1; return route.fallback(); });
  await page.goto("/");
  await controlled(page);
  await page.goto("/collections/1");
  await expect(page.locator("#offline-save")).toBeEnabled();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "offline") throw new DOMException("Disk full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page.locator("#offline-save").click();
  await expect(page.locator("#aa-zoom-indicator")).toContainText("저장 상태를 기록하지 못했어요");
  await expect(page.locator("#offline-save")).toHaveText("이 기기에 저장");
  expect(downloads).toBe(0);
});

test("Each tab reads only the offline cache of its own owner", async ({ page, context }) => {
  await useLongCollection(context, 3);
  const firstOwner = "0123456789abcdef";
  const secondOwner = "fedcba9876543210";
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: firstOwner }) }));
  await page.goto("/");
  await controlled(page);
  await page.evaluate(async ({ firstOwner, secondOwner }) => {
    for (const owner of [firstOwner, secondOwner]) {
      const cache = await caches.open(`offline-v1-${owner}`);
      await cache.put("/archive/owner-check.json", new Response(JSON.stringify({ owner }), { headers: { "Content-Type": "application/json" } }));
    }
  }, { firstOwner, secondOwner });
  await expect.poll(() => page.evaluate(async () => (await fetch("/archive/owner-check.json")).json())).toEqual({ owner: firstOwner });
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: secondOwner }) }));
  const other = await context.newPage();
  await other.goto("/");
  await controlled(other);
  await expect.poll(() => other.evaluate(async () => (await fetch("/archive/owner-check.json")).json())).toEqual({ owner: secondOwner });
  expect(await page.evaluate(async () => (await fetch("/archive/owner-check.json")).json())).toEqual({ owner: firstOwner });
});
