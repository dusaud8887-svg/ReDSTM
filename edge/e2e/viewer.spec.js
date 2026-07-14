import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const firstHash = "1".repeat(64);
const secondHash = "2".repeat(64);
const standaloneHash = "3".repeat(64);
const firstKey = `posts/board_a/1-${firstHash}.json.zst`;
const secondKey = `posts/board_a/2-${secondHash}.json.zst`;
const standaloneKey = `posts/board_a/3-${standaloneHash}.json.zst`;
const aaKey = process.env.REDSTM_AA_KEY || firstKey;
const proseKey = process.env.REDSTM_PROSE_KEY || secondKey;

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
      body_html: [
        `<p class="legacy-prose" style="font: italic 10px/1.1 Arial !important"><font face="Arial" size="1">${title} 본문 1</font></p>`,
        ...Array.from({ length: 29 }, (_, index) => `<p>${title} 본문 ${index + 2}</p>`),
      ].join(""), is_aa: false,
    },
    comments: [],
  };
}

function aaPostPayload(id, title) {
  const payload = postPayload(id, title);
  payload.post.is_aa = true;
  payload.post.body_html = `<div class="AA_Text"><p><font color="#b4232f" style="font: bold 20px/2 Arial !important">${title}</font></p><p>（　´∀｀）</p><p>　|　　|</p></div>`;
  payload.comments = [
    {
      position: 1, author: "일반", created_at_raw: "2026-07-11",
      content_html: "<p>일반 댓글</p>", content_text: "일반 댓글", depth: 0,
    },
    {
      position: 2, author: "AA", created_at_raw: "2026-07-11",
      content_html: "<pre style=\"font-family: 'ＭＳ Ｐゴシック'\">（　´∀｀）\n /　 つ</pre>",
      content_text: "（　´∀｀）\n /　 つ", depth: 1,
    },
  ];
  return payload;
}

async function useCollectionFixture(page, { largeStandalone = false, legacyIndex = false, releaseGate } = {}) {
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
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", ...(legacyIndex ? [] : ["is_aa"])],
      posts: [
        ["board_a", 3, "비소속", "작성자", null, "2026-07-11", standaloneHash, false],
        ["board_a", 2, "둘째", "작성자", null, "2026-07-11", secondHash, false],
        ["board_a", 1, "첫째", "작성자", null, "2026-07-11", firstHash, true],
      ].map((row) => legacyIndex ? row.slice(0, -1) : row),
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
    if (key === "release.json" && releaseGate) await releaseGate();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function usePaginationFixture(page, count) {
  // Only the search index needs the rows; list entries never fetch a post body, so a large
  // board can be exercised without a payload per post.
  const posts = Array.from({ length: count }, (_, index) => {
    const id = count - index; // newest first, matching the default latest sort
    return ["board_a", id, `글 ${id}`, "작성자", null, "2026-07-11", String(id).padStart(64, "0"), false];
  });
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: "collections/e2e.json.zst" },
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts,
    }],
    ["collections/e2e.json.zst", { schema_version: 1, collections: [] }],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
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
  let releaseRequested;
  let releaseResponse;
  const requested = new Promise((resolve) => { releaseRequested = resolve; });
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
  await useCollectionFixture(page, {
    releaseGate: async () => {
      releaseRequested();
      await responseGate;
    },
  });
  await page.goto("/");
  await requested;
  await expect(page.locator("#result-list")).toHaveClass(/loading/);
  releaseResponse();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#result-list")).not.toHaveClass(/loading/);
});

test("pages a large board with load-more instead of stopping at the first page", async ({ page }) => {
  await usePaginationFixture(page, 150);
  await page.goto("/search");
  await expect(page.locator("#archive-state")).toHaveText("보존본");

  const items = page.locator(".result-item");
  await expect(items).toHaveCount(100);
  const more = page.locator("#result-more");
  await expect(more).toBeVisible();
  await expect(more).toContainText("남은 50");

  await more.click();

  await expect(items).toHaveCount(150);
  await expect(more).toBeHidden();
  // The already-loaded first page is kept and the next page is appended after it.
  await expect(items.first().locator(".result-title")).toHaveText("글 150");
  await expect(items.last().locator(".result-title")).toHaveText("글 1");
});

test("keeps the settings route symmetric", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  await expect(page.locator("#settings-ops")).toBeVisible();
  await expect(page.locator("#settings-ops")).toHaveAttribute("href", "/ops");
  await page.locator("#settings-dialog form").evaluate((form) => { form.scrollTop = form.scrollHeight; });
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await expect.poll(() => page.locator("#settings-dialog form").evaluate((form) => form.scrollTop)).toBe(0);
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
});

test("keeps primary navigation and Operations reachable at every breakpoint", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const width = page.viewportSize().width;
  const navigation = width >= 1200 ? ".rail nav" : width >= 760 ? ".app-bar" : ".bottom-nav";
  for (const destination of ["library", "search", "bookmarks", "settings"]) {
    await expect(page.locator(`${navigation} [data-destination="${destination}"]`)).toBeVisible();
  }
  const operations = page.locator(`${width >= 1200 ? ".rail" : ".app-bar"} a[href="/ops"]`);
  await expect(operations).toBeVisible();
  await expect(operations).toHaveAccessibleName(/운영/);
  if (width < 1200) await expect(operations).toContainText("운영");

  await page.locator(`${navigation} [data-destination="search"]`).click();
  await expect(page).toHaveURL(/\/search$/);
  await page.locator(`${navigation} [data-destination="bookmarks"]`).click();
  await expect(page).toHaveURL(/\/saved$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
  await page.locator(`${navigation} [data-destination="settings"]`).click();
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
  await page.locator(`${navigation} [data-destination="library"]`).click();
  await expect(page).toHaveURL(/\/$/);
});

test("restores search controls from the URL and browser history", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search?q=둘째&board=board_a&mode=prose&sort=oldest");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#search-input")).toHaveValue("둘째");
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator("#mode-filter")).toHaveValue("prose");
  await expect(page.locator("#sort-filter")).toHaveValue("oldest");
  await expect(page.locator(".result-item", { hasText: "둘째" })).toBeVisible();

  await page.locator("#sort-filter").selectOption("latest");
  await page.locator("#mode-filter").selectOption("aa");
  await page.locator("#search-input").fill("첫째");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("첫째");
  await expect.poll(() => page.evaluate(() => history.state?.redstmSearch)).toEqual({
    query: "첫째", boardId: "board_a", mode: "aa", sort: "latest",
  });
  await page.locator(".result-item", { hasText: "첫째" }).click();
  await expect(page).toHaveURL(/\/read\//);
  await page.goBack();
  await expect(page.locator("#search-input")).toHaveValue("첫째");
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator("#mode-filter")).toHaveValue("aa");
  await expect(page.locator("#sort-filter")).toHaveValue("latest");
});

test("restores catalog scroll and focused row after Reader Back", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const list = page.locator("#result-list");
  await list.evaluate((element) => {
    element.style.height = "100px";
    element.style.maxHeight = "100px";
  });
  const target = page.locator(".result-item").last();
  await target.focus();
  const expectedScroll = await list.evaluate((element) => element.scrollTop);
  expect(expectedScroll).toBeGreaterThan(0);
  const title = await target.locator(".result-title").innerText();
  await target.click();
  await expect(page.locator("#reader")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(expectedScroll);
  await expect(page.locator(".result-item:focus .result-title")).toHaveText(title);
});

test("normalizes AA mode on a legacy search index", async ({ page }) => {
  await useCollectionFixture(page, { legacyIndex: true });
  await page.goto("/search?mode=aa");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#mode-filter")).toBeDisabled();
  await expect(page.locator("#mode-filter")).toHaveValue("all");
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.locator(".result-item")).toHaveCount(3);
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

test("keeps saved and recent-reading routes distinct", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/saved");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".saved-tabs")).toBeVisible();
  await expect(page.locator('[data-view="bookmarks"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sort-field")).toBeHidden();
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-saved.png` });

  await page.locator('[data-view="history"]').click();
  await expect(page).toHaveURL(/\/saved\?view=recent$/);
  await page.reload();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator('[data-view="history"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#catalog-subtitle")).toHaveText("최근 읽은 글");

  await page.locator('[data-view="bookmarks"]').click();
  await expect(page).toHaveURL(/\/saved$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/saved\?view=recent$/);
  await expect(page.locator('[data-view="history"]')).toHaveAttribute("aria-pressed", "true");
});

test("shows the archive cover and uses a single-plane mobile reader", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#home-search")).toBeVisible();
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'),
  ).toHaveAttribute("content", "#ffffff");
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
  ).toHaveAttribute("content", "#0b0d12");

  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.rail a[href="/ops"]')).toBeVisible();
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator("#empty-reader")).toContainText("내 장서");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover.png" });
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const themeColors = page.locator('meta[name="theme-color"]');
    await expect(themeColors).toHaveCount(2);
    await expect(themeColors.first()).toHaveAttribute("content", "#0b0d12");
    await expect(themeColors.nth(1)).toHaveAttribute("content", "#0b0d12");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover-night.png" });
  } else {
    await expect(page.locator('.app-bar a[href="/ops"]')).toBeVisible();
  }
  await expect(page.locator('.home-operations[href="/ops"]')).toBeVisible();

  if (page.viewportSize().width < 760) {
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-home.png` });
  }
  await page.locator("#home-search").click();
  await expect(page.locator("#search-input")).toBeFocused();
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-explore.png` });
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page).toHaveURL(/\/read\/board_a\/3$/);
  await expect(page).toHaveTitle(/비소속/);
  await expect(page.locator("#reader-title")).toBeFocused();
  if (testInfo.project.name === "medium") {
    await expect(page.locator("body")).toHaveClass(/catalog-collapsed/);
    await expect(page.locator(".catalog")).toBeHidden();
    await page.locator("#catalog-toggle").click();
    await expect(page.locator(".catalog")).toBeVisible();
  }
  if (page.viewportSize().width >= 760) {
    await page.locator('button[data-destination="settings"]:visible').first().click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.locator("#settings-dialog button[aria-label='닫기']").click();
    await expect(page).toHaveURL(/\/read\/board_a\/3$/);
    await expect(page).toHaveTitle(/비소속/);
  }
  if (page.viewportSize().width <= 760) {
    await expect(page.locator(".catalog")).toBeHidden();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-reader.png` });
    await page.locator("#catalog-back").click();
    await expect(page.locator(".catalog")).toBeVisible();
    await expect(page.locator(".result-item:focus")).toBeVisible();
  }
});

test("keeps the DSOTM AA settings contract", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await openPost(page, firstKey);
  await expect(page.locator("#aa-controls")).toBeVisible();
  await expect(page.locator("#comment-count")).toHaveText("2");
  await expect(page.locator(".comment")).toHaveCount(2);
  await expect(page.locator(".comment-body.aa-comment")).toHaveCount(1);
  await expect(page.locator(".comment-body").first()).not.toHaveClass(/aa-comment/);
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("white-space", "pre");
  await expect(page.locator(".aa-canvas p").first()).toHaveCSS("margin-bottom", "0px");
  await expect(page.locator(".aa-canvas p").first()).toHaveCSS("line-height", "18px");
  const aaResult = page.locator(".result-item", { hasText: "첫째" });
  await expect(aaResult.locator(".result-badges")).toContainText("AA");
  await expect(aaResult.locator(".result-badges")).toContainText("읽음");
  const mobile = page.viewportSize().width < 760;
  await page.locator(mobile ? "#reader-bottom-settings" : "#reader-settings").click();
  await expect(page.locator('[data-aa-background="#f5f5f0"]')).toHaveText("아이보리");
  await expect(page.locator('[data-aa-background="#ffffff"]')).toHaveText("흰색");
  await expect(page.locator(".aa-color-picker")).toContainText("직접");
  expect(await page.locator(".aa-appearance").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator("#aa-background")).toHaveValue("#f5f5f0");
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(245, 245, 240)");
  await page.locator('[data-aa-preset="11:800"]').click();
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-inline-size")).toHaveText("11px");
  await expect(page.locator("#archive-body font")).toHaveCSS("font-size", "11px");
  await expect(page.locator("#archive-body font")).toHaveCSS("font-weight", "700");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("font-size", "11px");
  await page.locator('[data-aa-background="#ffffff"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#aa-source-styles").click();
  await expect(page.locator("#archive-body")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator(".comment-body.aa-comment")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator("#archive-body font")).not.toHaveCSS("color", "rgb(180, 35, 47)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(36, 37, 42)");
  await page.locator("#aa-background").evaluate((input) => {
    input.value = "#0b0d12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(123, 224, 162)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("color", "rgb(123, 224, 162)");
  await page.locator("#aa-background").evaluate((input) => {
    input.value = "#808080";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".aa-color-picker")).toHaveClass(/active/);
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("color", "rgb(0, 0, 0)");
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await page.reload();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-background")).toHaveValue("#808080");
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(128, 128, 128)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(0, 0, 0)");
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

test("applies and persists prose typography over legacy source styles", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, proseKey);
  await expect(page.locator("#aa-controls")).toBeHidden();
  await page.locator(page.viewportSize().width < 760 ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#theme-select").selectOption("light");
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(251, 250, 248)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(21, 23, 26)");
  await page.locator("#theme-select").selectOption("dark");
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(17, 19, 24)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(244, 246, 248)");
  await page.locator("#theme-select").selectOption("light");
  await page.locator("#prose-size").evaluate((input) => {
    input.value = "22";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#line-height").evaluate((input) => {
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#prose-font").selectOption("sans");

  const legacyProse = page.locator(".legacy-prose");
  await expect(legacyProse).toHaveCSS("font-size", "22px");
  await expect(legacyProse).toHaveCSS("line-height", "44px");
  await expect(legacyProse).toHaveCSS("font-style", "italic");
  expect(await legacyProse.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("SUIT");

  await page.reload();
  await expect(legacyProse).toHaveCSS("font-size", "22px");
  await expect(legacyProse).toHaveCSS("line-height", "44px");
  expect(await legacyProse.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("SUIT");
});

test("shows progress while receiving a large post", async ({ page }) => {
  await useCollectionFixture(page, { largeStandalone: true });
  await page.goto("/");
  await page.evaluate(() => {
    window.__redstmArchiveStates = [];
    const target = document.getElementById("archive-state");
    new MutationObserver(() => window.__redstmArchiveStates.push(target.textContent)).observe(target, { childList: true });
  });
  await page.locator("#home-search").click();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const states = await page.evaluate(() => window.__redstmArchiveStates);
  expect(states.some((state) => /^본문 \d+%$/.test(state))).toBe(true);
});

test("supports progress, immersive mode, and reader shortcuts", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-pane").evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    element.scrollTop = 130;
  });
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator("#reading-progress")).not.toHaveCSS("width", "0px");
  if (page.viewportSize().width < 760) {
    const scrollBy = (delta) => page.locator("#reader-pane").evaluate(async (element, amount) => {
      element.scrollTop += amount;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, delta);
    await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
    await page.locator("#reader-pane").dispatchEvent("pointerup");
    await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
    await scrollBy(20);
    await scrollBy(20);
    await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
    await scrollBy(10);
    await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
    await scrollBy(-10);
    await scrollBy(-10);
    await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
    await scrollBy(-10);
    await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
  }
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await expect(page.locator("#immersive-exit")).toBeFocused();
  if (page.viewportSize().width < 760) await page.locator("#immersive-exit").click();
  else await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await expect(page.locator("#reader-title")).toBeFocused();
  const settingsButton = page.locator(page.viewportSize().width < 760 ? "#reader-bottom-settings" : "#reader-settings");
  await settingsButton.click();
  await page.locator("#settings-immersive").click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#immersive-exit")).toBeFocused();
  await page.locator("#immersive-exit").click();
  await expect(settingsButton).toBeFocused();
  await page.locator("#reader-title").focus();
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

test("leaves immersive mode when browser Back returns to the catalog", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator("#home-search").click();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader-title")).toBeFocused();
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await expect(page.locator("#immersive-exit")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  if (page.viewportSize().width < 760) await expect(page.locator(".bottom-nav")).toBeVisible();
  else if (page.viewportSize().width < 1200) await expect(page.locator(".app-bar")).toBeVisible();
  else await expect(page.locator(".rail")).toBeVisible();
});

test("searches and renders a representative AA post", async ({ page }, testInfo) => {
  if (!process.env.REDSTM_AA_KEY) await useCollectionFixture(page);
  await openPost(page, aaKey);
  await expect(page.locator("#archive-body")).toHaveClass(/(^|\s)aa(\s|$)/);
  expect(await page.evaluate(async () => {
    await document.fonts.load("16px Saitamaar");
    return document.fonts.check("16px Saitamaar");
  })).toBe(true);
  const title = await page.locator("#reader-title").innerText();
  const query = title.match(/[가-힣]{2}/)?.[0];
  expect(query).toBeTruthy();

  await page.keyboard.press("/");
  await page.locator("#board-filter").selectOption(stableUrl(aaKey).split("/")[2]);
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
    await page.locator("#reader-bottom-bookmark").click();
  } else {
    await page.locator("#bookmark-post").click();
  }
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");

  const widthFits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(widthFits).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa.png` });
});

test("restores the reading position after immediate SPA switches", async ({ page }, testInfo) => {
  if (!process.env.REDSTM_PROSE_KEY) await useCollectionFixture(page);
  await openPost(page, proseKey);
  await expect(page.locator("#archive-body")).not.toHaveClass(/(^|\s)aa(\s|$)/);

  const available = await page.evaluate(() => {
    const target = document.getElementById("reader-pane");
    return target.scrollHeight - target.clientHeight;
  });
  expect(available).toBeGreaterThan(100);
  const title = await page.locator("#reader-title").innerText();
  const destinationPosition = await page.evaluate(() => {
    const target = document.getElementById("reader-pane");
    target.scrollTop = 300;
    const position = target.scrollTop;
    document.querySelector('[data-destination="library"]').click();
    return position;
  });
  expect(destinationPosition).toBeGreaterThan(200);
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.locator("#reader-title")).toHaveText(title);
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(destinationPosition - 20);

  if (!process.env.REDSTM_PROSE_KEY) {
    await expect(page.locator("#previous-post")).toBeEnabled();
    const postPosition = await page.evaluate(() => {
      const target = document.getElementById("reader-pane");
      target.scrollTop = 220;
      const position = target.scrollTop;
      document.getElementById("previous-post").click();
      return position;
    });
    await expect(page.locator("#reader-title")).toHaveText("첫째");
    await page.goBack();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(postPosition - 20);
  }

  await page.evaluate(() => { document.getElementById("reader-pane").scrollTop = 0; });
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-prose.png` });
});

test("restores collection navigation and keeps list fallback", async ({ page }) => {
  await useCollectionFixture(page);
  const mobile = page.viewportSize().width < 760;
  const previous = mobile ? "#reader-bottom-previous" : "#previous-post";
  const next = mobile ? "#reader-bottom-next" : "#next-post";
  if (mobile) {
    await page.goto("/");
    await expect(page.locator("#archive-state")).toHaveText("보존본");
    await page.locator('.bottom-nav [data-destination="search"]').click();
    await page.locator(".result-item", { hasText: "첫째" }).click();
    await page.locator(next).click();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await page.reload();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await page.locator("#reader-bottom-list").click();
    await expect(page).toHaveURL(/\/search$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  }

  await openPost(page, secondKey);
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1건 보존 불가");
  await expect(page.locator(previous)).toBeEnabled();
  await expect(page.locator(next)).toBeDisabled();

  await page.locator(previous).click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 1/3 · 1건 보존 불가");
  await expect(page.locator(previous)).toBeDisabled();
  await expect(page.locator(next)).toBeEnabled();
  if (mobile) {
    await page.locator("#reader-bottom-list").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#home-title")).toHaveText("내 장서");
  }

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

test("keeps Reader content open when local storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    };
  });
  await useCollectionFixture(page);

  await page.goto(stableUrl(secondKey));

  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#archive-body")).toContainText("둘째 본문 1");
  await expect(page.locator("#archive-state")).toHaveText("로컬 저장 실패");
});

test("distinguishes Access expiry from an archive failure", async ({ page }) => {
  await useAccessExpiredFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("로그인 필요");
  await expect(page.locator("#home-title")).toHaveText("로그인이 만료되었습니다");
  await expect(page.locator("#home-action")).toHaveText("다시 로그인");
});

test("preserves loaded Reader content while connectivity changes", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, secondKey);
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#archive-state")).toHaveText("오프라인");
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#archive-body")).toContainText("둘째 본문 1");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#archive-state")).toHaveText("보존본");
});
