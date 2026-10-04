import { expect, test } from "@playwright/test";

import { useLongCollection } from "./typemoon-fixture.js";

// Regressions found by the 2026-10-04 mobile walkthrough (docs/27). Each test fails on the old
// behaviour it names.

test("the touch selection bar spans the dock and keeps each action on one line", async ({ page }) => {
  test.skip(!page.viewportSize() || page.viewportSize().width >= 760, "The dock-seat bar is the phone layout");
  await useLongCollection(page, 4);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#archive-body p").first()).toBeVisible();
  await page.evaluate(() => {
    // Touch screens always use the dock-seat bar; force the same branch on every phone project.
    const original = window.matchMedia;
    window.matchMedia = (query) => (query === "(pointer: coarse)" ? { matches: true, addEventListener() {}, removeEventListener() {} } : original(query));
    const paragraph = document.querySelectorAll("#archive-body p")[3];
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.querySelector("#reader-pane").dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  const menu = page.locator("#selection-menu");
  await expect(menu).toBeVisible();
  const width = page.viewportSize().width;
  const box = await menu.boundingBox();
  expect(Math.round(box.width)).toBe(width - 24);
  const wrapped = await menu.locator("button:not([hidden])").evaluateAll((buttons) =>
    buttons.filter((button) => button.getClientRects().length && button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent));
  expect(wrapped).toEqual([]);
  for (const button of await menu.locator("button:not([hidden])").all()) {
    expect((await button.boundingBox()).height).toBeLessThanOrEqual(52);
  }
});

test("each barcode legend swatch sits with its own word", async ({ page }) => {
  await useLongCollection(page, 12);
  await page.goto("/collections/1");
  const items = page.locator(".barcode-legend > span");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toHaveText("읽음");
  expect(await items.first().locator("i").count()).toBe(1);
});

test("필터 appears only when its sheet has a field", async ({ page }) => {
  test.skip(!page.viewportSize() || page.viewportSize().width >= 760, "The filter sheet is the narrow-screen presentation");
  await useLongCollection(page, 4);
  await page.goto("/browse");
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  // All boards, posts: 형식 is already the chip row, so the sheet would be empty.
  await expect(page.locator("#filter-toggle")).toBeHidden();
  await page.goto("/search?q=%ED%8E%B8");
  await expect(page.locator("#filter-toggle")).toBeVisible();
  await page.locator("#filter-toggle").click();
  await expect(page.locator("#filter-dialog-fields label:not([hidden])").first()).toBeVisible();
});

test("search before a query has one empty message, and 0 results say where and sit under the bar", async ({ page }) => {
  await useLongCollection(page, 4);
  await page.goto("/search");
  await expect(page.locator("#search-empty")).toBeVisible();
  await expect(page.locator("#result-bar")).toBeHidden();
  expect(await page.locator("#result-list").evaluate((list) => getComputedStyle(list, "::after").content)).toBe("none");
  await page.locator("#search-input").fill("없는단어xyz");
  await page.locator("#search-input").press("Enter");
  const widen = page.locator("#search-widen");
  await expect(widen).toBeVisible();
  await expect(widen.locator("p")).toContainText("전체 게시판 · 제목·작성자·분류에서 찾은 글이 없습니다");
  const bar = await page.locator("#result-bar").boundingBox();
  const lead = await widen.boundingBox();
  expect(lead.y - (bar.y + bar.height)).toBeLessThan(40);
});

test("a saved and finished post shows a saved icon and 다 읽음, never the phrase 저장 완료", async ({ page }) => {
  await useLongCollection(page, 4);
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    bookmarks: { "board_a:2": { savedAt: "2026-10-04T00:00:00.000Z" } },
    history: { "board_a:2": { readAt: "2026-10-04T00:00:00.000Z", progress: 1 } },
  })));
  await page.goto("/browse");
  const badges = page.locator(".result-item", { hasText: "2편 제목" }).locator(".result-badges");
  await expect(badges.locator(".saved-mark")).toHaveAttribute("aria-label", "저장한 글");
  await expect(badges).toHaveText("다 읽음");
});

test("a TypeMoon work counts its posts in 편 in both the header and the barcode", async ({ page }) => {
  await useLongCollection(page, 12);
  await page.goto("/collections/1");
  await expect(page.locator("#collection-barcode .barcode-summary")).toHaveText("12편 중 0편 읽음");
  await expect(page.locator(".barcode-legend")).toContainText("새 편");
});

test("기록 › 통계 without an account says to sign in and has no search field", async ({ page }) => {
  await useLongCollection(page, 4);
  await page.goto("/saved?view=stats");
  await expect(page.locator("#result-status")).toContainText("로그인을 확인하지 못해");
  await expect(page.locator("#catalog-search-row")).toBeHidden();
});
