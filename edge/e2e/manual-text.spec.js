import { expect, test } from "@playwright/test";

const release = "1".repeat(64);
const catalog = "2".repeat(64);
const docs = [2, 10].map((n) => ({
  identity: `manual:${String(n).padStart(64, "a")}`, title: `${n}화`,
  category: "작품/회차", board: "수동 문서", sha256: String(n).padStart(64, "b"),
  created_at: "2026-10-01T00:00:00Z", bytes: 100,
}));

for (const lane of ["manual", "arcalive"]) {
  test(`${lane} catalog loads pages in bounded groups without losing entries`, async ({ page }) => {
    const refs = Array.from({ length: 12 }, (_, index) => ({
      sha256: (index + 1).toString(16).padStart(64, "c"),
    })).map((ref) => ({ ...ref, key: `published/indexes/${lane}/${ref.sha256}.json` }));
    const workRefs = lane === "arcalive" ? Array.from({ length: 6 }, (_, index) => ({
      sha256: (index + 20).toString(16).padStart(64, "d"),
    })).map((ref) => ({ ...ref, key: `published/indexes/arcalive/${ref.sha256}.json` })) : [];
    let active = 0;
    let peak = 0;
    let completed = 0;
    await page.route("**/api/v1/text/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (value) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
      if (path.endsWith(`/release/${lane}`)) return json({ schema: 1, lane, sha256: release });
      if (path.endsWith(`/release-manifest/${lane}/${release}.json`)) return json({
        schema: 1, lane, catalog_pages: refs, work_catalog_pages: workRefs,
      });
      const index = refs.findIndex((ref) => path.endsWith(`/${ref.sha256}.json`));
      const workIndex = workRefs.findIndex((ref) => path.endsWith(`/${ref.sha256}.json`));
      if (index < 0 && workIndex < 0) return route.fulfill({ status: 404 });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 10 : 150));
      try {
        return await json(workIndex >= 0
          ? { schema: 1, lane, view: "works", items: [] }
          : { schema: 1, lane, items: [{ ...docs[0], identity: `manual:${String(index).padStart(64, "a")}`,
            title: `${index}화`, category: "작품/회차", board: "novel", post_id: index + 1 }] });
      } finally { active -= 1; completed += 1; }
    });
    await page.goto(`/text?lane=${lane}`);
    await expect.poll(() => completed).toBe(refs.length + workRefs.length);
    await expect(page.locator("#result-status")).not.toContainText("불러오는 중");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    const folder = page.locator("#result-list .result-item").filter({ hasText: lane === "manual" ? "작품/회차" : "novel" });
    await expect(folder).toContainText("12");
  });
}

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
  await expect(page.locator("#text-work-back")).toHaveText("폴더 목록");
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
  // 폴더 목록 goes up a level, also beside an open body (the list and body share the screen).
  const folderRow = page.locator("#result-list .result-item").filter({ hasText: "작품/회차" });
  await page.locator("#text-work-back").click();
  await expect(folderRow).toBeVisible();
  await folderRow.click();
  await page.locator("#result-list .result-item").filter({ hasText: "2화" }).click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  if (await page.locator("#text-work-back").isVisible()) {
    await page.locator("#text-work-back").click();
    await expect(folderRow).toBeVisible();
    await expect(page.locator("#reader-title")).toHaveText("2화");
    await expect(page).toHaveURL(/item=manual/);
  }
  expect(errors).toEqual([]);
});

test("documents without a folder are grouped by their title's first character", async ({ page }) => {
  const titles = ["가나다", "까치", "Zebra", "apple", "[태그]제목", "10년", "漢字", "あいう", "하늘"];
  const items = titles.map((title, index) => ({
    identity: `manual:${String(index).padStart(64, "e")}`, title, category: ".", board: "수동 문서",
    sha256: String(index).padStart(64, "f"), created_at: "2026-10-01T00:00:00Z", bytes: 10,
  }));
  items.push({ ...docs[0] });
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload) => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (path.endsWith("/release/manual")) return json({ schema: 1, lane: "manual", sha256: release });
    if (path.endsWith(`/release-manifest/manual/${release}.json`)) {
      return json({ schema: 1, lane: "manual", catalog_pages: [{ key: `published/indexes/manual/${catalog}.json`, sha256: catalog }] });
    }
    if (path.endsWith(`/index/manual/${catalog}.json`)) return json({ schema: 1, lane: "manual", items });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("/text?lane=manual");
  await expect(page.locator("#result-list .result-title")).toHaveText([
    "작품/회차", "폴더 없음 · 0–9·기호", "폴더 없음 · A–Z", "폴더 없음 · ㄱ", "폴더 없음 · ㅎ", "폴더 없음 · 가나", "폴더 없음 · 한자",
  ]);
  await expect(page.locator("#result-list .result-item").filter({ hasText: "폴더 없음 · 0–9·기호" })).toContainText("2개 글");
  await page.locator("#result-list .result-item").filter({ hasText: "폴더 없음 · ㄱ" }).click();
  await expect(page.locator("#result-list .result-title")).toHaveText(["가나다", "까치"]);
  // A link from before the groups still lists every document without a folder.
  await page.goto("/text?lane=manual&category=.");
  await expect(page.locator("#result-list .result-item")).toHaveCount(titles.length);
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
  // Page columns lay every chunk out. A skipped chunk has no line boxes, so the last
  // pages of a long text would be missing.
  await page.evaluate(() => document.querySelector("#quick-settings button[data-reading-mode='page']").click());
  await expect(page.locator("#reader")).toHaveClass(/paged/);
  const lastChunkLaidOut = await page.evaluate(() => {
    const chunks = [...document.querySelectorAll("#archive-body > .text-chunk")];
    const node = chunks.at(-1)?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(1, node.data.length));
    const rect = range.getClientRects()[0];
    return Boolean(rect && rect.width > 0);
  });
  expect(lastChunkLaidOut).toBe(true);
  await page.evaluate(() => document.querySelector("#quick-settings button[data-reading-mode='scroll']").click());
  await expect(page.locator("#reader")).not.toHaveClass(/paged/);
  // A place past the first chunk must come back, and must not be overwritten with the top.
  const savedScroll = await page.evaluate(() => {
    const pane = document.querySelector("#reader-pane");
    const chunks = [...document.querySelectorAll("#archive-body > .text-chunk")];
    const target = chunks[1];
    for (const chunk of chunks) {
      chunk.style.contentVisibility = "visible";
      if (chunk === target) break;
    }
    const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = top + 80;
    return pane.scrollTop;
  });
  expect(savedScroll).toBeGreaterThan(2000);
  await page.waitForFunction((target) => {
    const state = JSON.parse(localStorage.getItem("redstm.textState.v1") || "null");
    const record = Object.values(state?.history || {})[0];
    return Boolean(record?.loc) && Math.abs(record.scroll - target) < 2;
  }, savedScroll);
  await page.reload();
  await expect(page.locator("#archive-body")).toContainText("번째 줄");
  await expect(page.locator("body")).not.toHaveClass(/restoring-text/);
  await page.waitForFunction((target) => {
    const pane = document.querySelector("#reader-pane");
    return pane && Math.abs(pane.scrollTop - target) < 80;
  }, savedScroll);
  await page.waitForTimeout(700);
  const kept = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("redstm.textState.v1") || "null");
    return Object.values(state?.history || {})[0]?.scroll ?? 0;
  });
  expect(kept).toBeGreaterThan(2000);
});
