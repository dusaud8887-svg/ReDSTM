import { expect, test } from "@playwright/test";

const release = "1".repeat(64);
const catalog = "2".repeat(64);
const docs = [2, 10].map((n) => ({
  identity: `manual:${String(n).padStart(64, "a")}`, title: `${n}화`,
  category: "작품/회차", board: "수동 문서", sha256: String(n).padStart(64, "b"),
  created_at: "2026-10-01T00:00:00Z", bytes: 100,
}));

test("manual folders preserve full bodies, natural file order and saved reading state", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload;
    if (path.endsWith("/release/manual")) payload = { schema: 1, lane: "manual", sha256: release };
    else if (path.endsWith(`/release-manifest/manual/${release}.json`)) payload = {
      schema: 1, lane: "manual", catalog_pages: [{ key: `published/indexes/manual/${catalog}.json`, sha256: catalog }],
    };
    else if (path.endsWith(`/index/manual/${catalog}.json`)) payload = { schema: 1, lane: "manual", items: docs };
    else {
      const doc = docs.find((item) => path.endsWith(`/object/${item.sha256}`));
      if (doc) return route.fulfill({ contentType: "text/markdown", body: `# 본문 첫 줄\n원본: 그대로 보관\n${doc.title} 본문\n${"긴 본문\n".repeat(80)}` });
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/text?lane=manual");
  await expect(page.locator('[data-source="manual"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#result-list .result-item").filter({ hasText: "작품/회차" }).click();
  await expect(page.locator("#result-list .result-title")).toHaveText(["2화", "10화"]);
  await expect(page.locator("#text-work-back")).toHaveText("← 폴더 목록");
  await page.locator("#result-list .result-item").filter({ hasText: "2화" }).click();
  await expect(page.locator("#archive-body")).toContainText("# 본문 첫 줄");
  await expect(page.locator("#archive-body")).toContainText("원본: 그대로 보관");
  await expect(page.locator("#reader-title")).toHaveText("2화");
  // A reload on the body goes straight to it: the list it is rebuilt from never shows on the way.
  await page.addInitScript(() => {
    window.listSeen = false;
    const sample = () => {
      if (document.body?.classList.contains("reading")) return;
      if ([...document.querySelectorAll("#result-list .result-item")].some((row) => row.checkVisibility({ visibilityProperty: true }))) window.listSeen = true;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.reload();
  await expect(page.locator("#archive-body")).toContainText("2화 본문");
  expect(await page.evaluate(() => window.listSeen)).toBe(false);
  await expect(page.locator("body")).not.toHaveClass(/restoring-text/);
  await page.locator("#next-post:visible, #reader-bottom-next:visible").first().click();
  await expect(page.locator("#reader-title")).toHaveText("10화");
  await page.goto("/text?lane=manual&category=작품%2F회차");
  await expect(page.locator("#result-list .result-title")).toHaveText(["2화", "10화"]);
  expect(errors).toEqual([]);
});

test("manual library is empty before its first publication", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/text/release/manual", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/text?lane=manual");
  await expect(page.locator("#result-list")).toContainText("아직 게시된 자료가 없습니다.");
  expect(errors).toEqual([]);
});

test("a long manual document renders in skippable chunks without changing its text", async ({ page }) => {
  const body = Array.from({ length: 6000 }, (_, index) => `${index + 1}번째 줄 — 긴 합본 본문입니다.`).join("\n");
  const doc = { ...docs[0], title: "합본", category: "합본", sha256: "c".repeat(64) };
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/release/manual")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ schema: 1, lane: "manual", sha256: release }) });
    if (path.endsWith(`/release-manifest/manual/${release}.json`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ schema: 1, lane: "manual", catalog_pages: [{ key: `published/indexes/manual/${catalog}.json`, sha256: catalog }] }) });
    if (path.endsWith(`/index/manual/${catalog}.json`)) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ schema: 1, lane: "manual", items: [doc] }) });
    if (path.endsWith(`/object/${doc.sha256}`)) return route.fulfill({ contentType: "text/markdown", body: body.repeat(2) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("/text?lane=manual&category=%ED%95%A9%EB%B3%B8");
  await page.locator("#result-list .result-item").filter({ hasText: "합본" }).click();
  await expect(page.locator("#archive-body > .text-chunk").first()).toBeAttached();
  expect(await page.locator("#archive-body > .text-chunk").count()).toBeGreaterThan(1);
  // Chunks end after a line break: the reading model sees exactly the original text.
  const modelText = await page.evaluate(async () =>
    (await import("/text-model.js")).createTextModel(document.querySelector("#archive-body")).text);
  expect(modelText).toBe(body.repeat(2));
});
