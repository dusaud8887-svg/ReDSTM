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

function stableUrl(key) {
  const match = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-/.exec(key);
  if (!match) throw new Error(`Invalid post key: ${key}`);
  return `/read/${match[1]}/${match[2]}`;
}

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

async function useCollectionFixture(page, { largeStandalone = false, releaseDelayMs = 0 } = {}) {
  const standalone = postPayload(3, "비소속");
  if (largeStandalone) standalone.transfer_padding = "x".repeat(1_100_000);
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: "collections/e2e.json.zst" },
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: [
        ["board_a", 3, "비소속", "작성자", null, "2026-07-11", standaloneHash, false],
        ["board_a", 2, "둘째", "작성자", null, "2026-07-11", secondHash, false],
        ["board_a", 1, "첫째", "작성자", null, "2026-07-11", firstHash, true],
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
    [standaloneKey, standalone],
  ]);
  await page.route("**/archive/**", async (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    if (key === "release.json" && releaseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, releaseDelayMs));
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function useAccessExpiredFixture(page) {
  await page.route("**/archive/**", (route) => route.fulfill({ status: 403, body: "expired" }));
}

async function openPost(page, key) {
  await page.goto(stableUrl(key));
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#empty-reader")).toBeHidden();
  await expect(page.locator("#archive-body")).not.toBeEmpty();
}

test.beforeAll(async () => {
  await mkdir(".wrangler/screenshots", { recursive: true });
});

test("shows a row skeleton until the archive index is ready", async ({ page }) => {
  await useCollectionFixture(page, { releaseDelayMs: 400 });
  await page.goto("/");
  await expect(page.locator("#result-list")).toHaveClass(/loading/);
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#result-list")).not.toHaveClass(/loading/);
});

test("keeps the settings route symmetric", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await expect(page).toHaveURL(/\/$/);
});

test("reviews a state import before applying it", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await page.locator("#theme-select").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const state = {
    schema_version: 2,
    settings: { theme: "dark", aaSize: 99 },
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z" } },
    bookmarks: {}, scroll: { "board_a:1": 120 }, viewModes: {}, lastCatalogState: null,
  };
  await page.locator("#import-state-file").setInputFiles({
    name: "redstm-state.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(state)),
  });
  await expect(page.locator("#import-review")).toBeVisible();
  await expect(page.locator("#import-review-summary")).toContainText("읽기 1");
  await expect(page.locator("#import-review-summary")).toContainText("기본값 보정");
  await expect(page.locator("#import-review-summary")).toContainText("AA 크기");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-import-review.png` });
  await page.locator("#import-apply").click();
  await expect(page.locator("#import-review")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#import-review-summary")).toHaveText("사용자 상태를 가져왔습니다");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#import-cancel").click();
  await expect(page.locator("#import-review")).toBeHidden();
});

test("shows the archive cover and uses a single-plane mobile reader", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#home-search")).toBeVisible();

  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.rail a[href="/ops"]')).toBeVisible();
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator("#empty-reader")).toContainText("다시 읽고 싶은 기록");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover.png" });
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0d12");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover-night.png" });
  }

  if (page.viewportSize().width < 760) {
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-home.png` });
    await page.locator("#home-search").click();
    await expect(page.locator("#search-input")).toBeFocused();
  }
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page).toHaveURL(/\/read\/board_a\/3$/);
  if (testInfo.project.name === "medium") {
    await expect(page.locator("body")).toHaveClass(/catalog-collapsed/);
    await expect(page.locator(".catalog")).toBeHidden();
    await page.locator("#catalog-toggle").click();
    await expect(page.locator(".catalog")).toBeVisible();
  }
  if (page.viewportSize().width <= 760) {
    await expect(page.locator(".catalog")).toBeHidden();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-reader.png` });
    await page.locator("#catalog-back").click();
    await expect(page.locator(".catalog")).toBeVisible();
    await expect(page.locator("#search-input")).toBeFocused();
  }
});

test("keeps the DSOTM AA settings contract", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await openPost(page, firstKey);
  await expect(page.locator("#aa-controls")).toBeVisible();
  const aaResult = page.locator(".result-item", { hasText: "첫째" });
  await expect(aaResult.locator(".result-badges")).toContainText("AA");
  await expect(aaResult.locator(".result-badges")).toContainText("읽음");
  const mobile = page.viewportSize().width < 760;
  await page.locator(mobile ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator('[data-aa-preset="11:800"]').click();
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-inline-size")).toHaveText("11px");
  await page.locator('[data-aa-background="#ffffff"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#aa-source-styles").click();
  await expect(page.locator("#archive-body")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator("#archive-body font")).not.toHaveCSS("color", "rgb(180, 35, 47)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(36, 37, 42)");
  await page.locator("#aa-background").evaluate((input) => {
    input.value = "#0b0d12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(123, 224, 162)");
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await page.reload();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  if (mobile) await page.locator("#reader-bottom-settings").click();
  await page.locator(mobile ? "#settings-mode" : "#mode-toggle").click();
  await expect(page.locator(mobile ? "#settings-mode-reset" : "#mode-reset")).toBeVisible();
  if (mobile) await page.locator("#settings-dialog button[aria-label='닫기']").click();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(false);
  await expect(page.locator("#aa-controls")).toBeHidden();
  await page.reload();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(false);
  if (mobile) await page.locator("#reader-bottom-settings").click();
  await page.locator(mobile ? "#settings-mode-reset" : "#mode-reset").click();
  if (mobile) await page.locator("#settings-dialog button[aria-label='닫기']").click();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa-fixture.png` });
});

test("shows progress while receiving a large post", async ({ page }) => {
  await useCollectionFixture(page, { largeStandalone: true });
  await page.goto("/");
  await page.evaluate(() => {
    window.__redstmArchiveStates = [];
    const target = document.getElementById("archive-state");
    new MutationObserver(() => window.__redstmArchiveStates.push(target.textContent)).observe(target, { childList: true });
  });
  if (page.viewportSize().width < 760) await page.locator("#home-search").click();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const states = await page.evaluate(() => window.__redstmArchiveStates);
  expect(states.some((state) => /^본문 \d+%$/.test(state))).toBe(true);
});

test("supports progress, immersive mode, and reader shortcuts", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-pane").evaluate((element) => { element.scrollTop = 300; });
  await expect(page.locator("#reading-progress")).not.toHaveCSS("width", "0px");
  if (page.viewportSize().width < 760) {
    await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
    await page.locator("#archive-body p").nth(10).click();
    await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
  }
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await page.keyboard.press("b");
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".result-item", { hasText: "비소속" }).locator(".result-badges")).toContainText("저장");
  await page.keyboard.press("/");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".result-item").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#reader")).toBeVisible();
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

  await page.keyboard.press("/");
  await page.locator("#board-filter").selectOption("aa_19");
  await page.locator("#search-input").fill(query);
  await expect(page.locator(".result-item", { hasText: title })).toBeVisible();
  await page.locator(".result-item", { hasText: title }).click();

  const mobile = page.viewportSize().width < 760;
  await page.locator(mobile ? "#reader-bottom-settings" : "#reader-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#export-state")).toBeVisible();
  await expect(page.locator("#import-state")).toBeVisible();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  if (mobile) {
    await page.locator("#reader-bottom-settings").click();
    await page.locator("#settings-bookmark").click();
    await page.locator("#settings-dialog button[aria-label='닫기']").click();
  } else {
    await page.locator("#bookmark-post").click();
  }
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
  const mobile = page.viewportSize().width < 760;
  const previous = mobile ? "#reader-bottom-previous" : "#previous-post";
  const next = mobile ? "#reader-bottom-next" : "#next-post";
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1건 보존 불가");
  await expect(page.locator(previous)).toBeEnabled();
  await expect(page.locator(next)).toBeDisabled();

  await page.locator(previous).click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 1/3 · 1건 보존 불가");
  await expect(page.locator(previous)).toBeDisabled();
  await expect(page.locator(next)).toBeEnabled();

  await page.goto(`/?fixture=standalone#${encodeURIComponent(standaloneKey)}`);
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("#collection-context")).toBeHidden();
  await expect(page.locator(previous)).toBeDisabled();
  await expect(page.locator(next)).toBeEnabled();
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1건 보존 불가");
});

test("distinguishes a missing preserved object", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/read/board_a/404");
  await expect(page.locator("#archive-state")).toHaveText("본문 오류");
  await expect(page.locator("#empty-reader")).toContainText("현재 보존본에서 글을 찾을 수 없습니다");
});

test("distinguishes Access expiry from an archive failure", async ({ page }) => {
  await useAccessExpiredFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("로그인 필요");
  await expect(page.locator("#home-title")).toHaveText("로그인이 만료되었습니다");
  await expect(page.locator("#home-action")).toHaveText("다시 로그인");
});

test("shows an offline recovery state", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#archive-state")).toHaveText("오프라인");
  await expect(page.locator("#home-title")).toHaveText("오프라인입니다");
  await expect(page.locator("#home-action")).toHaveText("다시 시도");
});
