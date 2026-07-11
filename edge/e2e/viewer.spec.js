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
const missingKey = `posts/board_a/404-${"4".repeat(64)}.json.zst`;

function postPayload(id, title) {
  return {
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`,
      title, author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1,
      body_html: Array.from({ length: 30 }, (_, index) => `<p>${title} 본문 ${index + 1}</p>`).join(""), is_aa: false,
    },
    comments: [],
  };
}

function aaPostPayload(id, title) {
  const payload = postPayload(id, title);
  payload.post.is_aa = true;
  payload.post.body_html = `<pre class="AA_Text"><font color="#b4232f">${title}\n（　´∀｀）\n　|　　|</font></pre>`;
  return payload;
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
    [firstKey, aaPostPayload(1, "첫째")],
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

test("shows the archive cover and uses a single-plane mobile reader", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");

  if (testInfo.project.name === "desktop") {
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator("#empty-reader")).toContainText("월광 장서");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover.png" });
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover-night.png" });
  }

  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  if (page.viewportSize().width <= 760) {
    await expect(page.locator(".catalog")).toBeHidden();
    await page.screenshot({ path: ".wrangler/screenshots/mobile-reader.png" });
    await page.locator("#catalog-back").click();
    await expect(page.locator(".catalog")).toBeVisible();
    await expect(page.locator("#search-input")).toBeFocused();
  }
});

test("keeps the DSOTM AA settings contract", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await openPost(page, firstKey);
  await expect(page.locator("#aa-controls")).toBeVisible();
  await page.locator('[data-aa-preset="11:800"]').click();
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-inline-size")).toHaveText("11px");
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await page.locator('[data-aa-background="#ffffff"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#aa-source-styles").click();
  await expect(page.locator("#archive-body")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator("#archive-body font")).not.toHaveCSS("color", "rgb(180, 35, 47)");
  await page.reload();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await page.locator("#mode-toggle").click();
  await expect(page.locator("#archive-body")).not.toHaveClass(/aa/);
  await expect(page.locator("#aa-controls")).toBeHidden();
  await expect(page.locator("#mode-reset")).toBeVisible();
  await page.reload();
  await expect(page.locator("#archive-body")).not.toHaveClass(/aa/);
  await page.locator("#mode-reset").click();
  await expect(page.locator("#archive-body")).toHaveClass(/aa/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa-fixture.png` });
});

test("supports progress, immersive mode, and reader shortcuts", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-pane").evaluate((element) => { element.scrollTop = 300; });
  await expect(page.locator("#reading-progress")).not.toHaveCSS("width", "0px");
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await page.keyboard.press("b");
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("/");
  await expect(page.locator("#search-input")).toBeFocused();
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

  const available = await page.evaluate(() => {
    const target = document.getElementById("reader-pane");
    return target.scrollHeight - target.clientHeight;
  });
  expect(available).toBeGreaterThan(100);
  await page.evaluate(() => { document.getElementById("reader-pane").scrollTop = 300; });
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator("#reader")).toBeVisible();
  await page.waitForTimeout(100);
  const restored = await page.evaluate(() => document.getElementById("reader-pane").scrollTop);
  expect(restored).toBeGreaterThan(200);

  await page.evaluate(() => { document.getElementById("reader-pane").scrollTop = 0; });
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-prose.png` });
});

test("restores collection navigation and keeps list fallback", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, secondKey);
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1건 보존 불가");
  await expect(page.locator("#previous-post")).toBeEnabled();
  await expect(page.locator("#next-post")).toBeDisabled();

  await page.locator("#previous-post").click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 1/3 · 1건 보존 불가");
  await expect(page.locator("#previous-post")).toBeDisabled();
  await expect(page.locator("#next-post")).toBeEnabled();

  await page.goto(`/?fixture=standalone#${encodeURIComponent(standaloneKey)}`);
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("#collection-context")).toBeHidden();
  await expect(page.locator("#previous-post")).toBeDisabled();
  await expect(page.locator("#next-post")).toBeEnabled();
  await page.locator("#next-post").click();
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1건 보존 불가");
});

test("distinguishes a missing preserved object", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto(`/#${encodeURIComponent(missingKey)}`);
  await expect(page.locator("#archive-state")).toHaveText("본문 오류");
  await expect(page.locator("#empty-reader")).toContainText("보존 객체가 없습니다");
});
