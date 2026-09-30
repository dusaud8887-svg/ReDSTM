import { expect, test } from "@playwright/test";

import { useLongCollection } from "./typemoon-fixture.js";

// Tracing snapshots all 10,000 rows on every step, which measures the recorder instead of the app.
test.use({ trace: "off" });

// T18: a 3,000-episode table of contents keeps far jumps inside the budget, focuses the stable
// row, and brings the reader back to it after Back.
test("A 3,000-episode table of contents jumps far within budget and restores the row after Back", async ({ page }) => {
  await useLongCollection(page, 3000);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.goto("/collections/1");
  await expect(page.locator('.collection-entry[data-key="3000"]')).toBeAttached();
  const jump = await page.evaluate(async () => {
    const input = document.querySelector("#collection-jump-input");
    input.value = "2800";
    const started = performance.now();
    document.querySelector("#collection-jump").requestSubmit();
    // The jump scrolls and focuses synchronously; reading the row's box forces the layout.
    const row = document.querySelector('.collection-entry[data-key="2800"]').getBoundingClientRect();
    return { ms: performance.now() - started, visible: row.top >= 0 && row.bottom <= innerHeight };
  });
  expect(jump.ms).toBeLessThan(300);
  expect(jump.visible).toBe(true);
  await expect(page.locator('.collection-entry[data-key="2800"]')).toBeFocused();
  await page.locator('.collection-entry[data-key="2800"]').click();
  await expect(page.locator("#reader-title")).toHaveText("2800편 제목");
  await page.goBack();
  const row = page.locator('.collection-entry[data-key="2800"]');
  await expect(row).toBeInViewport();
});
