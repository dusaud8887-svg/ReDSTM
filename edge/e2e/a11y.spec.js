import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { arcalivePost, arcaliveWork, novelWork, useTextArchive } from "./text-fixture.js";
import { useLongCollection } from "./typemoon-fixture.js";

// Automated WCAG 2.1 A/AA checks (axe-core) on each main screen and dialog. Rules that need a
// person (reading order, meaningful names) stay with the manual review in docs/19.

async function expectAccessible(page, label) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = results.violations.map((violation) =>
    `${label}: ${violation.id} (${violation.impact}) ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(", ")}`);
  if (process.env.REDSTM_AXE_REPORT) {
    for (const violation of results.violations) {
      for (const node of violation.nodes) console.log(`AXE|${label}|${violation.id}|${node.target.join(" ")}|${node.any?.[0]?.message ?? ""}`);
    }
    return;
  }
  expect(violations).toEqual([]);
}

async function useArchives(page) {
  await useLongCollection(page, 12);
  const posts = [101, 102, 103].map((id, index) => arcalivePost({ id, title: `긴 연재 ${index + 1}화` }));
  await useTextArchive(page, {
    novels: [novelWork({ id: 1, title: "첫 소설", chapters: 30 }), novelWork({ id: 2, title: "둘째 소설", chapters: 3, site: "blacktoon" })],
    posts, works: [arcaliveWork({ key: "long", title: "긴 연재", posts })],
  });
}

const mobileWidth = (page) => page.viewportSize().width < 760;

test("home, browse, search, and the work table of contents", async ({ page }) => {
  await useArchives(page);
  await page.goto("/");
  await expect(page.locator("#latest-list li").first()).toBeVisible();
  await expectAccessible(page, "home");
  await page.goto("/browse");
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  await expectAccessible(page, "browse");
  await page.goto("/search?q=%EC%A0%9C%EB%AA%A9");
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  await expectAccessible(page, "search");
  await page.goto("/collections/1");
  await expect(page.locator("#collection-title")).toHaveText("긴 연재");
  await expectAccessible(page, "collection");
  await page.goto("/saved?view=reading");
  await expectAccessible(page, "saved");
});

test("the Reader, its settings and 더보기 sheets", async ({ page }) => {
  await useArchives(page);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expectAccessible(page, "reader");
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expectAccessible(page, "settings");
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#reader-more")).toBeVisible();
  await expectAccessible(page, "more");
});

test("the text library lists, a work, and a chapter", async ({ page }) => {
  await useArchives(page);
  await page.goto("/text?lane=novel");
  await expect(page.locator("#result-list .result-item[data-key]").first()).toBeVisible();
  await expectAccessible(page, "novel works");
  await page.locator("#result-list .result-item[data-key]", { hasText: "첫 소설" }).click();
  await expect(page.locator("#text-work-summary .text-work-summary")).toBeVisible();
  await expectAccessible(page, "novel chapters");
  await page.locator('#result-list [data-key="chapter:1-2"]').click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  await expectAccessible(page, "novel chapter");
  await page.goto("/text?lane=novel");
  await page.locator(".shelf-edit").first().click();
  await expect(page.locator("#shelf-dialog")).toBeVisible();
  await expectAccessible(page, "shelf dialog");
  await page.locator("#shelf-dialog button[aria-label='닫기']").click();
  await page.locator('[data-novel-view="shelves"]').click();
  await expect(page.locator("#result-status")).toContainText("분류");
  await expectAccessible(page, "shelf folders");
  await page.goto("/text?lane=arcalive&view=works");
  await expect(page.locator("#result-list .result-item[data-key]").first()).toBeVisible();
  await expectAccessible(page, "arcalive works");
});

test("dark theme screens and the operations page", async ({ page }) => {
  await useArchives(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/browse");
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  await expectAccessible(page, "dark browse");
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expectAccessible(page, "dark reader");
  await page.goto("/text?lane=novel");
  await expect(page.locator("#result-list .result-item[data-key]").first()).toBeVisible();
  await expectAccessible(page, "dark text");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/ops");
  await expect(page.locator("h1").first()).toBeVisible();
  await expectAccessible(page, "ops");
});
