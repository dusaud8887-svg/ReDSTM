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
  await expect(page.locator("#aa-zoom-indicator")).toContainText("로그인이 만료됐어요");
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
