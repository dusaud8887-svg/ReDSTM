import { expect, test } from "@playwright/test";

import { novelWork, useTextArchive } from "./text-fixture.js";
import { postPayload, useLongCollection } from "./typemoon-fixture.js";

// Linux CI owns the baselines. Windows comparison is explicitly opt-in.
if (process.env.VISUAL === "1") {
  const screens = [
    ["home", "/", "#latest-list li"],
    ["browse", "/browse", "#result-list .result-item"],
    ["search", "/search?q=제목", "#result-list .result-item"],
    ["records", "/saved?view=reading", "#result-status"],
    ["work", "/collections/1", "#collection-title"],
    ["reader", "/read/board_a/2", "#archive-body p"],
    ["aa", "/read/board_a/1", ".aa-canvas"],
    ["settings", "/read/board_a/2", "#archive-body p"],
  ];
  for (const width of [384, 768, 1440]) {
    for (const theme of ["light", "dark"]) {
      for (const [screen, route, ready] of screens) {
        test(`${screen} ${theme} ${width}`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
          await page.clock.setFixedTime(new Date("2026-09-30T03:00:00Z"));
          await useLongCollection(page, 12);
          await useTextArchive(page, { novels: [novelWork({ id: 1, title: "시각 기준 작품", chapters: 3 })] });
          await page.route("**/archive/posts/board_a/1-*", (request) => {
            const payload = postPayload(1);
            payload.post.is_aa = true;
            payload.post.body_html = '<div class="AA_Text">（　´∀｀）\n　|　　|\n<span style="color:#b4232f">格子 보존</span></div>';
            return request.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
          });
          await page.goto(route);
          await expect(page.locator("#archive-state")).toHaveText("보존본");
          await expect(page.locator(ready).first()).toBeVisible();
          if (screen === "settings") {
            await page.locator(width < 760 ? "#reader-bottom-settings" : "#reader-settings").click();
            await expect(page.locator("#settings-dialog")).toBeVisible();
          }
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`${screen}-${theme}-${width}.png`, { animations: "disabled" });
        });
      }
    }
  }
}
