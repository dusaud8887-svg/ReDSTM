import { gunzipSync } from "node:zlib";

import { expect, test } from "@playwright/test";

import { arcalivePost, arcaliveWork, novelWork, useTextArchive } from "./text-fixture.js";
import { collectionIndexKey, hashFor, postPayload, useLongCollection } from "./typemoon-fixture.js";

// Reading-flow contracts from docs/19: one history entry per reading session, Back returns to
// the list viewport the session started from, and reading order never follows the list sort.

async function useLongNovel(page, count) {
  const releaseHash = "d".repeat(64);
  const catalogHash = "e".repeat(64);
  const detailHash = "c".repeat(64);
  const workId = "novel:fixture:long";
  const bodyHash = (number) => number.toString(16).padStart(64, "a");
  const chapters = Array.from({ length: count }, (_, index) => ({
    chapter_id: String(index + 1), label: `${index + 1}화`, kind: "main",
    source_site: "fixture", source_chapter_id: String(index + 1), sha256: bodyHash(index + 1),
  }));
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload;
    if (path.endsWith("/release/novel")) payload = { schema: 1, lane: "novel", sha256: releaseHash };
    else if (path.endsWith(`/release-manifest/novel/${releaseHash}.json`)) payload = {
      schema: 1, lane: "novel", catalog_pages: [{ key: `published/indexes/novel/${catalogHash}.json`, sha256: catalogHash }],
    };
    else if (path.endsWith(`/index/novel/${catalogHash}.json`)) payload = {
      schema: 1, lane: "novel",
      items: [{ work_id: workId, title: "긴 소설", author: "작가", chapter_count: count, detail_key: `published/indexes/novel/${detailHash}.json` }],
    };
    else if (path.endsWith(`/index/novel/${detailHash}.json`)) payload = { schema: 1, lane: "novel", work: { work_id: workId }, chapters };
    else {
      const object = /\/object\/([a-f0-9]{64})$/.exec(path);
      const chapter = object && chapters.find((entry) => entry.sha256 === object[1]);
      if (chapter) {
        return route.fulfill({
          contentType: "text/markdown",
          body: `# 긴 소설-${chapter.label}\n# https://novel.example/${chapter.chapter_id}\n\n${chapter.label} 첫 줄\n${"본문 줄\n".repeat(80)}`,
        });
      }
      return route.fulfill({ status: 404, body: "not found" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  return workId;
}

function rowOffset(scrollerSelector, rowSelector) {
  return (page) => page.evaluate(([scrollerQuery, rowQuery]) => {
    const scroller = document.querySelector(scrollerQuery);
    const row = document.querySelector(rowQuery);
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop;
  }, [scrollerSelector, rowSelector]);
}

const mobileWidth = (page) => page.viewportSize().width < 760;

for (const closeWatcher of [true, false]) {
  test(`T03/T04: nested native overlays close one layer at a time (CloseWatcher ${closeWatcher})`, async ({ page }) => {
    if (!closeWatcher) await page.addInitScript(() => { window.CloseWatcher = undefined; });
    await useLongCollection(page, 3);
    await page.goto("/read/board_a/2");
    await expect(page.locator("#reader-title")).toHaveText("2편 제목");
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(async () => {
      const { createOverlayManager } = await import("/overlay-manager.js");
      const manager = createOverlayManager();
      const bar = document.createElement("aside");
      bar.id = "fixture-find";
      bar.hidden = true;
      bar.textContent = "찾기 ";
      const close = document.createElement("button");
      close.textContent = "찾기 닫기";
      close.addEventListener("click", () => manager.closeTop("cancel"));
      bar.append(close);
      const open = document.createElement("button");
      open.id = "fixture-open-find";
      open.textContent = "찾기 열기";
      Object.assign(open.style, { position: "fixed", left: "4px", top: "4px", zIndex: "100" });
      open.addEventListener("click", () => {
        manager.openBar("find", () => { bar.hidden = true; });
        bar.hidden = false;
      });
      document.getElementById("reader").append(open, bar);
      document.addEventListener("keydown", (event) => manager.handleEscape(event));
      const sheet = document.getElementById("settings-dialog");
      manager.watch(sheet);
      const menu = document.createElement("div");
      menu.id = "fixture-menu";
      menu.setAttribute("popover", "auto");
      const menuClose = document.createElement("button");
      menuClose.textContent = "메뉴 닫기";
      menuClose.addEventListener("click", () => manager.closeTop("cancel"));
      menu.append(menuClose);
      manager.watch(menu, "popover");
      const menuOpen = document.createElement("button");
      menuOpen.id = "fixture-open-menu";
      menuOpen.type = "button";
      menuOpen.textContent = "메뉴 열기";
      menuOpen.addEventListener("click", () => menu.showPopover());
      sheet.querySelector("form").prepend(menuOpen, menu);
    });
    await page.locator("#fixture-open-find").click();
    await expect(page.locator("#fixture-find")).toBeVisible();
    await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
    await page.locator("#quick-all-settings").click();
    await page.locator("#fixture-open-menu").click();
    await expect(page.locator("#fixture-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#fixture-menu")).toBeHidden();
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(page.locator("#fixture-find")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await expect(page.locator("#fixture-find")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#fixture-find")).toBeHidden();
    await expect(page.locator("#reader-title")).toHaveText("2편 제목");
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    if (!closeWatcher) {
      await page.locator("#fixture-open-find").click();
      await page.getByRole("button", { name: "찾기 닫기", exact: true }).click();
      await expect(page.locator("#fixture-find")).toBeHidden();
    }
  });
}

test("T20: a script scroll survives late fonts and images and saves its progress", async ({ page }) => {
  const workId = await useLongNovel(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const top = await page.locator("#reader-pane").evaluate((pane) => new Promise((resolve) => {
    document.fonts.dispatchEvent(new Event("loading"));
    pane.addEventListener("scroll", () => {
      document.fonts.dispatchEvent(new Event("loadingdone"));
      const image = document.createElement("img");
      image.hidden = true;
      document.getElementById("archive-body").append(image);
      image.dispatchEvent(new Event("load"));
      image.remove();
      resolve(pane.scrollTop);
    }, { once: true });
    pane.scrollTop = 999;
  }));
  expect(top).toBe(999);
  const record = () => page.evaluate((key) => JSON.parse(localStorage.getItem("redstm.textState.v1")).history[key], `novel:${workId}:1`);
  await expect.poll(async () => (await record()).scroll).toBe(999);
  expect((await record()).progress).toBeGreaterThan(0);
  expect((await record()).loc.start).toBeGreaterThan(0);
});

test("T20: a font completion before the queued scroll event cannot undo the move", async ({ page }) => {
  const workId = await useLongNovel(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const top = await page.locator("#reader-pane").evaluate((pane) => {
    document.fonts.dispatchEvent(new Event("loading"));
    pane.scrollTop = 999;
    document.fonts.dispatchEvent(new Event("loadingdone"));
    return pane.scrollTop;
  });
  expect(top).toBe(999);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem("redstm.textState.v1")).history[key]?.scroll,
    `novel:${workId}:1`)).toBe(999);
});

test("T34: the keyboard pauses position saves and chrome folding, then saves resume", async ({ page }) => {
  const workId = await useLongNovel(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#more-note").click();
  await expect(page.locator("#bookmark-note")).toBeFocused();
  const record = () => page.evaluate((key) => JSON.parse(localStorage.getItem("redstm.textState.v1")).history[key], `novel:${workId}:1`);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const before = await record();
  const folded = await page.locator("body").evaluate((body) => body.classList.contains("reader-controls-hidden"));
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, get: () => innerHeight / 2 });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("body")).toHaveClass(/keyboard-open/);
  await page.locator("#bookmark-note").fill("키보드 입력 중");
  await page.locator("#reader-pane").evaluate((pane) => new Promise((resolve) => {
    pane.addEventListener("scroll", () => { window.dispatchEvent(new Event("pagehide")); resolve(); }, { once: true });
    pane.scrollTop = 999;
  }));
  expect(await record()).toEqual(before);
  expect(await page.locator("body").evaluate((body) => body.classList.contains("reader-controls-hidden"))).toBe(folded);
  await page.evaluate(() => {
    delete window.visualViewport.height;
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await record()).scroll).toBe(999);
});

test("TypeMoon: 200 → next → next → Back returns to the same table-of-contents viewport", async ({ page }) => {
  await useLongCollection(page, 300);
  await page.goto("/collections/1");
  await expect(page.locator("#collection-title")).toHaveText("긴 연재");
  const anchorOffset = rowOffset("#reader-pane", '.collection-entry[data-key="198"]');
  await page.locator('.collection-entry[data-key="198"]').evaluate((row) => {
    const pane = document.getElementById("reader-pane");
    pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 40;
  });
  const before = await anchorOffset(page);
  const historyLength = await page.evaluate(() => history.length);

  await page.locator('.collection-entry[data-key="200"]').click();
  await expect(page.locator("#reader-title")).toHaveText("200편 제목");
  const next = mobileWidth(page) ? "#reader-bottom-next" : "#next-post";
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("201편 제목");
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("202편 제목");
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);

  await page.goBack();
  await expect(page.locator("#collection-view")).toBeVisible();
  await expect.poll(async () => Math.abs(await anchorOffset(page) - before)).toBeLessThanOrEqual(4);
  await expect(page.locator('.collection-entry[data-key="202"]')).toHaveClass(/current/);

  await page.goForward();
  await expect(page.locator("#reader-title")).toHaveText("202편 제목");
  // The in-app list button takes the same route as system Back.
  await page.locator(mobileWidth(page) ? "#reader-bottom-list" : "#end-list").click();
  await expect(page.locator("#collection-view")).toBeVisible();
  await expect.poll(async () => Math.abs(await anchorOffset(page) - before)).toBeLessThanOrEqual(4);
});

test("TypeMoon: the chapter-end card leads to the next episode before comments", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/collections/1");
  await page.locator('.collection-entry[data-key="1"]').click();
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await expect(page.locator("#end-next-kicker")).toHaveText("다음 편");
  await expect(page.locator("#end-next-title")).toHaveText("2편 제목");
  const order = await page.evaluate(() => {
    const end = document.getElementById("chapter-end");
    const comments = document.getElementById("comments");
    return Boolean(end.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  await expect(page.locator("#end-toc")).toBeVisible();
  await page.locator("#end-toc").click();
  await expect(page.locator("#collection-view")).toBeVisible();
  await expect(page).toHaveURL(/\/collections\/1$/);
});

test("Text: list sort never changes 다음 화, and Back restores the chapter list viewport", async ({ page }) => {
  const workId = await useLongNovel(page, 300);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  // Show newest first; reading order must stay 200 → 201.
  await page.locator("#sort-filter").evaluate((select) => {
    select.value = "latest";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#result-list .result-item[data-key] .result-title").first()).toHaveText("300화");
  const row = '#result-list [data-key="chapter:200"]';
  await page.locator(row).evaluate((element) => {
    const list = document.getElementById("result-list");
    list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 60;
  });
  const anchorOffset = rowOffset("#result-list", row);
  const before = await anchorOffset(page);

  await page.locator(row).click();
  await expect(page.locator("#reader-title")).toHaveText("200화");
  await expect(page.locator("#archive-body")).not.toContainText("https://novel.example");
  await expect(page.locator("#more-source")).toHaveAttribute("href", "https://novel.example/200");
  const next = mobileWidth(page) ? "#reader-bottom-next" : "#next-post";
  await expect(page.locator(next)).toHaveAccessibleName(/다음 화: 201화/);
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("201화");
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("202화");

  await page.goBack();
  await expect(page.locator("#reader")).toBeHidden();
  await expect(page.locator(row)).toBeVisible();
  await expect.poll(async () => Math.abs(await anchorOffset(page) - before)).toBeLessThanOrEqual(4);
  await expect(page.locator("#result-list .continue-row")).toContainText("202화");
});

test("Text: the chapter end offers the next chapter and the chapter list", async ({ page }) => {
  const workId = await useLongNovel(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=3`);
  await expect(page.locator("#reader-title")).toHaveText("3화");
  await expect(page.locator("#end-next-kicker")).toHaveText("현재 보존된 마지막 회차");
  await expect(page.locator("#end-next-title")).toHaveText("회차 목록으로");
  await page.locator("#end-previous").click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  await expect(page.locator("#end-next-title")).toHaveText("3화");
  await page.locator("#end-next").click();
  await expect(page.locator("#reader-title")).toHaveText("3화");
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("redstm.textState.v1")).history["novel:novel:fixture:long:2"]?.progress)).toBe(1);
  // Deep link: one Back lands on the chapter list, not outside the app.
  await page.goBack();
  await expect(page).toHaveURL(/\/text\?lane=novel&work=novel%3Afixture%3Along$/);
  await expect(page.locator('#result-list [data-key="chapter:3"]')).toBeVisible();
});

test("Reader settings keep the same sentence on screen when the font size changes", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop = 900; });
  const topSentence = () => page.evaluate(() => {
    const pane = document.getElementById("reader-pane");
    // The first line below whatever sticky chrome covers the top of the pane.
    const chrome = [...document.querySelectorAll(".reader-toolbar, .reader-topbar")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.height && rect.top <= pane.getBoundingClientRect().top + 1)
      .reduce((bottom, rect) => Math.max(bottom, rect.bottom), pane.getBoundingClientRect().top);
    const top = chrome + 12;
    return [...document.querySelectorAll("#archive-body p")].find((p) => p.getBoundingClientRect().bottom > top)?.textContent;
  });
  // Scrolling hid the tools on every width; a short tap on the text brings them back.
  await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
  for (const type of ["pointerdown", "pointerup"]) {
    await page.locator("#archive-body").dispatchEvent(type, { isPrimary: true, pointerType: "touch", clientX: 120, clientY: 420 });
  }
  await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
  // Let the bars finish sliding in: clicking a still-moving sticky button makes Playwright
  // scroll the pane to the button's in-flow position, which a real tap never does.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const before = await topSentence();
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator('#settings-dialog [data-prose-size-delta="1"]').click();
  await page.locator('#settings-dialog [data-prose-size-delta="1"]').click();
  await page.locator('#settings-dialog [data-prose-size-delta="1"]').click();
  await expect(page.locator("#prose-size-output")).toHaveText("21px");
  expect(await topSentence()).toBe(before);
});

test("Image links in a body show as images, fail softly, and open a closable viewer", async ({ page }) => {
  await useLongCollection(page, 3);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.route("https://img.example.test/**", (route) => route.request().url().includes("missing")
    ? route.fulfill({ status: 404, body: "" })
    : route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/archive/posts/board_a/2-*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1,
      post: {
        board_id: "board_a", external_post_id: 2, canonical_url: "https://example.test/2", title: "2편 제목",
        author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1, is_aa: false,
        body_html: [
          '<p><a href="https://img.example.test/a.png">https://img.example.test/a.png</a></p>',
          "<p>https://img.example.test/b.jpg?size=large</p>",
          "<p>https://img.example.test/missing.png</p>",
          '<p>문장 속 <a href="https://img.example.test/c.gif">그림</a>과 https://example.test/page 링크</p>',
        ].join(""),
      },
      comments: [],
    }),
  }));
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const figures = page.locator("#archive-body .media-figure");
  await expect(figures).toHaveCount(3);
  await expect(figures.nth(0).locator("img")).toHaveAttribute("src", "https://img.example.test/a.png");
  await expect(figures.nth(1).locator("img")).toHaveAttribute("src", "https://img.example.test/b.jpg?size=large");
  await expect(figures.nth(2)).toHaveClass(/failed/);
  await expect(figures.nth(2)).toContainText("이미지를 불러오지 못했습니다");
  await expect(figures.nth(2).locator("a")).toHaveAttribute("href", "https://img.example.test/missing.png");
  // A captioned link inside a sentence stays text; plain page links are untouched.
  await expect(page.locator('#archive-body a[data-image]')).toHaveText("그림");
  await figures.nth(0).locator(".media-open").click();
  const viewer = page.getByRole("dialog", { name: "이미지 보기" });
  await expect(viewer).toBeVisible();
  // The gallery holds the pictures that load, image links included; the failed one is left out.
  await expect(viewer.locator(".pswp__counter")).toHaveText("1 / 3");
  await expect(viewer.locator("#image-viewer-source")).toHaveAttribute("href", "https://img.example.test/a.png");
  // A picture smaller than the screen has nothing to zoom into.
  await expect(viewer.locator("#image-viewer-zoom")).toBeHidden();
  // Arrows move through the gallery, not to the next post.
  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator(".pswp__counter")).toHaveText("2 / 3");
  await expect(viewer.locator("#image-viewer-source")).toHaveAttribute("href", /b\.jpg/);
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await viewer.getByRole("button", { name: "닫기" }).click();
  await expect(viewer).toBeHidden();
  await expect(viewer.locator(".pswp")).toHaveCount(0);
  await expect(page).toHaveURL(/\/read\/board_a\/2$/);
});

test("Text bodies turn standalone image lines into images", async ({ page }) => {
  const workId = await useLongNovel(page, 2);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.route("https://img.example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route(`**/api/v1/text/object/${(1).toString(16).padStart(64, "a")}`, (route) => route.fulfill({
    contentType: "text/markdown",
    body: "# 긴 소설-1화\n#\nhttps://novel.example/1\n\n첫 줄\nhttps://img.example.test/cover.jpg\n마지막 줄 https://example.test/x",
  }));
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await expect(page.locator("#archive-body .media-figure img")).toHaveAttribute("src", "https://img.example.test/cover.jpg");
  await expect(page.locator("#archive-body")).toContainText("첫 줄");
  await expect(page.locator('#archive-body a[href="https://example.test/x"]')).toHaveText("https://example.test/x");
});

test("TypeMoon: 회차로 이동 finds an episode in a long table of contents without opening it", async ({ page }) => {
  await useLongCollection(page, 300);
  await page.goto("/collections/1");
  await expect(page.locator("#collection-title")).toHaveText("긴 연재");
  await page.locator("#collection-jump-input").fill("250");
  await page.locator("#collection-jump-input").press("Enter");
  await expect(page.locator('.collection-entry[data-key="250"]')).toBeFocused();
  await expect(page.locator('.collection-entry[data-key="250"]')).toBeInViewport();
  await expect(page.locator("#collection-view")).toBeVisible();
  await page.locator("#collection-jump-input").fill("999");
  await page.locator("#collection-jump-input").press("Enter");
  await expect(page.locator('.collection-entry[data-key="300"]')).toBeFocused();
});

test("Home resumes the most recent text chapter; Back walks chapter → list → home", async ({ page }) => {
  const workId = await useLongNovel(page, 10);
  await useLongCollection(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await page.locator('#result-list [data-key="chapter:5"]').click();
  await expect(page.locator("#reader-title")).toHaveText("5화");
  await page.goto("/");
  await expect(page.locator("#continue-title")).toHaveText("5화");
  await expect(page.locator("#continue-work")).toHaveText("긴 소설");
  await page.locator("#continue-reading").click();
  await expect(page.locator("#reader-title")).toHaveText("5화");
  await page.goBack();
  await expect(page.locator('#result-list [data-key="chapter:5"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("The next episode is fetched ahead once the current one settles", async ({ page }) => {
  await useLongCollection(page, 3);
  const requested = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await page.goto("/collections/1");
  await page.locator('.collection-entry[data-key="1"]').click();
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await expect.poll(() => requested.some((path) => path.startsWith("/archive/posts/board_a/2-"))).toBe(true);
});

test("The 더보기 position slider jumps within a long body", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#more-position-output")).toHaveText("0%");
  await page.locator("#more-position").evaluate((input) => {
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#reader-more button[aria-label='닫기']").click();
  await expect(page.locator("#end-next")).toBeInViewport();
});

async function useBoardPosts(page, count) {
  const release = {
    schema_version: 1,
    search: { object_key: "search/e2e.json.zst" },
    collections: { object_key: collectionIndexKey },
    boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: count }],
  };
  const index = {
    schema_version: 1,
    fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
    posts: Array.from({ length: count }, (_, i) => {
      const id = count - i;
      return ["board_a", id, `글 ${id}`, "작성자", null, "2026-07-11", hashFor(id), false];
    }),
  };
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const post = /^posts\/board_a\/(\d+)-/.exec(key);
    const payload = post ? { ...postPayload(Number(post[1])), post: { ...postPayload(Number(post[1])).post, title: `글 ${post[1]}` } }
      : key === "release.json" ? release : key === "search/e2e.json.zst" ? index
      : key === collectionIndexKey ? { schema_version: 1, collections: [] } : null;
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

test("TypeMoon: the list under a post is the list it was opened from, around that post", async ({ page }) => {
  test.skip(page.viewportSize().width >= 900, "Wide screens show this list beside the Reader instead");
  await useBoardPosts(page, 120);
  await page.goto("/browse?sort=oldest");
  await expect(page.locator(".result-item").first()).toBeVisible();
  await page.locator('.result-item[data-key="board_a:25"]').click();
  await expect(page.locator("#reader-title")).toHaveText("글 25");
  const list = page.locator("#reader-list");
  await expect(list.locator("#reader-list-title")).toHaveText("전체 게시판 · 오래된순");
  await expect(list.locator("#reader-list-range")).toHaveText("21–30 / 120");
  await expect(list.locator('.reader-list-row[aria-current="true"] strong')).toHaveText("글 25");
  // 다음 글 follows the same list order (oldest first), and the list follows along.
  await page.locator(mobileWidth(page) ? "#reader-bottom-next" : "#next-post").click();
  await expect(page.locator("#reader-title")).toHaveText("글 26");
  await expect(list.locator('.reader-list-row[aria-current="true"] strong')).toHaveText("글 26");
  await list.locator("#reader-list-next").click();
  await expect(list.locator("#reader-list-range")).toHaveText("31–40 / 120");
  await list.locator(".reader-list-row", { hasText: "글 33" }).click();
  await expect(page.locator("#reader-title")).toHaveText("글 33");
  // Still one reading session: Back returns to the original list.
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\?sort=oldest$/);
});

test("TypeMoon: a search keeps its results under the post and after reload", async ({ page }) => {
  test.skip(page.viewportSize().width >= 900, "Wide screens show this list beside the Reader instead");
  await useBoardPosts(page, 120);
  await page.goto("/search?q=%EA%B8%80%201");
  await page.locator('.result-item[data-key="board_a:12"]').click();
  await expect(page.locator("#reader-title")).toHaveText("글 12");
  await expect(page.locator("#reader-list-kicker")).toHaveText("검색 결과");
  await expect(page.locator("#reader-list-title")).toHaveText("“글 1”");
  await expect(page.locator('.reader-list-row[aria-current="true"] strong')).toHaveText("글 12");
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("글 12");
  await expect(page.locator("#reader-list-title")).toHaveText("“글 1”");
  await expect(page.locator("#end-next-kicker")).toHaveText("다음 글 · 현재 결과");
});

test("TypeMoon: a deep link shows its board, and a series shows its table of contents", async ({ page }) => {
  test.skip(page.viewportSize().width >= 900, "Wide screens show this list beside the Reader instead");
  await useLongCollection(page, 30);
  await page.goto("/read/board_a/15");
  await expect(page.locator("#reader-list-kicker")).toHaveText("게시판");
  await expect(page.locator("#reader-list-title")).toHaveText("자유게시판");
  await page.goto("/collections/1");
  await page.locator('.collection-entry[data-key="15"]').click();
  await expect(page.locator("#reader-list-kicker")).toHaveText("작품 목차");
  await expect(page.locator("#reader-list-title")).toHaveText("긴 연재");
  await expect(page.locator('.reader-list-row[aria-current="true"] strong')).toHaveText("15편 제목");
});

test("Text: the list under a chapter keeps the chapter list's sort and survives reload", async ({ page }) => {
  test.skip(page.viewportSize().width >= 900, "Wide screens show this list beside the Reader instead");
  const workId = await useLongNovel(page, 300);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await expect(page.locator('#result-list [data-key="chapter:1"]')).toBeVisible();
  await page.locator("#sort-filter").evaluate((select) => {
    select.value = "latest";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page).toHaveURL(/sort=latest/);
  await page.locator('#result-list [data-key="chapter:200"]').click();
  await expect(page.locator("#reader-title")).toHaveText("200화");
  await expect(page.locator("#reader-list-title")).toHaveText("긴 소설 · 최신순");
  await expect(page.locator("#reader-list-range")).toHaveText("101–110 / 300");
  await expect(page.locator(".reader-list-row strong").first()).toHaveText("200화");
  await expect(page.locator(".reader-list-row strong").nth(1)).toHaveText("199화");
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("200화");
  await expect(page.locator("#reader-list-title")).toHaveText("긴 소설 · 최신순");
  await page.locator(".reader-list-row", { hasText: "195화" }).click();
  await expect(page.locator("#reader-title")).toHaveText("195화");
  await page.goBack();
  await expect(page.locator('#result-list [data-key="chapter:200"]')).toBeVisible();
  await expect(page.locator("#result-list .result-item[data-key] .result-title").first()).toHaveText("300화");
});

test("Home continues a finished text chapter at the next chapter", async ({ page }) => {
  const workId = await useLongNovel(page, 10);
  await useLongCollection(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=4`);
  await expect(page.locator("#reader-title")).toHaveText("4화");
  await page.locator("#end-next").click();
  await expect(page.locator("#reader-title")).toHaveText("5화");
  await page.locator("#end-previous").click();
  await expect(page.locator("#reader-title")).toHaveText("4화");
  await page.goto("/");
  await expect(page.locator("#continue-title")).toHaveText("4화");
  await expect(page.locator("#continue-meta")).toContainText("다음 화로 이어서");
  await page.locator("#continue-reading").click();
  await expect(page.locator("#reader-title")).toHaveText("5화");
  await page.goBack();
  await expect(page.locator('#result-list [data-key="chapter:5"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("Picking another chapter from the visible side list stays in the reading session", async ({ page }) => {
  test.skip(page.viewportSize().width < 760, "The side list shows beside the Reader on wide screens");
  const workId = await useLongNovel(page, 10);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await page.locator('#result-list [data-key="chapter:2"]').click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  if (await page.locator("#catalog-toggle").isVisible() && await page.locator(".catalog").isHidden()) {
    await page.locator("#catalog-toggle").click();
  }
  await page.locator('#result-list [data-key="chapter:7"]').click();
  await expect(page.locator("#reader-title")).toHaveText("7화");
  await expect(page.locator("#reader-list")).toBeHidden();
  await page.goBack();
  await expect(page.locator("#reader")).toBeHidden();
  await expect(page).toHaveURL(/work=novel%3Afixture%3Along$/);
});

test("Text parity: sort chips, reading progress, memo·tags, and Home 읽던 작품", async ({ page }) => {
  const workId = await useLongNovel(page, 40);
  await useLongCollection(page, 3);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await expect(page.locator('#result-list [data-key="chapter:1"]')).toBeVisible();
  await expect(page.locator("#search-input")).toHaveAttribute("placeholder", /회차 찾기/);
  // Sorting is a visible control, and it travels in the URL.
  await page.locator("#sort-filter").selectOption("latest");
  await expect(page.locator("#sort-filter")).toHaveValue("latest");
  await expect(page).toHaveURL(/sort=latest/);
  await expect(page.locator("#result-list .result-item[data-key] .result-title").first()).toHaveText("40화");
  await page.locator('#result-list [data-key="chapter:3"]').click();
  await expect(page.locator("#reader-title")).toHaveText("3화");
  // Memo and tags work for text bookmarks too.
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#more-note")).toBeVisible();
  await page.locator("#more-note").click();
  await page.locator("#bookmark-note").fill("다시 볼 장면");
  await page.locator("#bookmark-tags").fill("복선, 명장면");
  await page.locator("#bookmark-dialog button[type='submit']").click();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#end-next").click();
  await expect(page.locator("#reader-title")).toHaveText("4화");
  await page.goto("/text?lane=saved");
  await expect(page.locator("#result-list .result-item").first()).toContainText("#명장면");
  await expect(page.locator("#result-list .result-item").first()).toContainText("다시 볼 장면");
  await page.goto("/text?lane=novel");
  await expect(page.locator("#result-list .result-item").first()).toContainText("1/40화");
  await expect(page.locator("#result-list .result-item").first().locator(".result-action")).toHaveText("이어 읽기");
  await expect(page.locator("#result-list .result-item").first()).toContainText("최근 4화");
  await page.goto("/");
  const works = page.locator("#reading-works");
  await expect(works).toBeVisible();
  await works.locator(".home-item", { hasText: "긴 소설" }).click();
  await expect(page).toHaveURL(/work=novel%3Afixture%3Along/);
  await expect(page.locator('#result-list [data-key="chapter:4"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("Text bodies show [image] and [video] lines and readable markdown links", async ({ page }) => {
  const workId = await useLongNovel(page, 2);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.route("https://ac-o.arca.live/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("https://ac.arca.live/**", (route) => route.fulfill({ status: 404, body: "" }));
  const image = "https://ac-o.arca.live/20240329sac/7e4f.png?expires=4102444800&key=huxjPhFT5g-FdT0sbArY3A&type=orig";
  const expired = "https://ac-o.arca.live/20240329sac/old.png?expires=1785653375&key=x&type=orig";
  await page.route(`**/api/v1/text/object/${(1).toString(16).padStart(64, "a")}`, (route) => route.fulfill({
    contentType: "text/markdown",
    body: `# 긴 소설-1화\n#\nhttps://novel.example/1\n\n[image] ${image}\n[image] ${expired}\n\n진정한 순교자\n[video] https://ac.arca.live/v/clip.mp4?expires=4102444800&key=k\n출처 [https://novelpia.com/novel/391903](https://unsafelink.com/https://novelpia.com/novel/391903)`,
  }));
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await expect(page.locator("#archive-body .media-figure img")).toHaveAttribute("src", image);
  await expect(page.locator("#archive-body .media-video video")).toHaveAttribute("src", "https://ac.arca.live/v/clip.mp4?expires=4102444800&key=k");
  // An expired signed link is not loaded; the note points at the source post.
  await expect(page.locator("#archive-body .media-expired")).toHaveCount(1);
  await expect(page.locator("#archive-body .media-expired a")).toHaveAttribute("href", "https://novel.example/1");
  await expect(page.locator("#archive-body .media-figure img")).toHaveCount(1);
  await expect(page.locator("#archive-body")).not.toContainText("[image]");
  const link = page.locator('#archive-body a[href="https://novelpia.com/novel/391903"]');
  await expect(link).toHaveText("https://novelpia.com/novel/391903");
  await expect(page.locator("#archive-body")).not.toContainText("unsafelink");
});

test("Arcalive images: archived copies replace expired links and missing ones keep the source note", async ({ page }) => {
  await useLongCollection(page, 3);
  const releaseHash = "a".repeat(64);
  const indexHash = "b".repeat(64);
  const bodyHash = "c".repeat(64);
  const stored = "20240329sac/7e4f8557ceebfb10692c4b35f198e52334ddc010b6026c5bfd7da73c636b3119.png";
  const missing = "20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const requests = [];
  await page.route("**/api/v1/text/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/text/media/resolve") {
      const { paths } = route.request().postDataJSON();
      requests.push(paths);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        media: Object.fromEntries(paths.filter((item) => item === stored).map((item) => [item, { url: `/api/v1/text/media/arca/${item}` }])),
      }) });
    }
    if (path.startsWith("/api/v1/text/media/arca/")) return route.fulfill({ contentType: "image/png", body: png });
    let payload;
    if (path.endsWith("/release/arcalive")) payload = { schema: 1, lane: "arcalive", sha256: releaseHash };
    else if (path.endsWith(`/release-manifest/arcalive/${releaseHash}.json`)) payload = {
      schema: 1, lane: "arcalive", catalog_pages: [{ key: `published/indexes/arcalive/${indexHash}.json`, sha256: indexHash }],
    };
    else if (path.endsWith(`/index/arcalive/${indexHash}.json`)) payload = {
      schema: 1, lane: "arcalive", items: [{ identity: "arcalive:monmusu:102379431:text", title: "작은 가슴파의 유혹", author: "번역자", category: "번역", board: "monmusu", post_id: 102379431, sha256: bodyHash }],
    };
    else if (path.endsWith(`/object/${bodyHash}`)) return route.fulfill({
      contentType: "text/markdown",
      body: `# 작은 가슴파의 유혹\n\n- channel: monmusu\n- url: https://arca.live/b/monmusu/102379431\n\n---\n\n[image] https://ac-o.arca.live/${stored}?expires=1785653375&key=a&type=orig\n\n본문\n\n[image] https://ac-o.arca.live/${missing}?expires=1785653375&key=b&type=orig\n[video] https://ac.arca.live/v/clip.mp4?expires=1&key=k`,
    });
    else return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/text?lane=arcalive&board=monmusu&category=%EB%B2%88%EC%97%AD");
  await page.locator("#search-input").fill("번역자");
  await expect(page.locator("#result-list .result-item")).toContainText("번역자");
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#reader-title")).toHaveText("작은 가슴파의 유혹");
  const archived = page.locator('#archive-body .media-figure[data-archived="true"] img');
  await expect(archived).toHaveAttribute("src", `/api/v1/text/media/arca/${stored}`);
  await expect(page.locator("#archive-body .media-expired")).toHaveCount(2);
  await expect(page.locator(`#archive-body .media-expired[data-arca-path="${missing}"]`)).toContainText("만료된 이미지 링크");
  await expect(page.locator(`#archive-body .media-expired[data-arca-path="${missing}"] a`)).toHaveAttribute("href", "https://arca.live/b/monmusu/102379431");
  expect(requests).toEqual([[stored, missing]]);
});

test("Text keeps reading when the TypeMoon archive fails, and the error waits for TypeMoon screens", async ({ page }) => {
  const workId = await useLongNovel(page, 5);
  await page.route("**/archive/**", (route) => route.fulfill({ status: 503, body: "down" }));
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  await page.locator('#result-list [data-key="chapter:2"]').click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  await expect(page.locator("#archive-body")).toContainText("2화 첫 줄");
  await page.waitForTimeout(500);
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/reader-active/);
  await page.goBack();
  await expect(page.locator("#reader")).toBeHidden();
  await page.locator('[data-destination="library"]').filter({ visible: true }).first().click();
  await expect(page.locator("#archive-state")).toHaveText("연결 오류");
  await expect(page.locator("#home-title")).toHaveText("아카이브를 열 수 없음");
});

test("A work not started yet offers its first chapter, and finishing one names the next", async ({ page }) => {
  const workId = await useLongNovel(page, 5);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}`);
  const start = page.locator("#result-list .continue-row");
  await expect(start).toContainText("처음부터 읽기 · 1화");
  // Searching for a chapter shows only matches.
  await page.locator("#search-input").fill("3화");
  await expect(start).toHaveCount(0);
  await page.locator("#search-input").fill("");
  await start.click();
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await page.goBack();
  await expect(page.locator("#result-list .continue-row")).toContainText("이어 읽기 · 2화");
});

test("Recent searches keep one entry per typed search and can be cleared", async ({ page }) => {
  await useLongCollection(page, 30);
  await page.goto("/search");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  // Each pause while typing runs a search; the URL shows which one ran.
  for (const query of ["1", "12", "12편", "3편"]) {
    await page.locator("#search-input").fill(query);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(query)}(&|$)`));
  }
  await page.locator("#search-clear").click();
  await expect(page.locator("#recent-queries li button:not(.recent-queries-clear)")).toHaveText(["3편", "12편"]);
  await expect(page.locator("#result-status")).toHaveText("");
  await page.locator(".recent-queries-clear").click();
  await expect(page.locator("#recent-queries")).toBeHidden();
});

test("Arrow keys move between chapters on the desktop Reader", async ({ page }) => {
  test.skip(mobileWidth(page), "Keyboard shortcuts are for wide screens");
  await useLongCollection(page, 5);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator("#archive-body").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
});

test("Tapping the tab you are on returns a scrolled list to the top first", async ({ page }) => {
  await useLongCollection(page, 80);
  await page.goto("/browse");
  await expect(page.locator("#result-list .result-item").first()).toBeVisible();
  await page.locator("#result-list").evaluate((list) => { list.scrollTop = 1500; });
  await page.locator('[data-destination="browse"]').filter({ visible: true }).first().click();
  await expect.poll(() => page.locator("#result-list").evaluate((list) => list.scrollTop)).toBe(0);
});

test("Reading settings opened over a chapter leave the text visible on phones", async ({ page }) => {
  test.skip(!mobileWidth(page), "Phone bottom sheet");
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await page.locator("#reader-bottom-settings").click();
  await page.locator("#quick-all-settings").click();
  const sheetTop = await page.locator("#settings-dialog").evaluate((dialog) => dialog.getBoundingClientRect().top);
  expect(sheetTop).toBeGreaterThan(page.viewportSize().height * 0.35);
});

test("The Reader estimates reading time and the 더보기 sheet shows what is left", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#reader-length")).toHaveText("약 1분");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#more-remaining")).toHaveText(/^(남은 시간 약 \d+분|1분 안에 끝)$/);
  await page.locator("#more-position").evaluate((input) => {
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#more-remaining")).toHaveText("끝까지 읽음");
});

test("종이 surface and 양쪽 맞춤 apply to the Reader and survive a reload", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const readerBackground = () => page.locator("#reader").evaluate((element) => getComputedStyle(element).backgroundColor);
  const plain = await readerBackground();
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator('#settings-dialog [data-reader-surface="paper"]').click();
  await expect(page.locator('#settings-dialog [data-reader-surface="paper"]')).toHaveAttribute("aria-checked", "true");
  await expect.poll(readerBackground).not.toBe(plain);
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "start");
  await page.locator('[data-prose-align="justify"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "justify");
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(readerBackground).not.toBe(plain);
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "justify");
  // The app chrome keeps its own tokens; the browser bar matches the paper while reading.
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(247, 246, 243)");
  const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.content));
  expect(await themeColors()).toEqual(["#F5EFE3", "#1D1A15"]);
});

// T32: a light app with an ink-black page. The Reader scope turns dark on its own, the sheet over
// it follows, and brightness/warmth only lay overlays over the screen.
test("The 먹 surface stays black under a light app theme and dims without touching the text", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator('[data-theme-choice="light"]').click();
  await page.locator('#settings-dialog [data-reader-surface="ink"]').click();
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(page.locator("#archive-body p").first()).toHaveCSS("color", "rgb(214, 216, 212)");
  await expect(page.locator("#reader")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("#settings-dialog")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(247, 246, 243)");
  const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.content));
  expect(await themeColors()).toEqual(["#000000", "#000000"]);
  await page.evaluate(() => document.fonts.ready);
  const before = await page.locator("#archive-body").evaluate((element) => element.getBoundingClientRect().height);
  await page.locator("#reader-dim").evaluate((input) => {
    input.value = "40";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#reader-dim-output")).toHaveText("40%");
  expect(await page.locator(".reader-shade").evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("0.4");
  expect(await page.locator(".reader-shade").evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  expect(await page.locator("#archive-body").evaluate((element) => element.getBoundingClientRect().height)).toBe(before);
  await page.reload();
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect.poll(() => page.locator(".reader-shade").evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("0.4");
});

test("The browser bar follows the chosen theme even when the OS theme differs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await useLongCollection(page, 3);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.content));
  expect(await themeColors()).toEqual(["#F7F6F3", "#121413"]);
  await page.goto("/settings");
  await page.locator('[data-theme-choice="light"]').click();
  expect(await themeColors()).toEqual(["#F7F6F3", "#F7F6F3"]);
});

test("더보기 copies a link that reopens the same chapter", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#more-link").click();
  await expect(page.locator("#reader-more")).toBeHidden();
  await expect(page.locator("#aa-zoom-indicator")).toHaveText("링크를 복사했습니다");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
});

test("AA 맞춤 shrinks a wide picture to the stage width and never enlarges past 100%", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.route("**/archive/posts/board_a/2-*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1,
      post: {
        board_id: "board_a", external_post_id: 2, canonical_url: "https://example.test/2", title: "2편 제목",
        author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1, is_aa: true,
        body_html: `<div class="AA_Text"><p>${"＿".repeat(150)}</p><p>（　´∀｀）</p></div>`,
      },
      comments: [],
    }),
  }));
  await page.goto("/read/board_a/2");
  await expect(page.locator("#archive-body")).toHaveClass(/(^|\s)aa(\s|$)/);
  await expect(page.locator("#reader-length")).toBeHidden();
  const overflow = () => page.locator("#archive-body").evaluate((body) => body.scrollWidth - body.clientWidth);
  expect(await overflow()).toBeGreaterThan(100);
  await page.locator("#aa-fit").click();
  await expect(page.locator("#aa-zoom-output")).not.toHaveText("100%");
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  // Zoomed out further, 맞춤 comes back up but stops at 100% for a picture that already fits.
  await page.locator("#aa-zoom-reset").click();
  await page.goto("/read/board_a/1");
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await page.locator("#mode-toggle").evaluate((button) => button.click());
  await expect(page.locator("#archive-body")).toHaveClass(/(^|\s)aa(\s|$)/);
  await page.locator('[data-aa-zoom-delta="-0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("75%");
  await page.locator("#aa-fit").click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("100%");
});

test("화면 탭으로 넘기기 turns a screen per tap and leaves the middle to the bars", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: { tapPaging: "on" }, history: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const pane = page.locator("#reader-pane");
  const box = await pane.boundingBox();
  const tapAt = async (ratio) => {
    const y = box.y + box.height * ratio;
    await page.locator("#archive-body").dispatchEvent("pointerdown", { isPrimary: true, pointerType: "touch", clientX: box.x + 60, clientY: y });
    await page.locator("#archive-body").dispatchEvent("pointerup", { isPrimary: true, pointerType: "touch", clientX: box.x + 60, clientY: y });
  };
  await pane.evaluate((element) => { element.scrollTop = 400; });
  const scrollTop = () => pane.evaluate((element) => element.scrollTop);
  await tapAt(0.85);
  await expect.poll(scrollTop).toBeGreaterThan(400 + box.height * 0.5);
  await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
  const afterForward = await scrollTop();
  await tapAt(0.1);
  await expect.poll(scrollTop).toBeLessThan(afterForward - box.height * 0.5);
  // The middle band still shows and hides the tools.
  await tapAt(0.45);
  await expect(page.locator("body")).not.toHaveClass(/reader-controls-hidden/);
});

test("Two fingers on prose change the font size and keep the sentence", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#archive-body")).toHaveCSS("touch-action", "pan-x pan-y");
  const pinch = (from, to) => page.locator("#archive-body").evaluate((body, [start, end]) => {
    const touches = (gap) => [0, 1].map((identifier) => new Touch({
      identifier, target: body, clientX: 150 + (identifier ? gap : 0), clientY: 400,
    }));
    body.dispatchEvent(new TouchEvent("touchstart", { touches: touches(start), bubbles: true }));
    body.dispatchEvent(new TouchEvent("touchmove", { touches: touches(end), bubbles: true }));
    body.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
  }, [from, to]);
  await pinch(100, 150);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).settings.proseSize)).toBe(27);
  await expect(page.locator("#aa-zoom-indicator")).toHaveText("글자 27px");
  await pinch(200, 20);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).settings.proseSize)).toBe(15);
});

test("The author in the Reader opens that author's posts without raising the keyboard", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await page.locator(".reader-author").click();
  await expect(page).toHaveURL(/\/search\?q=%EC%9E%91%EC%84%B1%EC%9E%90&target=author$/);
  await expect(page.locator(".result-item")).toHaveCount(3);
  await expect(page.locator("#search-input")).not.toBeFocused();
});

test("화면 켜 두기 holds a wake lock only while the body is open", async ({ page }) => {
  await page.addInitScript(() => {
    // A stand-in wake lock that records requests and releases.
    window.__wake = { held: 0, requests: 0 };
    const sentinel = () => {
      const target = new EventTarget();
      target.release = async () => {
        window.__wake.held -= 1;
        target.dispatchEvent(new Event("release"));
      };
      return target;
    };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: async () => { window.__wake.requests += 1; window.__wake.held += 1; return sentinel(); } },
    });
  });
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const more = page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more");
  await more.click();
  const wake = page.locator("#more-wake");
  await expect(wake).toHaveAttribute("aria-pressed", "false");
  await wake.click();
  await expect(wake).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.__wake.held)).toBe(1);
  await page.locator("#reader-more button[aria-label='닫기']").click();
  // Moving to the next episode keeps it; leaving the Reader releases it.
  await page.locator(mobileWidth(page) ? "#reader-bottom-next" : "#next-post").click();
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
  expect(await page.evaluate(() => window.__wake.held)).toBe(1);
  await page.goBack();
  await expect(page.locator("#reader")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__wake.held)).toBe(0);
});

test("The image viewer shows a large picture at its own size and fits it again", async ({ page }) => {
  await useLongCollection(page, 3);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="#468"/></svg>';
  await page.route("https://img.example.test/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route("**/archive/posts/board_a/2-*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1,
      post: {
        board_id: "board_a", external_post_id: 2, canonical_url: "https://example.test/2", title: "2편 제목",
        author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1, is_aa: false,
        body_html: '<p><a href="https://img.example.test/big.png">https://img.example.test/big.png</a></p>',
      },
      comments: [],
    }),
  }));
  await page.goto("/read/board_a/2");
  await page.locator("#archive-body .media-open").click();
  const viewer = page.getByRole("dialog", { name: "이미지 보기" });
  const zoom = viewer.locator("#image-viewer-zoom");
  await expect(zoom).toBeVisible();
  const width = () => viewer.locator(".pswp__img").first().evaluate((image) => Math.round(image.getBoundingClientRect().width));
  await expect.poll(width).toBeLessThanOrEqual(page.viewportSize().width);
  await zoom.click();
  await expect(zoom).toHaveAttribute("aria-pressed", "true");
  await expect.poll(width).toBe(3000);
  // The actions stay on screen over the zoomed picture.
  await expect(zoom).toBeInViewport();
  await zoom.click();
  await expect.poll(width).toBeLessThanOrEqual(page.viewportSize().width);
});

// docs/24 §8.18: a picture taller than 1:3 opens filling the width, to be read by panning down.
test("A very tall picture opens at the screen width instead of a sliver", async ({ page }) => {
  await useLongCollection(page, 3);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="9000"><rect width="2000" height="9000" fill="#468"/></svg>';
  await page.route("https://img.example.test/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route("**/archive/posts/board_a/2-*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1,
      post: {
        board_id: "board_a", external_post_id: 2, canonical_url: "https://example.test/2", title: "2편 제목",
        author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1, is_aa: false,
        body_html: '<p><a href="https://img.example.test/tall.png">https://img.example.test/tall.png</a></p>',
      },
      comments: [],
    }),
  }));
  await page.goto("/read/board_a/2");
  await page.locator("#archive-body .media-open").click();
  const viewer = page.getByRole("dialog", { name: "이미지 보기" });
  const box = () => viewer.locator(".pswp__img").first().evaluate((image) => {
    const rect = image.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  await expect.poll(async () => (await box()).width).toBe(page.viewportSize().width);
  expect((await box()).height).toBeGreaterThan(page.viewportSize().height);
});

test("Text: novels read before show new chapters in the list, the read-state chips and Home", async ({ page }) => {
  await useLongCollection(page, 3);
  const workId = await useLongNovel(page, 5);
  await page.addInitScript((id) => {
    if (localStorage.getItem("redstm.textState.v1")) return;
    localStorage.setItem("redstm.textState.v1", JSON.stringify({ schema_version: 1, bookmarks: {}, history: {
      [`novel:${id}:1`]: {
        readAt: "2026-09-01T00:00:00Z", progress: 1, total: 3, title: "1화", work: "긴 소설", workId: id,
        route: `/text?lane=novel&work=${encodeURIComponent(id)}&chapter=1`,
        listRoute: `/text?lane=novel&work=${encodeURIComponent(id)}`,
      },
    } }));
  }, workId);
  await page.goto("/text?lane=novel");
  await expect(page.locator("#result-list .result-item").first()).toContainText("새 2화");
  const chips = page.locator("#text-read-chips");
  await expect(chips).toBeVisible();
  await expect(chips.locator('[data-text-read="new"]')).toHaveText("새 회차 1");
  await expect(chips.locator('[data-text-read="unread"]')).toBeDisabled();
  await chips.locator('[data-text-read="reading"]').click();
  await expect(page).toHaveURL(/read=reading/);
  await expect(page.locator("#result-list .result-item")).toHaveCount(1);
  await expect(page.locator('#sort-filter option[value="recent"]')).toHaveText("최근 읽은순");
  // Opening the work hides the chips; the chapter list is not filtered by them.
  await page.locator("#result-list .result-item").first().click();
  await expect(chips).toBeHidden();
  await page.locator('[data-destination="library"]').filter({ visible: true }).first().click();
  await expect(page.locator("#reading-works-list .home-badge")).toHaveText("새 2화");
});

test("Text: 이전 회차 모두 읽음 marks the chapters before the open one as read", async ({ page }) => {
  const workId = await useLongNovel(page, 6);
  await page.goto(`/text?lane=novel&work=${encodeURIComponent(workId)}&chapter=4`);
  await expect(page.locator("#reader-title")).toHaveText("4화");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#more-mark-read")).toContainText("이전 회차 모두 읽음 (3화)");
  await page.locator("#more-mark-read").click();
  await expect(page.locator("#reader-more")).not.toBeVisible();
  const saved = await page.evaluate((id) => {
    const history = JSON.parse(localStorage.getItem("redstm.textState.v1")).history;
    return [1, 2, 3, 4].map((chapter) => history[`novel:${id}:${chapter}`]?.progress ?? null);
  }, workId);
  expect(saved.slice(0, 3)).toEqual([1, 1, 1]);
  expect(saved[3]).toBeLessThan(1);
  await page.goBack();
  await expect(page.locator("#result-list .continue-row")).toContainText("이어 읽기 · 4화");
  await expect(page.locator('#result-list [data-key="chapter:3"]')).toContainText("다 읽음");
  // Nothing is left to mark from the first chapter.
  await page.locator('#result-list [data-key="chapter:1"]').click();
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await expect(page.locator("#more-mark-read")).toBeHidden();
});

test("Arcalive posts in a category list newest first but read in posting order", async ({ page }) => {
  const releaseHash = "a".repeat(64);
  const indexHash = "b".repeat(64);
  const body = (id) => id.toString(16).padStart(64, "c");
  // Imported out of posting order.
  const posts = [30, 10, 20].map((id) => ({
    identity: `arcalive:novel:${id}:text`, title: `${id}번 글`, author: "작성자", category: "소설", board: "novel",
    post_id: id, sha256: body(id),
  }));
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload;
    if (path.endsWith("/release/arcalive")) payload = { schema: 1, lane: "arcalive", sha256: releaseHash };
    else if (path.endsWith(`/release-manifest/arcalive/${releaseHash}.json`)) payload = {
      schema: 1, lane: "arcalive", catalog_pages: [{ key: `published/indexes/arcalive/${indexHash}.json`, sha256: indexHash }],
    };
    else if (path.endsWith(`/index/arcalive/${indexHash}.json`)) payload = { schema: 1, lane: "arcalive", items: posts };
    else {
      const post = posts.find((item) => path.endsWith(`/object/${item.sha256}`));
      if (post) return route.fulfill({ contentType: "text/markdown", body: `# ${post.title}\n\n---\n\n${post.title} 본문` });
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/text?lane=arcalive&board=novel&category=%EC%86%8C%EC%84%A4");
  const titles = page.locator("#result-list .result-item[data-key] .result-title");
  await expect(titles).toHaveText(["30번 글", "20번 글", "10번 글"]);
  await expect(page.locator("#sort-filter")).toHaveValue("latest");
  await page.locator("#sort-filter").selectOption("oldest");
  await expect(titles).toHaveText(["10번 글", "20번 글", "30번 글"]);
  await expect(page).toHaveURL(/sort=oldest/);
  await page.locator("#sort-filter").selectOption("latest");
  await page.locator("#result-list .result-item", { hasText: "20번 글" }).click();
  await expect(page.locator("#reader-title")).toHaveText("20번 글");
  await page.locator(mobileWidth(page) ? "#reader-bottom-next" : "#next-post").click();
  await expect(page.locator("#reader-title")).toHaveText("30번 글");
});

test("Search with no TypeMoon result offers the same words in the text library", async ({ page }) => {
  await useLongCollection(page, 3);
  const workId = await useLongNovel(page, 2);
  await page.goto("/search?q=%EA%B8%B4%20%EC%86%8C%EC%84%A4");
  await expect(page.locator("#search-widen")).toBeVisible();
  await page.locator("#search-widen button", { hasText: "소설에서 찾기" }).click();
  await expect(page).toHaveURL(/\/text\?lane=novel&q=/);
  await expect(page.locator("#search-input")).toHaveValue("긴 소설");
  await expect(page.locator(`#result-list [data-key="work:${workId}"]`)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?/);
});

test("보관함 lists novels being read and saved text items next to TypeMoon ones", async ({ page }) => {
  await useLongCollection(page, 3);
  const workId = await useLongNovel(page, 4);
  const hash = (2).toString(16).padStart(64, "a");
  await page.addInitScript(([id, sha]) => {
    if (localStorage.getItem("redstm.textState.v1")) return;
    localStorage.setItem("redstm.textState.v1", JSON.stringify({ schema_version: 1,
      history: { [`novel:${id}:1`]: {
        readAt: "2026-09-01T00:00:00Z", progress: 1, total: 4, title: "1화", work: "긴 소설", workId: id,
        listRoute: `/text?lane=novel&work=${encodeURIComponent(id)}`,
      } },
      bookmarks: { [`novel:${id}:2`]: {
        savedAt: "2026-09-02T00:00:00Z", lane: "novel", title: "긴 소설", note: "다시 볼 장면",
        entry: { chapter_id: "2", label: "2화", sha256: sha }, work: { work_id: id, title: "긴 소설", chapter_count: 4 },
      } },
    }));
  }, [workId, hash]);
  await page.goto("/saved?view=reading");
  const reading = page.locator("#result-list .text-result");
  await expect(reading).toContainText("긴 소설");
  await expect(reading).toContainText("읽음 1/4");
  await reading.click();
  await expect(page).toHaveURL(/\/text\?lane=novel&work=/);
  await expect(page.locator('#result-list [data-key="chapter:2"]')).toBeVisible();

  await page.goto("/saved");
  const saved = page.locator("#result-list .text-result");
  await expect(saved).toContainText("긴 소설 · 2화");
  await expect(saved).toContainText("다시 볼 장면");
  await expect(page.locator("#result-status")).toContainText("텍스트 1");
  await saved.click();
  await expect(page.locator("#reader-title")).toHaveText("2화");
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/saved$/);
});

test("Text works list like TypeMoon collections: source, progress, header, jump, filters", async ({ page }) => {
  const posts = [101, 102, 103].map((id, index) => arcalivePost({ id, title: `긴 연재 ${index + 1}화` }));
  await useTextArchive(page, {
    novels: [
      novelWork({ id: 1, title: "오래된 소설", chapters: 30, site: "toki", updated: "2026-08-01T00:00:00Z", latest: "31화" }),
      novelWork({ id: 2, title: "새 소설", chapters: 3, site: "blacktoon", updated: "2026-09-10T00:00:00Z" }),
    ],
    posts: [...posts, arcalivePost({ id: 200, board: "free", category: "잡담", title: "다른 글" })],
    works: [arcaliveWork({ key: "long", title: "긴 연재", posts })],
  });
  await page.goto("/text?lane=novel");
  const rows = page.locator("#result-list .result-item[data-key]");
  // Most recently updated first, like TypeMoon's 최근 글순.
  await expect(rows.locator(".result-title")).toHaveText(["새 소설", "오래된 소설"]);
  await expect(page.locator("#sort-filter")).toHaveValue("updated");
  await expect(page.locator('#sort-filter option[value="updated"]')).toHaveText("최근 갱신순");
  await expect(rows.first()).toContainText("블랙툰");
  await expect(rows.first().locator(".result-action")).toHaveText("시작하기");
  await expect(rows.nth(1)).toContainText("최신 31화");
  await expect(page.locator("#result-status")).toHaveText("2개 작품");
  await page.locator("#text-source-filter").selectOption("toki");
  await expect(page).toHaveURL(/source=toki/);
  await expect(rows.locator(".result-title")).toHaveText(["오래된 소설"]);
  await page.locator("#search-input").fill("오래");
  await expect(rows.first().locator("mark")).toHaveText("오래");
  await page.locator("#search-input").fill("");

  await rows.first().click();
  const summary = page.locator("#text-work-summary .text-work-summary");
  await expect(summary.locator("h2")).toHaveText("오래된 소설");
  await expect(summary).toContainText("북토끼");
  await expect(summary).toContainText("읽음 0/30");
  await summary.locator("input").fill("25");
  await summary.locator("input").press("Enter");
  await expect(page.locator('#result-list [data-key="chapter:1-25"]')).toBeFocused();

  // Arcalive works count posts read from the board folders too.
  await page.goto("/text?lane=arcalive&board=novel&category=%EC%86%8C%EC%84%A4");
  await page.locator("#result-list .result-item", { hasText: "긴 연재 1화" }).click();
  await expect(page.locator("#reader-title")).toHaveText("긴 연재 1화");
  await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("redstm.textState.v1")).history["arcalive:novel:101:text"]?.progress ?? 0)).toBeGreaterThan(0.9);
  await page.goto("/text?lane=arcalive&view=works");
  await expect(page.locator("#text-read-chips")).toBeVisible();
  await expect(page.locator("#result-list .result-item[data-key]").first()).toContainText("1/3편");
  await page.locator('#text-read-chips [data-text-read="finished"]').isDisabled();

  // A search above a category lists the posts themselves.
  await page.goto("/text?lane=arcalive");
  await page.locator("#search-input").fill("다른");
  await expect(page.locator("#result-list .result-item[data-key] .result-title")).toHaveText(["다른 글"]);
  await expect(page.locator("#result-list .result-item[data-key]").first()).toContainText("free · 잡담");
  await page.locator("#result-list .result-item[data-key]").first().click();
  await expect(page.locator("#reader-title")).toHaveText("다른 글");
});

test("AA keeps each picture's zoom and sideways position, and can fit wide pictures on open", async ({ page }) => {
  await useLongCollection(page, 3);
  const wide = (id) => ({
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`, title: `${id}편 제목`,
      author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1, is_aa: true,
      body_html: `<div class="AA_Text">${Array.from({ length: 30 }, () => `<p>${"＿".repeat(160)}</p>`).join("")}</div>`,
    },
    comments: [],
  });
  await page.route(/\/archive\/posts\/board_a\/[12]-/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(wide(Number(/board_a\/(\d+)-/.exec(route.request().url())[1]))),
  }));
  await page.goto("/read/board_a/1");
  await expect(page.locator("#aa-controls")).toBeVisible();
  // One scale control in the body toolbar.
  await expect(page.locator("#aa-controls [data-aa-size-delta]")).toHaveCount(0);
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await page.locator("#archive-body").evaluate((body) => { body.scrollLeft = 300; body.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).aaViews?.["board_a:1"]?.left)).toBe(300);

  // Another picture keeps its own default zoom.
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#aa-zoom-output")).toHaveText("100%");

  await page.goto("/read/board_a/1");
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await expect.poll(() => page.locator("#archive-body").evaluate((body) => body.scrollLeft)).toBe(300);

  // 넓은 AA 화면에 맞추기 fits a picture with no zoom of its own, without remembering it.
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator('[data-aa-auto-fit="on"]').click();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#aa-zoom-output")).not.toHaveText("100%");
  await expect.poll(() => page.locator("#archive-body").evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).aaViews?.["board_a:2"]?.zoom)).toBeUndefined();
});

test("Novel shelves: sort works into personal shelves, hide a shelf, and browse by shelf", async ({ page }) => {
  await useTextArchive(page, {
    novels: [
      novelWork({ id: 1, title: "가 소설", chapters: 3, updated: "2026-09-03T00:00:00Z" }),
      novelWork({ id: 2, title: "나 소설", chapters: 3, updated: "2026-09-02T00:00:00Z" }),
      novelWork({ id: 3, title: "다 소설", chapters: 3, updated: "2026-09-01T00:00:00Z" }),
    ],
  });
  await page.goto("/text?lane=novel");
  const titles = page.locator("#result-list .result-item[data-key] .result-title");
  await expect(titles).toHaveText(["가 소설", "나 소설", "다 소설"]);
  const dialog = page.locator("#shelf-dialog");

  // 안 볼 작품 is a hidden starter shelf: the work leaves the 전체 list.
  await page.locator('.shelf-edit[data-work-id="novel:toki:1"]').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#shelf-dialog-work")).toHaveText("가 소설");
  await dialog.locator('[data-shelf-choice="sskip"]').click();
  await expect(dialog.locator('[data-shelf-choice="sskip"]')).toHaveAttribute("aria-checked", "true");
  await dialog.locator("button[aria-label='닫기']").click();
  await expect(titles).toHaveText(["나 소설", "다 소설"]);
  await expect(page.locator("#result-status")).toContainText("숨긴 분류 1개 제외");

  // A new shelf made while sorting a work takes that work.
  await page.locator('.shelf-edit[data-work-id="novel:toki:2"]').click();
  await dialog.locator("#shelf-new-name").fill("BL");
  await dialog.locator("#shelf-add").click();
  await expect(dialog.locator('[aria-checked="true"]')).toHaveText("BL");
  await dialog.locator("button[aria-label='닫기']").click();
  await expect(page.locator('.shelf-edit[data-work-id="novel:toki:2"]')).toHaveText("BL");

  await page.locator('[data-novel-view="shelves"]').click();
  await expect(page).toHaveURL(/view=shelves/);
  const folders = page.locator("#result-list .result-item[data-key]");
  await expect(folders.locator(".result-title")).toHaveText(["미분류", "찜 · 나중에 볼 작품", "다 본 작품", "안 볼 작품", "BL"]);
  await expect(folders.nth(3)).toContainText("전체 목록에서 숨김");
  await folders.filter({ hasText: "BL" }).click();
  await expect(titles).toHaveText(["나 소설"]);
  await expect(page.locator("#text-work-back")).toHaveText("← 분류 목록");

  // The chapter view shows and changes the shelf too.
  await page.locator("#text-work-back").click();
  await folders.filter({ hasText: "미분류" }).click();
  await page.locator("#result-list .result-item[data-key]").first().click();
  await expect(page.locator(".shelf-summary")).toHaveText("분류: 미분류");
  await page.locator(".shelf-summary").click();
  await dialog.locator('[data-shelf-choice="slater"]').click();
  await dialog.locator("button[aria-label='닫기']").click();
  await expect(page.locator(".shelf-summary")).toHaveText("분류: 찜 · 나중에 볼 작품");

  // 분류 관리: rename, move, and remove (its works return to 미분류).
  await page.goto("/text?lane=novel");
  await page.locator("#novel-shelf-manage").click();
  await expect(dialog.locator("#shelf-choice")).toBeHidden();
  const bl = dialog.locator("#shelf-manage-list li").last();
  await expect(bl.locator("input[type='text']")).toHaveValue("BL");
  await bl.locator("input[type='text']").fill("비엘");
  await bl.locator("input[type='text']").press("Tab");
  await expect(dialog.locator("#shelf-manage-list input[type='text']").last()).toHaveValue("비엘");
  await dialog.locator('[data-shelf-id] [data-shelf-action="up"]').last().click();
  await expect(dialog.locator("#shelf-manage-list input[type='text']").nth(2)).toHaveValue("비엘");
  const skip = dialog.locator('[data-shelf-id="sskip"]');
  await skip.locator('[data-shelf-action="remove"]').click();
  await skip.locator('[data-shelf-action="remove"]').click();
  await expect(dialog.locator('[data-shelf-id="sskip"]')).toHaveCount(0);
  await dialog.locator("button[aria-label='닫기']").click();
  await expect(titles).toHaveText(["가 소설", "나 소설", "다 소설"]);
  await page.reload();
  await expect(page.locator('.shelf-edit[data-work-id="novel:toki:2"]')).toHaveText("비엘");
});

test("Backup v3 carries TypeMoon and text records, and 합쳐서 가져오기 merges them", async ({ page }) => {
  await useLongCollection(page, 3);
  await useTextArchive(page, { novels: [novelWork({ id: 1, title: "첫 소설", chapters: 3 })] });
  await page.addInitScript(() => {
    if (localStorage.getItem("redstm.textState.v1")) return;
    localStorage.setItem("redstm.textState.v1", JSON.stringify({ schema_version: 1, bookmarks: {},
      history: { "novel:novel:toki:1:1-1": { readAt: "2026-09-01T00:00:00Z", progress: 1, workId: "novel:toki:1" } },
      shelves: [{ id: "sbl", name: "BL", hidden: true }], workShelves: { "novel:toki:1": "sbl" } }));
  });
  await page.goto("/settings");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-state").click()]);
  const raw = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks));
  // Without the owner's store there are no records, so the file stays v3; it is still gzip.
  const backup = JSON.parse(gunzipSync(raw).toString("utf8"));
  expect(backup).toMatchObject({ format: "redstm-backup", schema_version: 3 });
  expect(backup.typemoon.settings).toBeTruthy();
  expect(backup.text.history["novel:novel:toki:1:1-1"].progress).toBe(1);
  expect(backup.text.shelves).toEqual([{ id: "sbl", name: "BL", hidden: true }]);

  const incoming = {
    format: "redstm-backup", schema_version: 3, exported_at: "2026-09-20T00:00:00.000Z",
    typemoon: { ...backup.typemoon, settings: { ...backup.typemoon.settings, theme: "dark" },
      history: { "board_a:2": { readAt: "2026-09-20T00:00:00Z", progress: 0.5 } } },
    text: { history: { "novel:novel:toki:1:1-2": { readAt: "2026-09-20T00:00:00Z", progress: 0.4 } }, bookmarks: {},
      shelves: [{ id: "sdone", name: "완결 후 정주행", hidden: false }], workShelves: {} },
  };
  await page.locator("#import-state-file").setInputFiles({
    name: "redstm-state.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await expect(page.locator("#import-review-summary")).toContainText("분류 1");
  await expect(page.locator("#import-merge")).toBeFocused();
  await page.locator("#import-merge").click();
  await expect(page.locator("#import-review-summary")).toHaveText("기록을 합쳐서 가져왔습니다");
  const text = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.textState.v1")));
  expect(Object.keys(text.history).sort()).toEqual(["novel:novel:toki:1:1-1", "novel:novel:toki:1:1-2"]);
  expect(text.shelves.map((shelf) => shelf.name)).toEqual(["BL", "완결 후 정주행"]);
  expect(text.workShelves).toEqual({ "novel:toki:1": "sbl" });
  const typemoon = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")));
  expect(typemoon.history["board_a:2"].progress).toBe(0.5);
  // Merging keeps this browser's settings.
  expect(typemoon.settings.theme).not.toBe("dark");
});

// T28: the continue-reading mini bar rides on the phone tab bar outside the Reader.
test("The mini bar continues reading from any list, folds on scroll and steps aside for Home's card", async ({ page }) => {
  test.skip(!mobileWidth(page), "phone tab bar only");
  await useLongCollection(page, 40);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const bar = page.locator("#mini-bar");
  await expect(bar).toBeHidden();
  await page.locator("#reader-bottom-list").click();
  await page.locator('.bottom-nav [data-destination="library"]').click();
  await expect(page.locator("#continue-reading")).toBeVisible();
  await expect(bar).toBeHidden();

  await page.locator('.bottom-nav [data-destination="browse"]').click();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAccessibleName(/2편 제목/);
  const list = page.locator("#result-list");
  await list.evaluate((element) => { element.scrollTop = 600; });
  await expect(bar).toHaveClass(/folded/);
  // Out of sight is out of the tab order too.
  await expect(bar).toHaveJSProperty("inert", true);
  await list.evaluate((element) => { element.scrollTop = 200; });
  await expect(bar).not.toHaveClass(/folded/);
  await expect(bar).toHaveJSProperty("inert", false);
  // The list keeps room for the bar and the tabs together.
  const listBottom = await page.locator(".catalog").evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  expect(listBottom).toBeGreaterThanOrEqual(102);

  await bar.click();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(bar).toBeHidden();
});

// docs/24 §8.2: a first visit gets one block of ways in; once there is a record, the continue card
// shows the sentence the reader last saw, taken only from the original text.
test("Home greets a first visit with sources and later quotes the last sentence read", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  const onboarding = page.locator("#home-onboarding");
  await expect(onboarding).toBeVisible();
  await expect(page.locator("#continue-block")).toBeHidden();
  await expect(page.locator("#reading-works")).toBeHidden();
  await onboarding.locator('[data-home-source="novel"]').click();
  await expect(page).toHaveURL(/\/text\?lane=novel$/);

  const exact = "2편 본문 5";
  await page.evaluate((text) => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    history: { "board_a:2": { readAt: new Date().toISOString(), progress: 0.3,
      loc: { v: 2, tm: 1, rev: "", start: 30, end: 30 + text.length, exact: text, prefix: "본문 4. 그리고 ", suffix: "의 끝. 다음 문장" } } },
  })), exact);
  await page.goto("/");
  await expect(page.locator("#continue-title")).toHaveText("2편 제목");
  await expect(page.locator("#continue-quote")).toHaveText("그리고 2편 본문 5의 끝. 다음 문장");
  await expect(page.locator("#continue-cover .type-cover")).toBeVisible();
  await expect(onboarding).toBeHidden();
});

// T27 (browser part): the work barcode summarises the run, draws within a frame, and picks an
// episode by keyboard through the magnified strip.
test("The work barcode summarises a long run and opens an episode picked on its strip", async ({ page }) => {
  await useLongCollection(page, 3000);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.goto("/collections/1");
  const barcode = page.locator("#collection-barcode");
  await expect(barcode.locator(".barcode-summary")).toHaveText("3,000화 중 0화 읽음");
  expect(Number(await barcode.getAttribute("data-render-ms"))).toBeLessThan(16);
  await expect(page.locator("#collection-cover .type-cover")).toBeVisible();
  const track = barcode.getByRole("slider");
  await expect(track).toHaveAccessibleName(/회차 바코드: 3,000화 중 0화 읽음/);
  await track.focus();
  await track.press("ArrowRight");
  await expect(track).toHaveAttribute("aria-valuetext", /편–\d+편 · (읽는 중|안 읽음 포함)/);
  // A narrower bar regroups the bins but keeps the chosen episode and a valid value.
  await track.press("End");
  const size = page.viewportSize();
  await page.setViewportSize({ width: Math.max(320, Math.round(size.width / 2)), height: size.height });
  await expect(track).toHaveAttribute("aria-valuetext", /3000편 · /);
  expect(Number(await track.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(await track.getAttribute("aria-valuemax")));
  await page.setViewportSize(size);
  await track.press("Home");
  await expect(track).toHaveAttribute("aria-valuetext", /^1편–\d+편 · 읽는 중/);
  await track.press("Enter");
  const options = barcode.locator(".barcode-option");
  await options.nth(2).click();
  await barcode.getByRole("button", { name: "이 회차로" }).click();
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
});

test("A text work shows its cover and barcode, and the barcode opens a chapter", async ({ page }) => {
  await useTextArchive(page, { novels: [novelWork({ id: 1, title: "바코드 소설", chapters: 40 })] });
  await page.goto(`/text?lane=novel&work=${encodeURIComponent("novel:toki:1")}`);
  const summary = page.locator("#text-work-summary .text-work-summary");
  await expect(summary.locator("h2")).toHaveText("바코드 소설");
  await expect(summary.locator(".work-cover .type-cover")).toBeVisible();
  const track = summary.getByRole("slider");
  await expect(track).toHaveAccessibleName("회차 바코드: 40화 중 0화 읽음");
  await track.focus();
  await track.press("End");
  await track.press("Enter");
  await summary.locator(".barcode-option").last().click();
  await summary.getByRole("button", { name: "이 회차로" }).click();
  await expect(page.locator("#reader-title")).toContainText("40화");
});


// docs/24 §8.11 · T34: find paints hits without touching the body, moves to them, and closing
// offers the place before the first move.
test("Find in the chapter counts hits, moves to them, and offers the place it started from", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const bodyBefore = await page.locator("#archive-body").innerHTML();
  const startTop = await page.locator("#reader-pane").evaluate((pane) => pane.scrollTop);
  await page.locator(mobileWidth(page) ? "#reader-find" : "#reader-toolbar-find").click();
  const input = page.locator("#find-input");
  await expect(input).toBeFocused();
  await input.fill("본문 3");
  // "본문 3", "본문 30" … "본문 39": 11 hits in document order.
  await expect(page.locator("#find-count")).toHaveText("1/11");
  expect(await page.evaluate(() => CSS.highlights.get("redstm-find")?.size)).toBe(11);
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.locator("#find-count")).toHaveText("2/11");
  const moved = await page.locator("#reader-pane").evaluate((pane) => pane.scrollTop);
  expect(moved).toBeGreaterThan(startTop);
  expect(await page.locator("#archive-body").innerHTML()).toBe(bodyBefore);
  if (mobileWidth(page)) await expect(page.locator(".reader-bottom")).toBeHidden();
  await page.locator("#find-close").click();
  await expect(page.locator("#find-bar")).toBeHidden();
  expect(await page.evaluate(() => CSS.highlights.has("redstm-find"))).toBe(false);
  await page.locator("#find-return-button").click();
  await expect.poll(() => page.locator("#reader-pane").evaluate((pane) => pane.scrollTop)).toBeLessThan(moved);
  // g opens it again from the keyboard; Escape closes it as one layer.
  if (!mobileWidth(page)) {
    await page.locator("#archive-body").click();
    await page.keyboard.press("g");
    await expect(page.locator("#find-bar")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#find-bar")).toBeHidden();
    await expect(page.locator("#reader")).toBeVisible();
  }
});

test("The mini bar appears on a list opened directly once saved records resolve", async ({ page }) => {
  test.skip(!mobileWidth(page), "phone tab bar only");
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    history: { "board_a:3": { readAt: "2026-09-30T02:57:00Z", progress: 0.38 } },
  })));
  await useLongCollection(page, 12);
  await page.goto("/browse");
  await expect(page.locator("#mini-bar")).toBeVisible();
  await expect(page.locator("#mini-bar")).toHaveAccessibleName(/3편 제목/);
});

test("The chapter end shows where the episode sits in its work", async ({ page }) => {
  await useLongCollection(page, 12);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#end-run-label")).toHaveText("2/12편");
  await expect(page.locator("#end-run .barcode-mini .bin.reading")).toHaveCount(1);
});

// docs/24 §8.8: Aa opens the quick panel; changes apply at once and keep the top sentence.
test("Aa opens quick settings that apply at once and lead to all settings", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  const panel = page.locator("#quick-settings");
  await expect(panel).toBeVisible();
  await expect(page.locator("#quick-size-output")).toHaveText("18");
  await panel.getByRole("button", { name: "글자 크게" }).click();
  await expect(page.locator("#quick-size-output")).toHaveText("19");
  await expect(page.locator("#archive-body")).toHaveCSS("font-size", "19px");
  await panel.getByRole("radio", { name: "먹" }).click();
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(panel).toHaveCSS("color-scheme", "dark");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.locator("#reader")).toBeVisible();
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(panel).toBeHidden();
});

// docs/24 §8.9: the folded badge opens the scrubber; a scrub keeps the place it left.
test("The scrubber moves through the chapter and offers the place before the move", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const pane = page.locator("#reader-pane");
  await pane.evaluate((element) => { element.scrollTop = 300; element.dispatchEvent(new Event("scroll")); });
  await pane.hover();
  await page.mouse.wheel(0, 400);
  await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
  const before = await pane.evaluate((element) => element.scrollTop);
  await page.locator("#reader-status").click();
  const sheet = page.locator("#scrubber");
  await expect(sheet).toBeVisible();
  await expect(page.locator("#scrubber-run-label")).toHaveText("2/3편");
  await page.locator("#scrubber-position").evaluate((input) => {
    input.value = "900";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#scrubber-output")).toHaveText("90%");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 200);
  await sheet.getByRole("button", { name: "닫기" }).click();
  await page.locator("#reader-status").evaluate((badge) => badge.click());
  await expect(sheet.locator("#scrubber-return")).toHaveText("이동 전 위치로");
  await sheet.locator("#scrubber-return").click();
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeLessThan(before + 80);
});

// Fine typography reaches prose only; an AA picture keeps its grid (T06, docs/24 §8.16).
test("Paragraph spacing and indent change prose but never an AA picture", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.route("**/archive/posts/board_a/1-*", (request) => {
    const payload = postPayload(1);
    payload.post.is_aa = true;
    payload.post.body_html = '<p>（　´∀｀）</p><div class="AA_Text">　|　　|</div>';
    return request.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  for (const [id, value] of [["#paragraph-spacing", "1.5"], ["#text-indent", "1"]]) {
    await page.locator(id).evaluate((input, next) => {
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }
  await expect(page.locator("#font-preview")).toContainText("2편 본문 1");
  const prose = page.locator("#archive-body p").first();
  await expect(prose).toHaveCSS("text-indent", "18px");
  await expect(prose).toHaveCSS("margin-bottom", "27px");
  await page.goto("/read/board_a/1");
  const aa = page.locator("#archive-body.aa p").first();
  await expect(aa).toHaveCSS("text-indent", "0px");
  await expect(aa).toHaveCSS("margin-bottom", "0px");
});

// P3-1 (docs/24 §8.13): a selection becomes a mark or a note in the owner's store, painted as a
// Custom Highlight without touching the body, kept across a reload and cleared from its menu.
// T21: marks sit below find; T26: on a touch screen the menu is the fixed bar in the dock's place.
const selectParagraph = (page, index) => page.evaluate((at) => {
  const paragraph = document.querySelectorAll("#archive-body p")[at];
  paragraph.scrollIntoView({ block: "center" });
  const node = paragraph.firstChild;
  getSelection().setBaseAndExtent(node, 0, node, node.data.length);
}, index);
const highlightTexts = (page, name) => page.evaluate((key) => [...(CSS.highlights.get(key) ?? [])].map((range) => range.toString()), name);

test("A selection is marked, noted and cleared, and marks survive a reload", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  const before = await page.locator("#archive-body").innerHTML();
  const menu = page.locator("#selection-menu");
  await selectParagraph(page, 2);
  await expect(menu).toBeVisible();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expect(menu).toHaveClass(/fixed/);
    const box = await menu.boundingBox();
    expect(box.y + box.height).toBeGreaterThan(page.viewportSize().height - 80);
  }
  await expect(menu.locator("button:visible")).toHaveText(["표시", "메모", "복사", "⋯"]);
  await page.locator("#sel-mark").click();
  await expect(menu).toBeHidden();
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual(["2편 본문 3"]);
  expect(await page.evaluate(() => CSS.highlights.get("redstm-mark").priority)).toBeLessThan(0);
  await selectParagraph(page, 4);
  await page.locator("#sel-note").click();
  const dialog = page.locator("#note-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#note-quote")).toHaveText("2편 본문 5");
  await page.locator("#note-text").fill("다시 볼 장면");
  await page.locator("#note-save").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => highlightTexts(page, "redstm-note")).toEqual(["2편 본문 5"]);
  // The body DOM is the same: no <mark> or <span> went in.
  expect(await page.locator("#archive-body").innerHTML()).toBe(before);
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual(["2편 본문 3"]);
  await expect.poll(() => highlightTexts(page, "redstm-note")).toEqual(["2편 본문 5"]);
  // A marked sentence opens its menu; the note shows there.
  await page.locator("#archive-body p").nth(4).click({ position: { x: 12, y: 8 } });
  await expect(page.locator("#mark-menu")).toBeVisible();
  await expect(page.locator("#mark-menu-note")).toHaveText("다시 볼 장면");
  await page.keyboard.press("Escape");
  await expect(page.locator("#mark-menu")).toBeHidden();
  await page.locator("#archive-body p").nth(2).click({ position: { x: 12, y: 8 } });
  await page.locator("#mark-delete").click();
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual([]);
  await page.reload();
  await expect.poll(() => highlightTexts(page, "redstm-note")).toEqual(["2편 본문 5"]);
  expect(await highlightTexts(page, "redstm-mark")).toEqual([]);
});

// P3-2 (docs/24 §8.5, F2/F4, B4): 기록 › 발췌 lists marks and notes newest first, searches them,
// exports them as Markdown and opens a card at its sentence; search's 내 기록 hands the words over.
test("기록 › 발췌 lists, searches, exports and opens marks at their sentence", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 30);
  await page.locator("#sel-mark").click();
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual(["2편 본문 31"]);
  await selectParagraph(page, 4);
  await page.locator("#sel-note").click();
  await page.locator("#note-text").fill("다시 볼 장면");
  await page.locator("#note-save").click();
  await expect.poll(() => highlightTexts(page, "redstm-note")).toEqual(["2편 본문 5"]);
  // Leave the reading place at the top, so opening the far card has to move.
  await page.locator("#reader-pane").evaluate((pane) => pane.scrollTo(0, 0));
  await page.waitForTimeout(500);

  await page.goto("/saved?view=excerpts");
  const cards = page.locator(".excerpt-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".excerpt-quote")).toHaveText("2편 본문 5");
  await expect(cards.nth(0).locator(".excerpt-note")).toHaveText("다시 볼 장면");
  await expect(cards.nth(0).locator(".result-meta")).toContainText("2편 제목");
  await expect(page.locator('[data-view="excerpts"]')).toHaveAttribute("aria-pressed", "true");
  const download = page.waitForEvent("download");
  await page.locator("#excerpts-export").click();
  const file = await download;
  const markdown = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
  expect(markdown).toContain("> 2편 본문 5\n\n다시 볼 장면\n\n— ");
  expect(markdown).toContain("/read/board_a/2");
  await page.locator("#search-input").fill("장면");
  await expect(cards).toHaveCount(1);
  await page.locator("#search-input").fill("");
  await expect(cards).toHaveCount(2);
  // The far mark opens its post at that sentence, not at the top.
  await cards.nth(1).click();
  await expect(page).toHaveURL(/\/read\/board_a\/2$/);
  await expect(page.locator("#archive-body p").nth(30)).toBeInViewport();
  // 검색's 내 기록 opens the same words in 기록 › 발췌.
  await page.goto("/search");
  await page.locator("#search-input").fill("본문 31");
  const records = page.locator("[data-records-scope]");
  await expect(records).toBeVisible();
  await records.click();
  await expect(page).toHaveURL(/\/saved\?view=excerpts&q=/);
  await expect(cards).toHaveCount(1);
  await expect(cards.first().locator(".excerpt-quote")).toHaveText("2편 본문 31");
});

// P3-3 (docs/24 §8.14): T13 — the card is drawn on a canvas under the Worker's real CSP, 1080×1350
// in the work colour; T33 — opened, left for five seconds, then 공유 still hands over the ready PNG.
// An AA selection becomes an image of its whole lines in the AA font and colours.
test("Share cards are drawn ahead and still share after waiting; AA lines become an image", async ({ page }) => {
  await page.addInitScript(() => {
    window.__shared = [];
    window.__copied = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: (data) => Boolean(data?.files?.length) });
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => {
      window.__shared.push({ text: data.text, files: data.files.map((file) => ({ name: file.name, type: file.type, size: file.size })), active: navigator.userActivation?.isActive ?? null });
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copied.push(text); } } });
  });
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await useLongCollection(page, 3);
  await page.route("**/archive/posts/board_a/1-*", (request) => {
    const payload = postPayload(1);
    payload.post.is_aa = true;
    payload.post.body_html = '<p>（　´∀｀）</p><p><font color="#b4232f">■■■■</font></p><p>끝</p>';
    return request.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 3);
  await page.locator("#sel-more").click();
  await page.locator("#selection-share").click();
  const dialog = page.locator("#share-dialog");
  await expect(dialog).toBeVisible();
  const send = page.locator("#share-send");
  await expect(send).toBeEnabled();
  const canvas = page.locator("#share-preview");
  const pixel = (x, y) => canvas.evaluate((element, [px, py]) => [...element.getContext("2d").getImageData(px, py, 1, 1).data].slice(0, 3), [x, y]);
  expect(await canvas.evaluate((element) => [element.width, element.height])).toEqual([1080, 1350]);
  // Text was drawn into the quote area (not an empty card).
  expect(await canvas.evaluate((element) => {
    const data = element.getContext("2d").getImageData(96, 160, 888, 120).data;
    const first = data.slice(0, 3).join();
    let different = 0;
    for (let index = 0; index < data.length; index += 4) if (data.slice(index, index + 3).join() !== first) different += 1;
    return different;
  })).toBeGreaterThan(200);
  const band = await pixel(540, 10);
  const page1 = await pixel(540, 700);
  expect(band).not.toEqual(page1);
  await page.waitForTimeout(5000);
  await send.click();
  await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1);
  const shared = await page.evaluate(() => window.__shared[0]);
  expect(shared.files).toEqual([expect.objectContaining({ type: "image/png" })]);
  expect(shared.files[0].size).toBeGreaterThan(1000);
  expect(shared.text).toContain("“2편 본문 4”");
  expect(shared.text).toContain("원문 저작권은 작가에게 있습니다");
  // 어둡게 redraws; the credit can be left out; 텍스트 복사 copies the same words.
  await page.locator('[data-share-tone="dark"]').click();
  await expect(send).toBeEnabled();
  expect(await pixel(540, 700)).toEqual([22, 21, 20]);
  await page.locator("#share-credit").uncheck();
  await page.locator("#share-copy").click();
  await expect(page.locator("#share-status")).toHaveText("텍스트를 복사했어요");
  expect(await page.evaluate(() => window.__copied[0])).not.toContain("저작권");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.goto("/read/board_a/1");
  await expect(page.locator("#archive-body")).toHaveClass(/aa/);
  await page.evaluate(() => {
    const paragraphs = document.querySelectorAll("#archive-body p");
    getSelection().setBaseAndExtent(paragraphs[0].firstChild, 2, paragraphs[1].querySelector("font").firstChild, 1);
  });
  const menu = page.locator("#selection-menu");
  await expect(menu.locator("#sel-image")).toBeVisible();
  await expect(menu.locator("#sel-mark")).toBeHidden();
  await menu.locator("#sel-image").click();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#share-tones")).toBeHidden();
  await expect(send).toBeEnabled();
  // Two whole lines on the picture's own background, the second one in its preserved red.
  const size = await canvas.evaluate((element) => [element.width, element.height]);
  expect(size[1]).toBeLessThan(200);
  expect(await pixel(2, 2)).toEqual([245, 245, 240]);
  expect(await canvas.evaluate((element) => {
    const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    for (let index = 0; index < data.length; index += 4) if (data[index] - data[index + 1] > 60 && data[index] - data[index + 2] > 50) return true;
    return false;
  })).toBe(true);
});

// P3-4 (DESIGN §9): five minutes of reading become today's 읽은 시간(추정), a streak, the month's
// heat map, the Home week and 오늘의 발췌; the stats card shares through the same sheet.
test("Reading time shows in 기록 › 통계, the Home week and today's excerpt", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00") });
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 6);
  await page.locator("#sel-mark").click();
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual(["2편 본문 7"]);
  // Let the session's start frame run before the first input (the fake clock drives frames).
  await page.clock.runFor(1000);
  for (let step = 0; step < 10; step += 1) {
    await page.locator("#reader-pane").evaluate((pane) => pane.scrollBy(0, 30));
    await page.clock.fastForward(30_000);
  }
  const go = (path) => page.evaluate((target) => {
    history.pushState({}, "", target);
    dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, path);
  await go("/saved?view=stats");
  await expect(page.locator("#stats-panel")).toBeVisible();
  await expect(page.locator("#result-list")).toBeHidden();
  // About five minutes; a slow runner can lose the first input or two to the session start.
  await expect(page.locator("#stats-today")).toHaveText(/^[3-6]분$/);
  await expect(page.locator("#stats-streak")).toHaveText("1일");
  await expect(page.locator("#stats-month-title")).toHaveText("10월");
  await expect(page.locator("#stats-heat li.today")).toHaveClass(/level-1/);
  await expect(page.locator("#stats-heat li.today")).toHaveAttribute("aria-label", /10월 1일 [3-6]분/);
  await expect(page.locator(".stats-note")).toHaveText("보존된 회차 기준");
  await page.locator("#stats-share").click();
  await expect(page.locator("#share-dialog")).toBeVisible();
  await expect(page.locator("#share-send")).toBeEnabled();
  await expect(page.locator("#share-tones")).toBeHidden();
  await page.keyboard.press("Escape");
  await go("/");
  await expect(page.locator("#home-week")).toBeVisible();
  await expect(page.locator("#home-week-total")).toHaveText(/^[3-6]분 · 1일 읽음$/);
  await expect(page.locator("#home-week-bars li")).toHaveCount(7);
  await expect(page.locator("#home-excerpt")).toBeVisible();
  await expect(page.locator("#home-excerpt .excerpt-quote")).toHaveText("2편 본문 7");
});

// P3-5 / T22: a mark made in one tab paints in another; backup v4 is a .json.gz with the marks,
// notes and sessions; importing it into an empty store brings them back on the page.
test("Marks reach another tab, ride in a v4 .json.gz backup and come back from it", async ({ page }) => {
  const me = (target) => target.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await me(page);
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 1);
  await page.locator("#sel-mark").click();
  await expect.poll(() => highlightTexts(page, "redstm-mark")).toEqual(["2편 본문 2"]);
  const other = await page.context().newPage();
  await me(other);
  await useLongCollection(other, 3);
  await other.goto("/read/board_a/2");
  await expect.poll(() => highlightTexts(other, "redstm-mark")).toEqual(["2편 본문 2"]);
  await selectParagraph(page, 3);
  await page.locator("#sel-mark").click();
  await expect.poll(() => highlightTexts(other, "redstm-mark").then((texts) => texts.sort())).toEqual(["2편 본문 2", "2편 본문 4"]);
  await other.close();

  await page.goto("/settings");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-state").click()]);
  expect(download.suggestedFilename()).toMatch(/\.json\.gz$/);
  const raw = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks));
  const backup = JSON.parse(gunzipSync(raw).toString("utf8"));
  expect(backup.schema_version).toBe(4);
  expect(backup.records.annotations.map((record) => record.quote).sort()).toEqual(["2편 본문 2", "2편 본문 4"]);

  // A device without these records: the owner's database is gone, then the backup comes in.
  await page.goto("/settings");
  await page.evaluate(() => new Promise((resolve) => { indexedDB.deleteDatabase("redstm:0123456789abcdef").onsuccess = resolve; }));
  await page.reload();
  await page.locator("#import-state-file").setInputFiles({ name: "redstm-state.json.gz", mimeType: "application/gzip", buffer: raw });
  await expect(page.locator("#import-review-summary")).toContainText("표시·메모 2");
  await page.locator("#import-merge").click();
  await expect(page.locator("#import-review-summary")).toContainText("표시·메모 2건");
  await page.goto("/read/board_a/2");
  await expect.poll(() => highlightTexts(page, "redstm-mark").then((texts) => texts.sort())).toEqual(["2편 본문 2", "2편 본문 4"]);
});

test("Without a verified owner, marking says it cannot store anything", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 1);
  await page.locator("#sel-mark").click();
  await expect(page.locator("#aa-zoom-indicator")).toHaveText("이 기기에 기록을 저장할 수 없어요");
  expect(await highlightTexts(page, "redstm-mark")).toEqual([]);
});

// Page mode tap zones (DESIGN §8.2 오른손) and the edge guard for system Back.
test("Page mode taps turn pages by zone, the middle shows the tools and edge swipes stay with Back", async ({ page }) => {
  test.skip(!mobileWidth(page), "tap zones are a touch layout");
  await page.addInitScript(() => {
    if (!localStorage.getItem("redstm.userState.v2")) localStorage.setItem("redstm.userState.v2", JSON.stringify({ schema_version: 2, settings: { readingMode: "page" }, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null, history: {} }));
  });
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader")).toHaveClass(/paged/);
  // A touch screen shows the zones once; a tap dismisses them for good.
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await page.locator("#page-hint").click();
    await expect(page.locator("#page-hint")).toBeHidden();
    await page.reload();
    await expect(page.locator("#reader")).toHaveClass(/paged/);
    await expect(page.locator("#page-hint")).toBeHidden();
  }
  const status = page.locator("#reader-status");
  await expect(status).toHaveText(/^1 \/ \d+쪽$/);
  const box = await page.locator("#reader-pane").boundingBox();
  const y = box.y + box.height / 2;
  const body = page.locator("#archive-body");
  const touch = async (type, x) => body.dispatchEvent(type, { isPrimary: true, pointerType: "touch", clientX: x, clientY: y });
  const tap = async (ratio) => {
    await touch("pointerdown", box.x + box.width * ratio);
    await touch("pointerup", box.x + box.width * ratio);
  };
  await tap(0.8);
  await expect(status).toHaveText(/^2 \//);
  await tap(0.1);
  await expect(status).toHaveText(/^1 \//);
  const hidden = await page.evaluate(() => document.body.classList.contains("reader-controls-hidden"));
  await tap(0.4);
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("reader-controls-hidden"))).toBe(!hidden);
  // A swipe from the middle follows the finger and turns on release.
  await touch("pointerdown", box.x + box.width * 0.8);
  await touch("pointermove", box.x + box.width * 0.5);
  await touch("pointermove", box.x + box.width * 0.2);
  await touch("pointerup", box.x + box.width * 0.2);
  await expect(status).toHaveText(/^2 \//);
  // One that starts at the screen edge is the system Back gesture's, not a page turn.
  await touch("pointerdown", 8);
  await touch("pointermove", 200);
  await touch("pointerup", 200);
  await page.waitForTimeout(300);
  await expect(status).toHaveText(/^2 \//);
});

// T01/T02 (automatable part): page mode keeps the same sentence through a font change, a
// rotation, a reload and a switch back to scrolling; no page is empty.
test("Page mode turns pages and keeps the sentence through size, rotation, reload and scroll", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("redstm.userState.v2")) localStorage.setItem("redstm.userState.v2", JSON.stringify({ schema_version: 2, settings: { readingMode: "page" }, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null, history: {} }));
  });
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#reader")).toHaveClass(/paged/);
  const status = page.locator("#reader-status");
  await expect(status).toHaveText(/^1 \/ \d+쪽$/);
  const pages = Number((await status.textContent()).match(/\/ (\d+)/)[1]);
  expect(pages).toBeGreaterThan(1);
  // The first visible paragraph on the current page, once a page turn has settled.
  const firstVisible = () => page.evaluate(async () => {
    const body = document.getElementById("archive-body");
    await Promise.all(body.getAnimations().map((animation) => animation.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const left = document.getElementById("reader-pane").getBoundingClientRect().left;
    const right = left + document.getElementById("reader-pane").clientWidth;
    return [...document.querySelectorAll("#archive-body p")].find((p) => {
      const box = p.getBoundingClientRect();
      return box.left >= left - 1 && box.right <= right + 1;
    })?.textContent ?? "";
  });
  await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText(`2 / ${pages}쪽`);
  // Wait for the 200ms turn to settle before reading what is on the page.
  await expect.poll(firstVisible).toMatch(/\d+$/);
  const sentence = await firstVisible();
  expect(sentence).not.toBe("2편 본문 1");
  // Every page has text: the last page is not empty.
  await page.keyboard.press("End");
  await expect(status).toHaveText(`${pages} / ${pages}쪽`);
  await expect.poll(firstVisible).toMatch(/\d+$/);
  for (let index = pages; index > 2; index -= 1) await page.keyboard.press("ArrowLeft");
  await expect(status).toHaveText(`2 / ${pages}쪽`);
  await expect.poll(firstVisible).toBe(sentence);
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.height, height: size.width });
  // Rotated, the pages hold different paragraphs, but the sentence the page began with is on screen.
  await expect.poll(() => page.evaluate(async (text) => {
    const body = document.getElementById("archive-body");
    await Promise.all(body.getAnimations().map((animation) => animation.finished.catch(() => {})));
    const pane = document.getElementById("reader-pane").getBoundingClientRect();
    const box = [...body.querySelectorAll("p")].find((p) => p.textContent === text)?.getClientRects()[0];
    return Boolean(box) && box.left >= pane.left && box.right <= pane.right;
  }, sentence)).toBe(true);
  await page.setViewportSize(size);
  await expect.poll(firstVisible).toBe(sentence);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(firstVisible).toBe(sentence);
  await page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator('#quick-settings [data-reading-mode="scroll"]').click();
  await expect(page.locator("#reader")).not.toHaveClass(/paged/);
  const top = await page.evaluate(() => {
    const pane = document.getElementById("reader-pane").getBoundingClientRect().top;
    return [...document.querySelectorAll("#archive-body p")].find((p) => p.getBoundingClientRect().bottom > pane + 60)?.textContent;
  });
  expect(Math.abs(Number(top.match(/\d+$/)[0]) - Number(sentence.match(/\d+$/)[0]))).toBeLessThanOrEqual(2);
});

// P5-1: 다른 기기에서 shows the place as a QR code and a link; opening the link (the other device)
// lands on that sentence rather than at the top or the reader's saved place.
test("다른 기기에서 hands the sentence over in a QR link that opens at it", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await page.evaluate(() => document.querySelectorAll("#archive-body p")[30].scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  if (mobileWidth(page)) await page.locator("#reader-bottom-more").click();
  else await page.locator("#reader-toolbar-more").click();
  await page.locator("#more-handoff").click();
  const dialog = page.locator("#handoff-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#handoff-code svg")).toHaveCount(1);
  const url = await page.locator("#handoff-url").inputValue();
  expect(url).toMatch(/\/read\/board_a\/2\?at=[A-Za-z0-9_-]+$/);
  await page.keyboard.press("Escape");
  // This device goes back to the top, so the link has to do the moving.
  await page.locator("#reader-pane").evaluate((pane) => pane.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.goto(url);
  await expect(page).toHaveURL(/\/read\/board_a\/2$/);
  await expect(page.locator("#archive-body p").nth(30)).toBeInViewport();
  await expect(page.locator("#aa-zoom-indicator")).toHaveText("다른 기기에서 읽던 곳이에요");
});

// P5-2: a backup where a note was edited differently on another device keeps both — the later
// edit, and this device's as a 충돌 사본 shown in 기록 › 발췌.
test("Merging a backup keeps a differently edited note as a conflict copy", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ownerHash: "0123456789abcdef" }) }));
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await selectParagraph(page, 2);
  await page.locator("#sel-note").click();
  await page.locator("#note-text").fill("이 기기 메모");
  await page.locator("#note-save").click();
  await expect.poll(() => highlightTexts(page, "redstm-note")).toEqual(["2편 본문 3"]);
  await page.goto("/settings");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-state").click()]);
  const raw = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks));
  const backup = JSON.parse(gunzipSync(raw).toString("utf8"));
  const record = backup.records.annotations[0];
  record.note = "다른 기기 메모";
  record.updatedAt = new Date(Date.parse(record.updatedAt) + 60_000).toISOString();
  await page.locator("#import-state-file").setInputFiles({ name: "other.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator("#import-merge").click();
  await expect(page.locator("#import-review-summary")).toContainText("충돌 사본으로 남김");
  await page.goto("/saved?view=excerpts");
  const cards = page.locator(".excerpt-card");
  await expect(cards).toHaveCount(2);
  await expect(page.locator(".excerpt-card", { hasText: "이 기기 메모" }).locator(".result-meta")).toContainText("충돌 사본");
  await expect(page.locator(".excerpt-card", { hasText: "다른 기기 메모" }).locator(".result-meta")).not.toContainText("충돌 사본");
});

// P6-2: 자동 스크롤 flows, pauses on touch and takes the dock's place; reading profiles switch the
// reading settings at once, and 이 작품만 opens a work with its profile without changing the base.
test("Auto scroll flows and pauses, and reading profiles apply globally or to one work", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#collection-context")).toBeVisible();
  const openMore = () => page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await openMore();
  await page.locator("#more-autoscroll").click();
  const bar = page.locator("#autoscroll-bar");
  await expect(bar).toBeVisible();
  const pane = page.locator("#reader-pane");
  const start = await pane.evaluate((element) => element.scrollTop);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(start + 10);
  await page.locator('[data-autoscroll-delta="1"]').click();
  await expect(page.locator("#autoscroll-speed")).toHaveText("4");
  await page.locator("#archive-body").dispatchEvent("pointerdown", { isPrimary: true, pointerType: "touch", clientX: 100, clientY: 300 });
  await expect(page.locator("#autoscroll-toggle")).toHaveText("▶");
  const paused = await pane.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(400);
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(paused);
  await page.locator("#autoscroll-toggle").click();
  await page.locator(mobileWidth(page) ? "#reader-find" : "#reader-toolbar-find").click();
  await expect(page.locator("#find-bar")).toBeVisible();
  await expect(bar).toBeHidden();
  await page.locator("#find-close").click();
  await expect(bar).toBeVisible();
  await expect(page.locator("#autoscroll-toggle")).toHaveText("▶");
  await page.locator("#autoscroll-close").click();
  await expect(bar).toBeHidden();

  const quick = () => page.locator(mobileWidth(page) ? "#reader-bottom-settings" : "#reader-settings").click();
  const surface = () => page.locator('#quick-settings [data-reader-surface][aria-checked="true"]').getAttribute("data-reader-surface");
  const saveAs = async (name) => {
    page.once("dialog", (dialog) => dialog.accept(name));
    await page.locator("#quick-profile-add").click();
    await expect(page.locator(`#quick-profile-list [data-profile="${name}"]`)).toBeVisible();
  };
  await quick();
  await saveAs("낮");
  await page.locator('#quick-settings [data-reader-surface="ink"]').click();
  await saveAs("밤");
  await expect(page.locator('#quick-profile-list [data-profile="밤"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#quick-profile-work-check").check();
  await page.locator('#quick-profile-list [data-profile="낮"]').click();
  expect(await surface()).toBe("default");
  // Reopened, the work wears its own profile while the stored base stays 낮.
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--reader-dim") || document.body.dataset.readerSurface || document.documentElement.dataset.readerSurface)).toBeTruthy();
  await quick();
  await expect.poll(surface).toBe("ink");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).settings);
  expect(stored.readerSurface).toBe("default");
  expect(Object.values(stored.workProfiles)).toEqual(["밤"]);
  await page.locator("#quick-profile-work-check").uncheck();
  await expect.poll(surface).toBe("default");
});

test("KWIC worker returns original locators and reports unreadable episodes separately", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const { createTextModel } = await import("/text-model.js");
    const worker = new Worker("/kwic-worker.js", { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        const found = [];
        worker.onerror = reject;
        worker.onmessage = ({ data }) => {
          if (data.type === "parse") {
            const body = new DOMParser().parseFromString(JSON.parse(data.raw).post.body_html, "text/html").body;
            worker.postMessage({ type: "parsed", queryId: data.queryId, parseId: data.parseId, text: createTextModel(body).text });
          } else if (data.type === "result") found.push(data);
          else if (data.type === "done") resolve(found);
        };
        worker.postMessage({ type: "search", queryId: 1, query: "본문 1", entries: [
          { documentId: "1", type: "typemoon", url: `/archive/posts/board_a/1-${"1".padStart(64, "0")}.json.zst` },
          { documentId: "missing", type: "typemoon", url: "/archive/missing.json" },
        ] });
      });
    } finally { worker.terminate(); }
  });
  expect(results).toHaveLength(2);
  expect(results.find((result) => result.entry.documentId === "1").matches[0].locator.exact).toBe("본문 1");
  expect(results.at(-1).failed).toBe(1);
  expect(results.find((result) => result.entry.documentId === "missing").error).toBe(true);
});

test("KWIC sheet filters before counts, widens explicitly and opens an original sentence", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  await page.evaluate(async () => {
    const { createKwic } = await import("/kwic.js");
    const { createTextModel } = await import("/text-model.js");
    const { createOverlayManager } = await import("/overlay-manager.js");
    document.querySelector("#kwic-dialog").remove();
    const kwic = createKwic({
      overlays: createOverlayManager(),
      parse: (_entry, raw) => createTextModel(new DOMParser().parseFromString(JSON.parse(raw).post.body_html, "text/html").body).text,
      async onOpen(hit, parent) { window.kwicOpened = { hit, parent }; },
    });
    kwic.open({ title: "긴 연재", from: "/collections/1", current: "1", read: ["1"], entries: [1, 2, 3].map((id) => ({
      title: `${id}편`, documentId: String(id), type: "typemoon", url: `/archive/posts/board_a/${id}-${id.toString(16).padStart(64, "0")}.json.zst`,
    })) }, "본문 40");
  });
  await expect(page.locator("#kwic-status")).toContainText("1화에 걸쳐 1곳");
  await page.locator("#kwic-all").check();
  await expect(page.locator("#kwic-status")).toContainText("3화에 걸쳐 3곳");
  await page.locator("#kwic-results button").nth(2).click();
  const opened = await page.evaluate(() => window.kwicOpened);
  expect(opened.hit.entry.documentId).toBe("3");
  expect(opened.hit.locator.exact).toBe("본문 40");
  expect(opened.parent).toBe("/collections/1?kwic=%EB%B3%B8%EB%AC%B8+40&kwicAll=1");
});


test("T16/T17 work search opens a sentence and Back restores the scoped results", async ({ page }) => {
  await useLongCollection(page, 200);
  await page.goto("/read/board_a/200");
  await expect(page.locator("#collection-context")).toBeVisible();
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#reader-work-find").click();
  await page.locator("#kwic-input").fill("본문 40");
  await page.locator("#kwic-search").getByRole("button", { name: "찾기", exact: true }).click();
  await expect(page.locator("#kwic-status")).toContainText("1화에 걸쳐 1곳");
  await expect(page.locator("#kwic-results button")).toHaveCount(1);
  await page.locator("#kwic-all").check();
  await expect(page.locator("#kwic-status")).toContainText("200화에 걸쳐 200곳");
  await page.locator("#kwic-results button").first().click();
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
  await page.goBack();
  await expect(page.locator("#kwic-dialog")).toBeVisible();
  await expect(page.locator("#kwic-input")).toHaveValue("본문 40");
  await expect(page.locator("#kwic-all")).toBeChecked();
  await expect(page.locator("#kwic-status")).toContainText("200화에 걸쳐 200곳");
});

test("T16/T17 novel work search uses original text and returns to its work", async ({ page }) => {
  await useTextArchive(page, { novels: [novelWork({ id: 1, title: "검색 소설", chapters: 3 })] });
  await page.goto(`/text?lane=novel&work=${encodeURIComponent("novel:toki:1")}&chapter=1-1`);
  await expect(page.locator("#reader-title")).toHaveText("1화");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#reader-work-find").click();
  await page.locator("#kwic-input").fill("본문 줄");
  await page.locator("#kwic-search").getByRole("button", { name: "찾기", exact: true }).click();
  await expect(page.locator("#kwic-status")).toContainText("1화에 걸쳐");
  await page.locator("#kwic-all").check();
  await expect(page.locator("#kwic-status")).toContainText("3화에 걸쳐");
  await page.locator("#kwic-results button").last().click();
  await expect(page.locator("#reader-title")).toHaveText("3화");
  await page.goBack();
  await expect(page.locator("#kwic-dialog")).toBeVisible();
  await expect(page.locator("#kwic-status")).toContainText("3화에 걸쳐");
});


test("T16/T17 Arcalive work search returns to its filtered chapter list", async ({ page }) => {
  const posts = [1, 2, 3].map((id) => arcalivePost({ id, title: `${id}편` }));
  const item = arcaliveWork({ key: "search", title: "검색 연재", posts });
  await useTextArchive(page, { posts, works: [item] });
  await page.goto(`/text?lane=arcalive&view=works&work=${encodeURIComponent(item.item.work_id)}&sort=latest&item=${encodeURIComponent(posts[0].identity)}`);
  await expect(page.locator("#reader-title")).toHaveText("1편");
  await page.locator(mobileWidth(page) ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#reader-work-find").click();
  await page.locator("#kwic-input").fill("본문 줄");
  await page.locator("#kwic-search").getByRole("button", { name: "찾기", exact: true }).click();
  await expect(page.locator("#kwic-status")).toContainText("1화에 걸쳐");
  await page.locator("#kwic-all").check();
  await expect(page.locator("#kwic-status")).toContainText("3화에 걸쳐");
  await page.locator("#kwic-results button").last().click();
  await expect(page.locator("#reader-title")).toHaveText("3편");
  await page.goBack();
  await expect(page.locator("#kwic-dialog")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("sort")).toBe("latest");
  await expect(page.locator("#kwic-status")).toContainText("3화에 걸쳐");
});
