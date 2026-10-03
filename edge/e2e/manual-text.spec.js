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
  await page.reload();
  await expect(page.locator("#archive-body")).toContainText("2화 본문");
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
