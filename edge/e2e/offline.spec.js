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
