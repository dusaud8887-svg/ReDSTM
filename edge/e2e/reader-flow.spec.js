import { expect, test } from "@playwright/test";

import { arcalivePost, arcaliveWork, novelWork, useTextArchive } from "./text-fixture.js";

// Reading-flow contracts from docs/19: one history entry per reading session, Back returns to
// the list viewport the session started from, and reading order never follows the list sort.

const hashFor = (id) => id.toString(16).padStart(64, "0");
const postKey = (id) => `posts/board_a/${id}-${hashFor(id)}.json.zst`;
const collectionIndexKey = `collections/index-v2-${"4".repeat(64)}.json.zst`;

function postPayload(id) {
  return {
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`,
      title: `${id}편 제목`, author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1,
      body_html: Array.from({ length: 40 }, (_, index) => `<p>${id}편 본문 ${index + 1}</p>`).join(""),
      is_aa: false,
    },
    comments: [],
  };
}

async function useLongCollection(page, count) {
  const entries = Array.from({ length: count }, (_, index) => ({
    position: index + 1, board_id: "board_a", external_post_id: index + 1,
    title: `${index + 1}편 제목`, object_key: postKey(index + 1),
  }));
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: count }],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: entries.map((entry) => ["board_a", entry.external_post_id, entry.title, "작성자", null, "2026-07-11", hashFor(entry.external_post_id), false]),
    }],
    [collectionIndexKey, { schema_version: 1, collections: [{ id: 1, board_id: "board_a", kind: "series", title: "긴 연재", entries }] }],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const post = /^posts\/board_a\/(\d+)-/.exec(key);
    const payload = post ? postPayload(Number(post[1])) : payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

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
  await page.locator('[data-prose-size-delta="1"]').click();
  await page.locator('[data-prose-size-delta="1"]').click();
  await page.locator('[data-prose-size-delta="1"]').click();
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
  await expect(viewer.locator("img")).toHaveAttribute("src", "https://img.example.test/a.png");
  // A picture smaller than the screen has nothing to zoom into.
  await expect(viewer.locator("#image-viewer-zoom")).toBeHidden();
  await viewer.getByRole("button", { name: "닫기" }).click();
  await expect(viewer).toBeHidden();
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
  await page.locator('#text-sort-chips [data-text-sort="latest"]').click();
  await expect(page.locator('#text-sort-chips [data-text-sort="latest"]')).toHaveAttribute("aria-pressed", "true");
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
  await page.locator('[data-reader-surface="paper"]').click();
  await expect(page.locator('[data-reader-surface="paper"]')).toHaveAttribute("aria-checked", "true");
  await expect.poll(readerBackground).not.toBe(plain);
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "start");
  await page.locator('[data-prose-align="justify"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "justify");
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect.poll(readerBackground).not.toBe(plain);
  await expect(page.locator("#archive-body")).toHaveCSS("text-align", "justify");
  // The app chrome keeps its own tokens; the browser bar matches the paper while reading.
  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
  const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.content));
  expect(await themeColors()).toEqual(["#f6f0e4", "#1c1914"]);
});

test("The browser bar follows the chosen theme even when the OS theme differs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await useLongCollection(page, 3);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const themeColors = () => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.content));
  expect(await themeColors()).toEqual(["#ffffff", "#0b0d12"]);
  await page.goto("/settings");
  await page.locator('[data-theme-choice="light"]').click();
  expect(await themeColors()).toEqual(["#ffffff", "#ffffff"]);
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
  const width = () => viewer.locator("img").evaluate((image) => image.getBoundingClientRect().width);
  expect(await width()).toBeLessThanOrEqual(page.viewportSize().width);
  await zoom.click();
  await expect(zoom).toHaveAttribute("aria-pressed", "true");
  await expect.poll(width).toBe(3000);
  // Panned to the middle of the picture, with the actions still on screen.
  expect(await viewer.locator("form").evaluate((form) => form.scrollLeft)).toBeGreaterThan(0);
  await expect(zoom).toBeInViewport();
  await zoom.click();
  await expect.poll(width).toBeLessThanOrEqual(page.viewportSize().width);
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
  await expect(page.locator("#text-sort-chips [data-text-sort=\"recent\"]")).toHaveText("최근 읽은순");
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
  await expect(page.locator('#text-sort-chips [data-text-sort="latest"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#text-sort-chips [data-text-sort=\"oldest\"]").click();
  await expect(titles).toHaveText(["10번 글", "20번 글", "30번 글"]);
  await expect(page).toHaveURL(/sort=oldest/);
  await page.locator("#text-sort-chips [data-text-sort=\"latest\"]").click();
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
  await expect(page.locator('#text-sort-chips [data-text-sort="updated"]')).toHaveText("최근 갱신순");
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
  const summary = page.locator("#result-list .text-work-summary");
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
  await page.locator('[data-aa-auto-fit="on"]').click();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.goto("/read/board_a/2");
  await expect(page.locator("#reader-title")).toHaveText("2편 제목");
  await expect(page.locator("#aa-zoom-output")).not.toHaveText("100%");
  await expect.poll(() => page.locator("#archive-body").evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).aaViews?.["board_a:2"]?.zoom)).toBeUndefined();
});
