// Device sync (docs/24 §12.7, T10–T12): two signed-in browsers of the same reader, with the real
// Worker sync routes (src/sync-api.js) on real SQLite behind page.route.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";

import { ownerHash, syncResponse } from "../src/sync-api.js";
import { useLongCollection } from "./typemoon-fixture.js";

function syncServer() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
  const execute = (sql, parameters, mode) => {
    const statement = db.prepare(sql);
    if (mode === "first") return statement.get(...parameters) ?? null;
    if (mode === "all") return { results: statement.all(...parameters) };
    return { meta: { changes: Number(statement.run(...parameters).changes) } };
  };
  const CONTROL_DB = {
    prepare(sql) {
      const statement = {
        sql, parameters: [],
        bind(...values) { statement.parameters = values; return statement; },
        first: async () => execute(sql, statement.parameters, "first"),
        all: async () => execute(sql, statement.parameters, "all"),
        run: async () => execute(sql, statement.parameters, "run"),
      };
      return statement;
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.parameters, "run"));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { CONTROL_DB, TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "aud" };
}

// A browser signed in as `subject`: /api/v1/me and the sync routes answer for that person.
async function signIn(context, env, subject) {
  const identity = { role: "user", subject };
  const owner = await ownerHash(subject);
  await useLongCollection(context, 3);
  await context.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: owner }) }));
  await context.route("**/api/v1/sync/**", async (route) => {
    const request = route.request();
    const response = await syncResponse(new Request(request.url(), {
      method: request.method(),
      headers: { "Content-Type": request.headers()["content-type"] ?? "" },
      body: request.method() === "POST" ? request.postData() : undefined,
    }), env, identity);
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  });
}

async function secondBrowser(browser, testInfo) {
  const { baseURL, httpCredentials, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = testInfo.project.use;
  return browser.newContext({ baseURL, httpCredentials, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, serviceWorkers: "block" });
}

async function syncNow(page) {
  await page.goto("/settings");
  await page.locator("#sync-now").click();
  await expect(page.locator("#sync-status")).toHaveText("서버 동기화 완료 · 방금");
}

const savedPosts = (page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("redstm.userState.v2")).bookmarks));

test("Reading records and saved posts follow the reader to another device, and a removal follows too", async ({ page, context, browser }, testInfo) => {
  const env = syncServer();
  await signIn(context, env, "reader@example.com");
  const bookmark = page.viewportSize().width < 760 ? "#reader-top-bookmark" : "#bookmark-post";
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(bookmark).click();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await syncNow(page);
  await expect(page.locator("#storage-note")).toContainText("같은 계정으로 로그인한 기기끼리 이어집니다");

  const otherContext = await secondBrowser(browser, testInfo);
  try {
    await signIn(otherContext, env, "reader@example.com");
    const other = await otherContext.newPage();
    await syncNow(other);
    expect(await savedPosts(other)).toEqual(["board_a:2"]);
    await other.goto("/saved");
    await expect(other.locator("#result-list")).toContainText("2편 제목");
    // The reading record came along: the other device continues from it.
    await other.goto("/");
    await expect(other.locator("#continue-title")).toHaveText("2편 제목");

    // Taken out of 저장 on the second device, it leaves the first one at its next sync.
    await other.goto("/read/board_a/2");
    await other.locator(bookmark).click();
    await expect(other.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "false");
    await syncNow(other);
    await syncNow(page);
    expect(await savedPosts(page)).toEqual([]);
  } finally {
    await otherContext.close();
  }
});

test("Another account sees none of the reader's records; without a verified account nothing syncs", async ({ page, context, browser }, testInfo) => {
  const env = syncServer();
  await signIn(context, env, "reader@example.com");
  await page.goto("/read/board_a/1");
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await syncNow(page);

  const otherContext = await secondBrowser(browser, testInfo);
  try {
    await signIn(otherContext, env, "someone-else@example.com");
    const other = await otherContext.newPage();
    await syncNow(other);
    await other.goto("/");
    await expect(other.locator("#continue-title")).not.toHaveText("1편 제목");
  } finally {
    await otherContext.close();
  }

  // Basic sign-in (no Access account): records stay on this device and the status says so.
  const localContext = await secondBrowser(browser, testInfo);
  try {
    await useLongCollection(localContext, 3);
    const local = await localContext.newPage();
    await local.goto("/settings");
    await local.locator("#sync-now").click();
    await expect(local.locator("#sync-status")).toHaveText("계정을 확인하지 못해 이 기기에만 저장합니다");
    await expect(local.locator("#sync-now")).toBeDisabled();
    await expect(local.locator("#storage-note")).toHaveText("읽기 기록과 저장한 글은 이 브라우저에만 보관됩니다.");
  } finally {
    await localContext.close();
  }
});
