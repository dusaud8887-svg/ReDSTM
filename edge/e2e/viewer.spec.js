import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const aaKey = process.env.REDSTM_AA_KEY ||
  "posts/aa_19/351495-b43dec5cddddbd48c627717b51523ab02a6ac989e8634312ba1e4937b614bf19.json.zst";
const proseKey = process.env.REDSTM_PROSE_KEY ||
  "posts/ss_19/189648-9a700c99351f57b2298b4420f20df3663329666c1149e873c2f396ea1fe7266d.json.zst";
const firstHash = "1".repeat(64);
const secondHash = "2".repeat(64);
const standaloneHash = "3".repeat(64);
const firstKey = `posts/board_a/1-${firstHash}.json.zst`;
const secondKey = `posts/board_a/2-${secondHash}.json.zst`;
const standaloneKey = `posts/board_a/3-${standaloneHash}.json.zst`;

function postPayload(id, title) {
  return {
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`,
      title, author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1,
      body_html: `<p>${title} 본문</p>`, is_aa: false,
    },
    comments: [],
  };
}

async function useCollectionFixture(page) {
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: "collections/e2e.json.zst" },
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256"],
      posts: [
        ["board_a", 3, "비소속", "작성자", null, "2026-07-11", standaloneHash],
        ["board_a", 2, "둘째", "작성자", null, "2026-07-11", secondHash],
        ["board_a", 1, "첫째", "작성자", null, "2026-07-11", firstHash],
      ],
    }],
    ["collections/e2e.json.zst", {
      schema_version: 1,
      collections: [{
        id: 1, board_id: "board_a", kind: "series", title: "테스트 연작",
        entries: [
          { position: 1, board_id: "board_a", external_post_id: 1, object_key: firstKey },
          { position: 2, board_id: "board_a", external_post_id: 99, object_key: null },
          { position: 3, board_id: "board_a", external_post_id: 2, object_key: secondKey },
        ],
      }],
    }],
    [firstKey, postPayload(1, "첫째")],
    [secondKey, postPayload(2, "둘째")],
    [standaloneKey, postPayload(3, "비소속")],
  ]);
  await page.route("**/archive/**", async (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function openPost(page, key) {
  await page.goto(`/#${encodeURIComponent(key)}`);
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#empty-reader")).toBeHidden();
  await expect(page.locator("#archive-body")).not.toBeEmpty();
}

test.beforeAll(async () => {
  await mkdir(".wrangler/screenshots", { recursive: true });
});

test("searches and renders a real AA post", async ({ page }, testInfo) => {
  await openPost(page, aaKey);
  await expect(page.locator("#archive-body")).toHaveClass(/aa/);
  expect(await page.evaluate(async () => {
    await document.fonts.load("16px Saitamaar");
    return document.fonts.check("16px Saitamaar");
  })).toBe(true);
  const title = await page.locator("#reader-title").innerText();
  const query = title.match(/[가-힣]{2}/)?.[0];
  expect(query).toBeTruthy();

  await page.locator("#board-filter").selectOption("aa_19");
  await page.locator("#search-input").fill(query);
  await expect(page.locator(".result-item", { hasText: title })).toBeVisible();

  await page.locator("#reader-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#export-state")).toBeVisible();
  await expect(page.locator("#import-state")).toBeVisible();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator("#bookmark-post").click();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");

  const widthFits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(widthFits).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa.png` });
});

test("renders prose and restores the reading position", async ({ page }, testInfo) => {
  await openPost(page, proseKey);
  await expect(page.locator("#archive-body")).not.toHaveClass(/aa/);

  const mobile = testInfo.project.name === "mobile";
  const available = await page.evaluate((useWindow) => {
    const target = useWindow ? document.scrollingElement : document.getElementById("reader-pane");
    return target.scrollHeight - target.clientHeight;
  }, mobile);
  expect(available).toBeGreaterThan(100);
  await page.evaluate((useWindow) => {
    if (useWindow) window.scrollTo(0, 300);
    else document.getElementById("reader-pane").scrollTop = 300;
  }, mobile);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator("#reader")).toBeVisible();
  await page.waitForTimeout(100);
  const restored = await page.evaluate((useWindow) =>
    useWindow ? window.scrollY : document.getElementById("reader-pane").scrollTop, mobile);
  expect(restored).toBeGreaterThan(200);

  await page.evaluate((useWindow) => {
    if (useWindow) window.scrollTo(0, 0);
    else document.getElementById("reader-pane").scrollTop = 0;
  }, mobile);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-prose.png` });
});

test("restores collection navigation and keeps list fallback", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, secondKey);
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3");
  await expect(page.locator("#previous-post")).toBeEnabled();
  await expect(page.locator("#next-post")).toBeDisabled();

  await page.locator("#previous-post").click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 1/3");
  await expect(page.locator("#previous-post")).toBeDisabled();
  await expect(page.locator("#next-post")).toBeEnabled();

  await page.goto(`/?fixture=standalone#${encodeURIComponent(standaloneKey)}`);
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("#collection-context")).toBeHidden();
  await expect(page.locator("#previous-post")).toBeDisabled();
  await expect(page.locator("#next-post")).toBeEnabled();
  await page.locator("#next-post").click();
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3");
});
