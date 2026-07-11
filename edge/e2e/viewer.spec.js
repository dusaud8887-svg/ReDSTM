import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const aaKey = process.env.REDSTM_AA_KEY ||
  "posts/aa_19/351495-b43dec5cddddbd48c627717b51523ab02a6ac989e8634312ba1e4937b614bf19.json.gz";
const proseKey = process.env.REDSTM_PROSE_KEY ||
  "posts/ss_19/189648-9a700c99351f57b2298b4420f20df3663329666c1149e873c2f396ea1fe7266d.json.gz";

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
