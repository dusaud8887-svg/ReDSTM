import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const firstHash = "1".repeat(64);
const secondHash = "2".repeat(64);
const standaloneHash = "3".repeat(64);
const firstKey = `posts/board_a/1-${firstHash}.json.zst`;
const secondKey = `posts/board_a/2-${secondHash}.json.zst`;
const standaloneKey = `posts/board_a/3-${standaloneHash}.json.zst`;
const collectionIndexKey = `collections/index-v2-${"4".repeat(64)}.json.zst`;
const collectionDetailKey = `collections/details-v2/01-${"5".repeat(64)}.json.zst`;
const collectionMembershipKey = `collections/membership-v2/board_a-${"6".repeat(64)}.json.zst`;
const aaKey = process.env.REDSTM_AA_KEY || firstKey;
const proseKey = process.env.REDSTM_PROSE_KEY || secondKey;

function stableUrl(key) {
  const match = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-/.exec(key);
  if (!match) throw new Error(`Invalid post key: ${key}`);
  return `/read/${match[1]}/${match[2]}`;
}

function postPayload(id, title) {
  return {
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`,
      title, author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1,
      body_html: [
        `<p class="legacy-prose" style="font: italic 10px/1.1 Arial !important"><font face="Arial" size="1">${title} 본문 1</font></p>`,
        ...Array.from({ length: 29 }, (_, index) => `<p>${title} 본문 ${index + 2}</p>`),
      ].join(""), is_aa: false,
    },
    comments: [],
  };
}

function aaPostPayload(id, title) {
  const payload = postPayload(id, title);
  payload.post.is_aa = true;
  payload.post.body_html = `<div class="AA_Text"><p><font color="#b4232f" style="font: bold 20px/2 Arial !important">${title}</font></p><p>（　´∀｀）</p><p>　|　　|</p></div>`;
  payload.comments = [
    {
      position: 1, author: "일반", created_at_raw: "2026-07-11",
      content_html: "<p>일반 댓글</p>", content_text: "일반 댓글", depth: 0,
    },
    {
      position: 2, author: "AA", created_at_raw: "2026-07-11",
      content_html: "<pre style=\"font-family: 'ＭＳ Ｐゴシック'\">（　´∀｀）\n /　 つ</pre>",
      content_text: "（　´∀｀）\n /　 つ", depth: 1,
    },
  ];
  return payload;
}

async function useCollectionFixture(page, { collectionV2 = false, largeStandalone = false, legacyIndex = false, paginated = false, releaseGate } = {}) {
  const standalone = postPayload(3, "비소속");
  if (largeStandalone) standalone.transfer_padding = "x".repeat(1_100_000);
  const collection = {
    id: 1, board_id: "board_a", kind: "series", title: "테스트 연작",
    entries: [
      { position: 1, board_id: "board_a", external_post_id: 1, title: "첫째", object_key: firstKey },
      { position: 2, board_id: "board_a", external_post_id: 99, title: "보존 불가", object_key: null },
      { position: 3, board_id: "board_a", external_post_id: 2, title: "둘째", object_key: secondKey },
    ],
  };
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: 3 }],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", ...(legacyIndex ? [] : ["is_aa"])],
      posts: [
        ["board_a", 3, "비소속", "작성자", null, "2026-07-11", standaloneHash, false],
        ["board_a", 2, "둘째", "작성자", null, "2026-07-11", secondHash, false],
        ["board_a", 1, "첫째", "작성자", null, "2026-07-11", firstHash, true],
        ...(paginated ? Array.from({ length: 100 }, (_, index) => {
          const id = index + 4;
          return ["board_a", id, `과거 ${id}`, "작성자", null, "2026-07-10", id.toString(16).padStart(64, "0"), false];
        }) : []),
      ].map((row) => legacyIndex ? row.slice(0, -1) : row),
    }],
    [collectionIndexKey, collectionV2 ? {
      schema_version: 2,
      shard_count: 64,
      collections: [{
        id: 1, board_id: "board_a", kind: "series", title: "테스트 연작", entry_count: 3,
        unavailable_count: 1, latest_created_at: "2026-07-11T00:00:00Z",
      }],
      detail_shards: [{ shard: 1, object_key: collectionDetailKey }],
      memberships: [{ board_id: "board_a", object_key: collectionMembershipKey }],
    } : { schema_version: 1, collections: [collection] }],
    ...(collectionV2 ? [
      [collectionDetailKey, { schema_version: 1, shard: 1, collections: [collection] }],
      [collectionMembershipKey, { schema_version: 1, board_id: "board_a", members: [[1, 1, 1], [2, 1, 3], [99, 1, 2]], unavailable: [99] }],
    ] : []),
    [firstKey, aaPostPayload(1, "첫째")],
    [secondKey, postPayload(2, "둘째")],
    [standaloneKey, standalone],
  ]);
  if (paginated) {
    const id = 103;
    const hash = id.toString(16).padStart(64, "0");
    payloads.set(`posts/board_a/${id}-${hash}.json.zst`, postPayload(id, `과거 ${id}`));
  }
  const requested = new Set();
  await page.route("**/archive/**", async (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    requested.add(key);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    if (key === "release.json" && releaseGate) await releaseGate();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  return requested;
}

async function usePaginationFixture(page, count) {
  // Only the search index needs the rows; list entries never fetch a post body, so a large
  // board can be exercised without a payload per post.
  const posts = Array.from({ length: count }, (_, index) => {
    const id = count - index; // newest first, matching the default latest sort
    return ["board_a", id, `글 ${id}`, "작성자", null, "2026-07-11", String(id).padStart(64, "0"), false];
  });
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts,
    }],
    [collectionIndexKey, { schema_version: 1, collections: [] }],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function useCollectionPaginationFixture(page, count) {
  const collectionId = count;
  const shard = collectionId % 64;
  const detail = {
    id: collectionId, board_id: "board_a", kind: "series", title: `작품 ${collectionId}`,
    entries: [{ position: 1, board_id: "board_a", external_post_id: 3, title: "비소속", object_key: standaloneKey }],
  };
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: [["board_a", 3, "비소속", "작성자", null, "2026-07-11", standaloneHash, false]],
    }],
    [collectionIndexKey, {
      schema_version: 2, shard_count: 64,
      collections: Array.from({ length: count }, (_, index) => ({
        id: index + 1, board_id: "board_a", kind: "series", title: `작품 ${index + 1}`, entry_count: 1,
        latest_created_at: "2026-07-11T00:00:00Z",
      })),
      detail_shards: [{ shard, object_key: collectionDetailKey }], memberships: [],
    }],
    [collectionDetailKey, { schema_version: 1, shard, collections: [detail] }],
    [standaloneKey, postPayload(3, "비소속")],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function useAccessExpiredFixture(page) {
  await page.route("**/archive/**", (route) => route.fulfill({ status: 403, body: "expired" }));
}

async function setSelect(page, id, value) {
  await page.locator(`#${id}`).evaluate((element, selected) => {
    element.value = selected;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function boardFilterLabels(page) {
  return page.locator("#board-filter option").evaluateAll((options) =>
    options.map((option) => option.textContent));
}

async function useBoardFilterFixture(page) {
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [
        { board_id: "aa_19", name: "19금 AA", group_name: "aa", post_count: 1 },
        { board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: 1 },
        { board_id: "write_free", name: "창작집담", group_name: "창작", post_count: 1 },
      ],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: [
        ["write_free", 1, "소설 글", "작성자", null, "2026-07-11", "a".repeat(64), false],
        ["aa_19", 1, "AA 글", "작성자", null, "2026-07-10", "b".repeat(64), true],
        ["board_a", 1, "첫째", "작성자", null, "2026-07-09", firstHash, false],
      ],
    }],
    [collectionIndexKey, {
      schema_version: 1,
      collections: [{
        id: 1, board_id: "board_a", kind: "series", title: "테스트 연작",
        entries: [
          { position: 1, board_id: "board_a", external_post_id: 1, title: "첫째", object_key: firstKey },
        ],
      }],
    }],
    [firstKey, postPayload(1, "첫째")],
  ]);
  await page.route("**/archive/**", async (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

async function openPost(page, key) {
  await page.goto(stableUrl(key));
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#empty-reader")).toBeHidden();
  await expect(page.locator("#archive-body")).not.toBeEmpty();
}

test.beforeAll(async () => {
  await mkdir(".wrangler/screenshots", { recursive: true });
});

test("shows a row skeleton until the archive index is ready", async ({ page }) => {
  let releaseRequested;
  let releaseResponse;
  const requested = new Promise((resolve) => { releaseRequested = resolve; });
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
  await useCollectionFixture(page, {
    releaseGate: async () => {
      releaseRequested();
      await responseGate;
    },
  });
  await page.goto("/");
  await requested;
  await expect(page.locator("#result-list")).toHaveClass(/loading/);
  releaseResponse();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#result-list")).not.toHaveClass(/loading/);
});

test("keeps text reading, search, settings, and bookmarks inside the shared Reader", async ({ page }) => {
  let releaseResponse;
  const releaseGate = new Promise((resolve) => { releaseResponse = resolve; });
  await useCollectionFixture(page, { releaseGate: () => releaseGate });
  const releaseHash = "d".repeat(64);
  const catalogHash = "e".repeat(64);
  const detailHash = "c".repeat(64);
  const firstBodyHash = "a".repeat(64);
  const secondBodyHash = "b".repeat(64);
  const workId = "novel:fixture:1";
  const chapters = [
    { chapter_id: "1", label: "1화", kind: "main", source_site: "fixture", source_chapter_id: "1", sha256: firstBodyHash },
    { chapter_id: "2", label: "2화", kind: "main", source_site: "fixture", source_chapter_id: "2", sha256: secondBodyHash },
  ];
  await page.route("**/api/v1/text/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload;
    if (path.endsWith("/release/novel")) payload = { schema: 1, lane: "novel", sha256: releaseHash };
    else if (path.endsWith(`/release-manifest/novel/${releaseHash}.json`)) payload = {
      schema: 1, lane: "novel", generated_at: "2026-09-24", item_count: 1,
      catalog_pages: [{ key: `published/indexes/novel/${catalogHash}.json`, sha256: catalogHash }],
    };
    else if (path.endsWith(`/index/novel/${catalogHash}.json`)) payload = {
      schema: 1, lane: "novel", page: 0,
      items: [{ work_id: workId, legacy_work_ids: ["novel:fixture:legacy"], title: "통합 테스트 작품", author: "테스트 작가", chapter_count: 2, detail_key: `published/indexes/novel/${detailHash}.json` }],
    };
    else if (path.endsWith(`/index/novel/${detailHash}.json`)) payload = { schema: 1, lane: "novel", work: { work_id: workId }, chapters };
    else if (path.endsWith(`/object/${firstBodyHash}`)) return route.fulfill({ contentType: "text/markdown", body: `첫 회차 본문\n안전한 텍스트\n${"긴 본문\n".repeat(300)}` });
    else if (path.endsWith(`/object/${secondBodyHash}`)) return route.fulfill({ contentType: "text/markdown", body: "둘째 회차 본문" });
    else return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto("/");
  await page.locator('button[data-destination="browse"]:visible').first().click();
  await page.locator('#source-switch [data-source="novel"]').click();
  await expect(page).toHaveURL(/\/text(?:\?|$)/);
  await expect(page.locator("#source-switch")).toBeVisible();
  await expect(page.locator("#result-list .result-title").first()).toHaveText("통합 테스트 작품");
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#text-work-back")).toBeVisible();
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#reader")).toHaveAttribute("data-source", "text");
  await expect(page.locator("#archive-body")).toContainText("안전한 텍스트");
  await expect(page.locator("#archive-body p")).toHaveCount(0);
  await expect(page.locator("#comments")).toBeHidden();
  const mobileText = page.viewportSize().width < 760;
  await page.locator(mobileText ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  // A late TypeMoon boot must not reopen the independent text Reader.
  releaseResponse();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator(mobileText ? "#reader-top-bookmark" : "#bookmark-post").click();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#reader-pane").evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.locator("#end-list").click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("redstm.textState.v1")).history["novel:novel:fixture:1:1"]?.progress ?? 0)).toBeGreaterThan(0);
  // Saved text items live under 기록; the old 저장함 address still opens them.
  await page.goto("/text?lane=saved");
  await expect(page.locator("#result-list .result-title").first()).toHaveText("통합 테스트 작품");
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#archive-body")).toContainText("첫 회차 본문");
  // A saved chapter still knows its work's order.
  await expect(page.locator("#next-post")).toBeEnabled();
  await page.locator("#end-list").click();
  // 둘러보기 keeps the text source; TypeMoon is one tap away on the source switch.
  await page.locator('#source-switch [data-source="typemoon"]').click();
  await expect(page).toHaveURL(/\/browse(?:\?|$)/);
  await expect(page.locator("#reader")).toBeHidden();

  const oldIdentity = "novel:novel:fixture:legacy:1";
  await page.evaluate(({ oldIdentity, chapter }) => {
    localStorage.setItem("redstm.textState.v1", JSON.stringify({
      schema_version: 1,
      history: { [oldIdentity]: { readAt: "2026-09-20T00:00:00Z", progress: 0.4 } },
      bookmarks: { [oldIdentity]: {
        savedAt: "2026-09-20T00:00:00Z", lane: "novel", entry: chapter,
        work: { work_id: "novel:fixture:legacy", title: "통합 테스트 작품" }, title: "통합 테스트 작품",
      } },
    }));
  }, { oldIdentity, chapter: chapters[0] });
  await page.goto(`/text?lane=novel&work=${encodeURIComponent("novel:fixture:legacy")}&chapter=1`);
  await expect(page).toHaveURL(/work=novel%3Afixture%3A1/);
  await expect(page.locator("#archive-body")).toContainText("안전한 텍스트");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("redstm.textState.v1")).history["novel:novel:fixture:1:1"]?.progress)).toBe(0.4);
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("redstm.textState.v1"));
    return state.bookmarks["novel:novel:fixture:1:1"]?.work?.work_id;
  })).toBe(workId);
  expect(await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem("redstm.textState.v1"));
    return key in state.history || key in state.bookmarks;
  }, oldIdentity)).toBe(false);
});

test("opens the published text lane and keeps a late response out of TypeMoon browsing", async ({ page }) => {
  await useCollectionFixture(page);
  const releaseHash = "d".repeat(64);
  const catalogHash = "e".repeat(64);
  const nextReleaseHash = "f".repeat(64);
  const nextCatalogHash = "b".repeat(64);
  let publishedRelease = releaseHash;
  let releaseNovel;
  let novelRequested;
  const novelGate = new Promise((resolve) => { releaseNovel = resolve; });
  const requestStarted = new Promise((resolve) => { novelRequested = resolve; });
  await page.route("**/api/v1/text/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/release/novel")) {
      novelRequested();
      await novelGate;
      return route.fulfill({ status: 404 });
    }
    let payload;
    if (path.endsWith("/release/arcalive")) payload = { schema: 1, lane: "arcalive", sha256: publishedRelease };
    else if (path.endsWith(`/release-manifest/arcalive/${releaseHash}.json`) || path.endsWith(`/release-manifest/arcalive/${nextReleaseHash}.json`)) payload = {
      schema: 1, lane: "arcalive", catalog_pages: [{ key: `published/indexes/arcalive/${publishedRelease === releaseHash ? catalogHash : nextCatalogHash}.json`, sha256: publishedRelease === releaseHash ? catalogHash : nextCatalogHash }],
    };
    else if (path.endsWith(`/index/arcalive/${catalogHash}.json`) || path.endsWith(`/index/arcalive/${nextCatalogHash}.json`)) payload = {
      schema: 1, lane: "arcalive", items: [{ identity: "arcalive:0765:108:text", title: "대담한 합성 (Worm/The Gamer) 2부 파트 16", category: "WORM", board: "0765", post_id: 108, sha256: "a".repeat(64) }],
    };
    else if (path.endsWith(`/object/${"a".repeat(64)}`)) return route.fulfill({
      contentType: "text/markdown",
      body: "# 대담한 합성 (Worm/The Gamer) 2부 파트 16\n\n- channel: 0765\n- category: WORM\n- author: D4Cwest\n- created: 2026-09-22\n- id: 108\n- url: https://arca.live/b/0765/108\n\n---\n\n대담한 융합",
    });
    else return route.fulfill({ status: 404 });
    if (path.endsWith(`/index/arcalive/${nextCatalogHash}.json`)) payload.items.push({ identity: "arcalive:9999:109:text", title: "신규 글", category: "기타", board: "9999", post_id: 109, sha256: "a".repeat(64) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto("/");
  await page.locator('button[data-destination="browse"]:visible').first().click();
  await page.locator('#source-switch [data-source="novel"]').click();
  await requestStarted;
  await page.locator('#source-switch [data-source="typemoon"]').click();
  releaseNovel();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.locator("#result-list .result-title").first()).toHaveText("비소속");
  await expect(page.locator('#source-switch [data-source="typemoon"]')).toHaveAttribute("aria-pressed", "true");

  await page.locator('#source-switch [data-source="arcalive"]').click();
  await expect(page).toHaveURL(/\/text\?lane=arcalive$/);
  await expect(page.locator("#result-list .result-title").first()).toHaveText("0765");
  await page.locator('#source-switch [data-source="novel"]').click();
  await expect(page).toHaveURL(/\/text\?lane=novel$/);
  await expect(page.locator("#result-status")).toContainText("소설은 아직 게시되지 않았습니다");
  await expect(page.locator("#result-list .empty-row")).toContainText("아직 게시된 자료가 없습니다");
  publishedRelease = nextReleaseHash;
  await page.locator('#source-switch [data-source="arcalive"]').click();
  await expect(page.locator("#result-status")).toContainText("2개 게시판");
  await expect(page.locator("#result-list .result-title").first()).toHaveText("0765");
  await page.locator("#result-list .result-item").first().click();
  await expect(page).toHaveURL(/board=0765/);
  await expect(page.locator("#result-list .result-title").first()).toHaveText("WORM");
  await page.locator("#result-list .result-item").first().click();
  await expect(page).toHaveURL(/category=WORM/);
  await expect(page.locator("#result-list .result-title").first()).toHaveText("대담한 합성 (Worm/The Gamer) 2부 파트 16");
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#reader-title")).toHaveText("대담한 합성 (Worm/The Gamer) 2부 파트 16");
  await expect(page.locator("#archive-body")).toHaveText("대담한 융합");
  await expect(page.locator("#more-source")).toHaveAttribute("href", "https://arca.live/b/0765/108");
});

test("arcalive follows board/category/files even when titles look like a series", async ({ page }) => {
  await useCollectionFixture(page);
  const releaseHash = "a".repeat(64);
  const indexHash = "b".repeat(64);
  const worksHash = "d".repeat(64);
  const detailHash = "e".repeat(64);
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload;
    if (path.endsWith("/release/arcalive")) payload = { schema: 1, lane: "arcalive", sha256: releaseHash };
    else if (path.endsWith(`/release-manifest/arcalive/${releaseHash}.json`)) payload = {
      schema: 1, lane: "arcalive", catalog_pages: [{ key: `published/indexes/arcalive/${indexHash}.json`, sha256: indexHash }],
      work_catalog_pages: [{ key: `published/indexes/arcalive/${worksHash}.json`, sha256: worksHash }],
    };
    else if (path.endsWith(`/index/arcalive/${worksHash}.json`)) payload = {
      schema: 1, lane: "arcalive", view: "works", items: [{
        work_id: "arcalive:series", title: "해리포터와 뛰어노는 조랑말들", author: "작가",
        board: "0765", category: "agr", chapter_count: 2,
        detail_key: `published/indexes/arcalive/${detailHash}.json`,
      }],
    };
    else if (path.endsWith(`/index/arcalive/${detailHash}.json`)) payload = {
      schema: 1, lane: "arcalive", work: { work_id: "arcalive:series", title: "해리포터와 뛰어노는 조랑말들", author: "작가" },
      chapters: [1, 2].map((number) => ({
        identity: `arcalive:0765:${number}:text`, title: `해리포터와 뛰어노는 조랑말들 ${number}화`,
        label: `해리포터와 뛰어노는 조랑말들 ${number}화`, category: "agr", board: "0765", post_id: number,
        sha256: "c".repeat(64), reading_order: number - 1,
      })),
    };
    else if (path.endsWith(`/index/arcalive/${indexHash}.json`)) payload = {
      schema: 1, lane: "arcalive", items: [1, 2].map((number) => ({
        identity: `arcalive:0765:${number}:text`, title: `해리포터와 뛰어노는 조랑말들 ${number}화`,
        category: "agr", board: "0765", post_id: number, sha256: "c".repeat(64),
      })),
    };
    else if (path.endsWith(`/object/${"c".repeat(64)}`)) return route.fulfill({
      contentType: "text/markdown",
      body: "# 해리포터와 뛰어노는 조랑말들 1화\n\n- url: https://arca.live/b/0765/1\n\n---\n\n본문",
    });
    else return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/text?lane=arcalive");
  await expect(page.locator("#result-list .result-title").first()).toHaveText("0765");
  await page.locator("#result-list .result-item").first().click();
  await expect(page.locator("#result-list .result-title").first()).toHaveText("agr");
  await page.locator("#result-list .result-item").first().click();
  // Posts in a category list newest first, like a board.
  await expect(page.locator("#result-list .result-title")).toHaveText([
    "해리포터와 뛰어노는 조랑말들 2화", "해리포터와 뛰어노는 조랑말들 1화",
  ]);
  await page.locator('[data-arcalive-view="works"]').click();
  await expect(page).toHaveURL(/view=works/);
  await expect(page.locator("#result-list .result-title")).toHaveText("해리포터와 뛰어노는 조랑말들");
  await page.locator("#result-list .result-item").first().click();
  await expect(page).toHaveURL(/work=arcalive%3Aseries/);
  await expect(page.locator("#result-list .result-item:not([data-continue]) .result-title")).toHaveText([
    "해리포터와 뛰어노는 조랑말들 1화", "해리포터와 뛰어노는 조랑말들 2화",
  ]);
  await page.locator("#result-list .result-item:not([data-continue])").first().click();
  await expect(page.locator("#reader-title")).toHaveText("해리포터와 뛰어노는 조랑말들 1화");
  await expect(page.locator("#reader-bottom-next")).toBeEnabled();
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("해리포터와 뛰어노는 조랑말들 1화");
});

test("pages a large board with load-more instead of stopping at the first page", async ({ page }) => {
  await usePaginationFixture(page, 150);
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");

  const items = page.locator(".result-item");
  await expect(items).toHaveCount(100);
  const more = page.locator("#result-more");
  await expect(more).toBeVisible();
  await expect(more).toContainText("남은 50");

  await more.click();

  await expect(items).toHaveCount(150);
  await expect(more).toBeHidden();
  // The already-loaded first page is kept and the next page is appended after it.
  await expect(items.first().locator(".result-title")).toHaveText("글 150");
  await expect(items.last().locator(".result-title")).toHaveText("글 1");
});

test("keeps the settings route symmetric", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  await expect(page.locator("#settings-ops")).toBeVisible();
  await expect(page.locator("#settings-ops")).toHaveAttribute("href", "/ops");
  await page.locator("#settings-dialog form").evaluate((form) => { form.scrollTop = form.scrollHeight; });
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await expect.poll(() => page.locator("#settings-dialog form").evaluate((form) => form.scrollTop)).toBe(0);
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
});

test("keeps primary navigation and Operations reachable at every breakpoint", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const width = page.viewportSize().width;
  const navigation = width >= 1200 ? ".rail-primary" : width >= 760 ? ".app-nav" : ".bottom-nav";
  for (const destination of ["library", "browse", "search", "bookmarks"]) {
    await expect(page.locator(`${navigation} [data-destination="${destination}"]`)).toBeVisible();
  }
  // Four destinations; the text library is a 둘러보기 source, not a fifth tab.
  await expect(page.locator(`${navigation} [data-destination]`)).toHaveCount(4);
  await page.locator(`${navigation} [data-destination="browse"]`).click();
  await page.locator('#source-switch [data-source="novel"]').click();
  await expect(page).toHaveURL(/\/text\?lane=novel$/);
  await expect(page.locator(`${navigation} [data-destination="browse"]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`${navigation} [data-destination="library"]`).click();
  await page.locator(`${navigation} [data-destination="browse"]`).click();
  await expect(page).toHaveURL(/\/text\?lane=novel$/);
  await page.locator('#source-switch [data-source="typemoon"]').click();
  const settings = page.locator(width >= 1200 ? ".rail-secondary [data-destination='settings']" : ".app-settings");
  await expect(settings).toBeVisible();
  await expect(page.locator(width >= 1200 ? ".wordmark" : ".app-home")).toBeVisible();
  // Phones leave Operations out of the app bar (a reader's screen); it stays in 설정 › 운영 현황.
  if (width >= 760) {
    const operations = page.locator(`${width >= 1200 ? ".rail" : ".app-bar"} a[href="/ops"]`);
    await expect(operations).toBeVisible();
    await expect(operations).toHaveAccessibleName(/운영/);
    if (width < 1200) await expect(operations).toContainText("운영");
  } else {
    await expect(page.locator('.app-bar a[href="/ops"]')).toBeHidden();
    await expect(page.locator('#settings-ops[href="/ops"]')).toHaveCount(1);
  }

  await page.locator(`${navigation} [data-destination="browse"]`).click();
  await expect(page).toHaveURL(/\/browse$/);
  await page.locator(`${navigation} [data-destination="search"]`).click();
  await expect(page).toHaveURL(/\/search$/);
  await page.locator(`${navigation} [data-destination="bookmarks"]`).click();
  await expect(page).toHaveURL(/\/saved$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
  await settings.click();
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search$/);
});

test("separates board browsing from keyword search", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/browse?board=board_a");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#catalog-title")).toHaveText("게시판 둘러보기");
  await expect(page.locator("#search-input")).toBeHidden();
  await expect(page.locator("#search-target")).toBeHidden();
  await expect(page.locator("#search-match")).toBeHidden();
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator(".result-item")).toHaveCount(3);
  await expect(page.locator(".result-board")).toHaveText(["자유게시판", "자유게시판", "자유게시판"]);
  await expect(page.locator("#result-status")).toContainText("자유게시판");
  // The board is shown by its own picker, not as a generic filter chip.
  await expect(page.locator("#board-dock-name")).toHaveText("자유게시판");
  await expect(page.locator("#active-filters")).toBeHidden();
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-browse.png` });

  await page.locator('[data-scope="collections"]').click();
  await expect(page).toHaveURL(/\/browse\?scope=collections/);
  await expect(page.locator("#catalog-title")).toHaveText("작품 둘러보기");
  await expect(page.locator("#search-input")).toBeHidden();
  await expect(page.locator("#sort-filter")).toHaveValue("updated");

  await page.locator('[data-destination="search"]:visible').first().click();
  await expect(page).toHaveURL(/\/search\?board=board_a$/);
  await expect(page.locator("#catalog-title")).toHaveText("글 검색");
  await expect(page.locator("#search-input")).toBeVisible();
  await expect(page.locator("#search-input")).toBeFocused();
});

test("browse keeps format chips unique and lists only matching boards", async ({ page }) => {
  await useBoardFilterFixture(page);
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".mode-field")).toBeHidden();
  await expect(page.locator("#mode-chips")).toBeVisible();
  await expect.poll(() => boardFilterLabels(page)).toEqual([
    "전체 게시판", "19금 AA", "자유게시판", "창작집담",
  ]);
  await expect(page.locator("#board-filter optgroup").first()).toHaveAttribute("label", "AA");

  await page.locator('#mode-chips [data-mode="aa"]').click();
  await expect.poll(() => boardFilterLabels(page)).toEqual(["전체 게시판", "19금 AA"]);
  await expect(page).toHaveURL(/mode=aa/);
  await expect(page.locator(".result-item .result-title")).toHaveText(["AA 글"]);

  await page.locator('#mode-chips [data-mode="prose"]').click();
  await expect.poll(() => boardFilterLabels(page)).toEqual(["전체 게시판", "자유게시판", "창작집담"]);
  await expect(page.locator("#board-filter option", { hasText: "19금 AA" })).toHaveCount(0);

  await page.locator('#mode-chips [data-mode="aa"]').click();
  await setSelect(page, "board-filter", "aa_19");
  await page.locator('[data-scope="collections"]').click();
  await expect(page).toHaveURL(/scope=collections/);
  await expect(page.locator(".collection-kind-field")).toBeHidden();
  await expect(page.locator("#kind-chips")).toBeVisible();
  await expect.poll(() => boardFilterLabels(page)).toEqual(["전체 게시판", "자유게시판"]);
  await expect(page.locator("#board-filter")).toHaveValue("");
  await expect(page.locator("#sort-filter")).toHaveValue("updated");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toBeVisible();
});

test("drops browse board and mode when opening the library", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/browse?board=board_a&mode=aa");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await page.locator('[data-destination="bookmarks"]:visible').first().click();
  await expect(page).toHaveURL(/\/saved$/);
  await expect(page).not.toHaveURL(/board=/);
  await expect(page.locator("#board-filter")).toHaveValue("");
  await expect(page.locator("#mode-filter")).toHaveValue("all");
  await page.goBack();
  await expect(page).toHaveURL(/board=board_a/);
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator("#mode-filter")).toHaveValue("aa");
});

test("keeps search format inside filters instead of duplicate chips", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search?q=첫째&mode=aa&board=board_a");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#mode-chips")).toBeHidden();
  await expect(page.locator("#active-filters")).toContainText("AA");
  await expect(page.locator("#active-filters")).not.toContainText("자유게시판");
  await expect(page.locator("#board-dock-name")).toHaveText("자유게시판");
  await expect(page.locator("#mode-filter")).toHaveValue("aa");
  await expect(page.locator("#result-status")).toContainText("자유게시판");
  await expect(page.locator("#result-status")).toContainText("AA");
});

test("restores search controls from the URL and browser history", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search?q=둘째&board=board_a&mode=prose&sort=oldest");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#search-input")).toHaveValue("둘째");
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator("#mode-filter")).toHaveValue("prose");
  await expect(page.locator("#sort-filter")).toHaveValue("oldest");
  await expect(page.locator(".result-item", { hasText: "둘째" })).toBeVisible();

  await setSelect(page, "sort-filter", "latest");
  await setSelect(page, "mode-filter", "aa");
  await page.locator("#search-input").fill("첫째");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("첫째");
  await expect.poll(() => page.evaluate(() => history.state?.redstmSearch)).toEqual({
    query: "첫째", boardId: "board_a", category: "", mode: "aa", sort: "latest",
    target: "all", match: "and", collectionKind: "all", collectionRead: "all",
  });
  await page.locator(".result-item", { hasText: "첫째" }).click();
  await expect(page).toHaveURL(/\/read\//);
  await page.goBack();
  await expect(page.locator("#search-input")).toHaveValue("첫째");
  await expect(page.locator("#board-filter")).toHaveValue("board_a");
  await expect(page.locator("#mode-filter")).toHaveValue("aa");
  await expect(page.locator("#sort-filter")).toHaveValue("latest");
});

test("restores catalog scroll and focused row after Reader Back", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const list = page.locator("#result-list");
  await list.evaluate((element) => {
    element.style.height = "100px";
    element.style.maxHeight = "100px";
  });
  const target = page.locator(".result-item").last();
  await target.focus();
  const expectedScroll = await list.evaluate((element) => element.scrollTop);
  expect(expectedScroll).toBeGreaterThan(0);
  const title = await target.locator(".result-title").innerText();
  await target.click();
  await expect(page.locator("#reader")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/browse$/);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(expectedScroll);
  await expect(page.locator(".result-item:focus .result-title")).toHaveText(title);
});

test("loads more board posts from the local search index", async ({ page }) => {
  await useCollectionFixture(page, { paginated: true });
  await page.goto("/browse?board=board_a");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item")).toHaveCount(100);
  await expect(page.locator("#result-status")).toContainText("103건 중 100건");
  await expect(page.locator("#result-more")).toContainText("3건");

  await page.locator("#result-more").click();
  await expect(page.locator(".result-item")).toHaveCount(103);
  await expect(page.locator(".result-item").last()).toContainText("과거 103");
  await expect(page.locator("#result-more")).toBeHidden();

  await page.locator(".result-item").last().click();
  await expect(page.locator("#reader-title")).toHaveText("과거 103");
  await page.goBack();
  await expect(page.locator(".result-item")).toHaveCount(103);
  await expect(page.locator(".result-item").last()).toBeFocused();
});

test("normalizes AA mode on a legacy search index", async ({ page }) => {
  await useCollectionFixture(page, { legacyIndex: true });
  await page.goto("/browse?mode=aa");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#mode-filter")).toBeDisabled();
  await expect(page.locator("#mode-filter")).toHaveValue("all");
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.locator(".result-item")).toHaveCount(3);
});

test("reviews a state import before applying it", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('button[data-destination="settings"]:visible').first().click();
  await page.locator('[data-theme-choice="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const state = {
    schema_version: 2,
    settings: { theme: "dark", aaSize: 99 },
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z" } },
    bookmarks: {}, scroll: { "board_a:1": 120 }, viewModes: {}, lastCatalogState: null,
  };
  await page.locator("#import-state-file").setInputFiles({
    name: "redstm-state.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(state)),
  });
  await expect(page.locator("#import-review")).toBeVisible();
  await expect(page.locator("#import-review-summary")).toContainText("읽기 1");
  await expect(page.locator("#import-review-summary")).toContainText("기본값 보정");
  await expect(page.locator("#import-review-summary")).toContainText("AA 크기");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-import-review.png` });
  await page.locator("#import-apply").click();
  await expect(page.locator("#import-review")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#import-review-summary")).toHaveText("사용자 상태를 가져왔습니다");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#import-cancel").click();
  await expect(page.locator("#import-review")).toBeHidden();
});

test("keeps saved and recent-reading routes distinct", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/saved");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".saved-tabs")).toBeVisible();
  await expect(page.locator('[data-view="bookmarks"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sort-field")).toBeHidden();
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-saved.png` });

  await page.locator('[data-view="history"]').click();
  await expect(page).toHaveURL(/\/saved\?view=recent$/);
  await page.reload();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator('[data-view="history"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#catalog-subtitle")).toHaveText("최근 읽음");

  await page.locator('[data-view="bookmarks"]').click();
  await expect(page).toHaveURL(/\/saved$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/saved\?view=recent$/);
  await expect(page.locator('[data-view="history"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-view="reading"]').click();
  await expect(page).toHaveURL(/\/saved\?view=reading$/);
});

test("shows the archive cover and uses a single-plane mobile reader", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#home-search")).toBeVisible();
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'),
  ).toHaveAttribute("content", "#F7F6F3");
  await expect(
    page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
  ).toHaveAttribute("content", "#121413");

  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.rail a[href="/ops"]')).toBeVisible();
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator("#empty-reader")).toContainText("내 장서");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover.png" });
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const themeColors = page.locator('meta[name="theme-color"]');
    await expect(themeColors).toHaveCount(2);
    await expect(themeColors.first()).toHaveAttribute("content", "#121413");
    await expect(themeColors.nth(1)).toHaveAttribute("content", "#121413");
    await page.screenshot({ path: ".wrangler/screenshots/desktop-cover-night.png" });
  } else {
    // Phones leave Operations out of the app bar; wider screens keep it there.
    const appBarOps = page.locator('.app-bar a[href="/ops"]');
    if (page.viewportSize().width < 760) await expect(appBarOps).toBeHidden();
    else await expect(appBarOps).toBeVisible();
  }
  await expect(page.locator('.home-operations[href="/ops"]')).toBeVisible();

  if (page.viewportSize().width < 760) {
    await expect(page.locator("#empty-reader")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-home.png` });
  }
  await page.locator("#home-search").click();
  await expect(page.locator("#search-input")).toBeFocused();
  await expect(page.locator("#search-empty")).toBeVisible();
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-explore.png` });
  await page.locator('[data-destination="browse"]:visible').first().click();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page).toHaveURL(/\/read\/board_a\/3$/);
  await expect(page).toHaveTitle(/비소속/);
  await expect(page.locator("#reader-title")).toBeFocused();
  if (testInfo.project.name === "medium") {
    await expect(page.locator("body")).toHaveClass(/catalog-collapsed/);
    await expect(page.locator(".catalog")).toBeHidden();
    await page.locator("#catalog-toggle").click();
    await expect(page.locator(".catalog")).toBeVisible();
  }
  if (page.viewportSize().width >= 760) {
    await page.locator('button[data-destination="settings"]:visible').first().click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.locator("#settings-dialog button[aria-label='닫기']").click();
    await expect(page).toHaveURL(/\/read\/board_a\/3$/);
    await expect(page).toHaveTitle(/비소속/);
  }
  if (page.viewportSize().width <= 760) {
    await expect(page.locator(".catalog")).toBeHidden();
    await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-reader.png` });
    await page.locator("#catalog-back").click();
    await expect(page.locator(".catalog")).toBeVisible();
    await expect(page.locator(".result-item:focus")).toBeVisible();
  }
});

// T30/T31 (docs/24 §8.16): a pinch scales the picture while the fingers move and settles on a
// continuous zoom within 10–300%; a tap toggles the tools at once and a quick second tap undoes
// that and switches between 맞춤 and 100%.
test("AA pinch settles on a continuous zoom and a double tap switches 맞춤 and 100%", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, aaKey);
  test.skip(!(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)), "touch gestures need a touch screen");
  const output = page.locator("#aa-zoom-output");
  await expect(output).toHaveText("100%");
  const body = page.locator("#archive-body");
  const pinch = async (from, to, { release = true } = {}) => body.evaluate((element, [start, end, finish]) => {
    const box = element.getBoundingClientRect();
    const touches = (gap) => [0, 1].map((identifier) => new Touch({
      identifier, target: element, clientX: box.left + 150 + (identifier ? gap / 2 : -gap / 2), clientY: box.top + 80,
    }));
    const send = (type, list, changed = list) => element.dispatchEvent(new TouchEvent(type, {
      touches: list, targetTouches: list, changedTouches: changed, bubbles: true, cancelable: true,
    }));
    send("touchstart", touches(start));
    send("touchmove", touches((start + end) / 2));
    send("touchmove", touches(end));
    if (finish) send("touchend", [], touches(end));
  }, [from, to, release]);
  // While the fingers move only a transform changes; the zoom itself waits for the release.
  await pinch(200, 174.6, { release: false });
  await expect(page.locator(".aa-canvas")).toHaveAttribute("style", /scale\(0\.87/);
  await expect(output).toHaveText("100%");
  await body.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const touches = [0, 1].map((identifier) => new Touch({ identifier, target: element, clientX: box.left + 150 + (identifier ? 87.3 : -87.3), clientY: box.top + 80 }));
    element.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: touches, bubbles: true }));
  });
  await expect(output).toHaveText("87%");
  await expect(page.locator(".aa-canvas")).not.toHaveAttribute("style", /scale/);
  const saved = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("redstm.userState.v2")).aaViews)[0]);
  await expect.poll(async () => (await saved())?.zoom).toBe(0.873);
  await pinch(100, 1000);
  await expect(output).toHaveText("300%");
  await pinch(1000, 10);
  await expect(output).toHaveText("10%");
  // Tap: the tools toggle at once; a second tap within 300ms undoes that and fits the picture.
  const hidden = () => page.evaluate(() => document.body.classList.contains("reader-controls-hidden"));
  const tap = async () => {
    const box = await body.boundingBox();
    const point = { isPrimary: true, pointerType: "touch", clientX: box.x + 40, clientY: box.y + 60 };
    await body.dispatchEvent("pointerdown", point);
    await body.dispatchEvent("pointerup", point);
  };
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  const before = await hidden();
  await tap();
  expect(await hidden()).toBe(!before);
  await tap();
  expect(await hidden()).toBe(before);
  await expect.poll(async () => (await saved())?.fit).toBe(true);
  // From 맞춤 a double tap goes to a manual 100%.
  await page.waitForTimeout(350);
  await tap();
  await tap();
  await expect(output).toHaveText("100%");
  await expect.poll(async () => (await saved())?.fit).toBeUndefined();
});

// T05 (docs/24 §8.17) and the minimap (DESIGN §8.4): the AA host goes full screen with its tools,
// takes zoom changes and messages inside it, and leaving — by the button or by Back/Esc, which
// arrive as fullscreenchange — brings back the zoom and sideways place from before.
test("AA full screen keeps its tools inside and returns to the same view; the minimap moves a wide picture", async ({ page }) => {
  await useCollectionFixture(page);
  await page.route(`**/archive/${aaKey}`, (route) => {
    const payload = aaPostPayload(1, "첫째");
    payload.post.body_html = `<div class="AA_Text"><p>${"＿".repeat(240)}</p><p>（　´∀｀）</p></div>`;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await openPost(page, aaKey);
  // The picture scrolls sideways with the reader pane (one scroller for both directions).
  const body = page.locator("#reader-pane");
  const map = page.locator("#aa-minimap");
  await expect(map).toBeVisible();
  const windowLeft = () => map.evaluate((element) => Number.parseFloat(element.style.getPropertyValue("--window-left")));
  expect(await windowLeft()).toBe(0);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(windowLeft).toBeGreaterThan(40);
  await map.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const left = await body.evaluate((element) => element.scrollLeft);

  const button = page.locator("#aa-fullscreen");
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe("aa-host");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#aa-controls")).toBeVisible();
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  // The zoom message is in the top layer, over the full-screen host.
  await expect(page.locator("#aa-zoom-indicator")).toBeVisible();
  // Back/Esc leave full screen outside the page; only fullscreenchange tells it.
  await page.evaluate(() => document.exitFullscreen());
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#aa-zoom-output")).toHaveText("100%");
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBe(left);
  // The button leaves too.
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await button.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test("keeps the DSOTM AA settings contract", async ({ page }, testInfo) => {
  await useCollectionFixture(page);
  await openPost(page, firstKey);
  await expect(page.locator("#aa-controls")).toBeVisible();
  await expect(page.locator("#comment-count")).toHaveText("2");
  await expect(page.locator(".comment")).toHaveCount(2);
  await expect(page.locator(".comment-body.aa-comment")).toHaveCount(1);
  await expect(page.locator(".comment-body").first()).not.toHaveClass(/aa-comment/);
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("white-space", "pre");
  await expect(page.locator(".aa-canvas p").first()).toHaveCSS("margin-bottom", "0px");
  await expect(page.locator(".aa-canvas p").first()).toHaveCSS("line-height", "18px");
  await expect(page.locator("#reader-kicker")).toContainText("자유게시판");
  const mobile = page.viewportSize().width < 760;
  await page.locator(mobile ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await expect(page.locator('[data-aa-background="#f5f5f0"]')).toHaveText("아이보리");
  await expect(page.locator('[data-aa-background="#ffffff"]')).toHaveText("흰색");
  await expect(page.locator(".aa-color-picker")).toContainText("직접");
  expect(await page.locator(".aa-appearance").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.locator("#aa-background")).toHaveValue("#f5f5f0");
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(245, 245, 240)");
  await page.locator('[data-aa-preset="11:800"]').click();
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-size-output")).toHaveText("11px");
  await expect(page.locator("#archive-body font")).toHaveCSS("font-size", "11px");
  await expect(page.locator("#archive-body font")).toHaveCSS("font-weight", "700");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("font-size", "11px");
  await page.locator('[data-aa-background="#ffffff"]').click();
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#aa-source-styles").click();
  await expect(page.locator("#archive-body")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator(".comment-body.aa-comment")).toHaveClass(/normalize-source-styles/);
  await expect(page.locator("#archive-body font")).not.toHaveCSS("color", "rgb(180, 35, 47)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(36, 37, 42)");
  await page.locator("#aa-background").evaluate((input) => {
    input.value = "#0b0d12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(123, 224, 162)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("color", "rgb(123, 224, 162)");
  await page.locator("#aa-background").evaluate((input) => {
    input.value = "#808080";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".aa-color-picker")).toHaveClass(/active/);
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(page.locator(".comment-body.aa-comment")).toHaveCSS("color", "rgb(0, 0, 0)");
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator('[data-aa-zoom-delta="0.25"]').click();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await page.reload();
  await expect(page.locator("#aa-zoom-output")).toHaveText("125%");
  await expect(page.locator(".aa-canvas")).toHaveAttribute("data-width", "800");
  await expect(page.locator("#aa-background")).toHaveValue("#808080");
  await expect(page.locator("#archive-body")).toHaveCSS("background-color", "rgb(128, 128, 128)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(0, 0, 0)");
  if (mobile) await page.locator("#reader-bottom-more").click();
  await page.locator(mobile ? "#more-mode" : "#mode-toggle").click();
  if (mobile) await page.locator("#reader-bottom-more").click();
  await expect(page.locator(mobile ? "#more-mode-reset" : "#mode-reset")).toBeVisible();
  if (mobile) await page.locator("#reader-more button[aria-label='닫기']").click();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(false);
  await expect(page.locator("#aa-controls")).toBeHidden();
  await page.reload();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(false);
  if (mobile) await page.locator("#reader-bottom-more").click();
  await page.locator(mobile ? "#more-mode-reset" : "#mode-reset").click();
  await expect(page.locator("#reader-more")).toBeHidden();
  expect(await page.locator("#archive-body").evaluate((element) => element.classList.contains("aa"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa-fixture.png` });
});

// T06 (docs/24 §8.16): every prose setting and the app theme leave an AA picture as it was —
// the same DOM, the same computed grid and colours, and the same pixels.
test("prose settings and theme never change an AA picture", async ({ page }) => {
  await useCollectionFixture(page);
  const properties = [
    "font-family", "font-size", "line-height", "white-space", "overflow-wrap", "text-align", "letter-spacing", "word-spacing",
    "text-indent", "font-weight", "font-style", "text-transform", "font-feature-settings", "font-variant-numeric", "hyphens",
    "text-wrap-mode", "text-wrap-style", "color", "background-color", "margin", "padding", "width",
  ];
  const snapshot = async () => {
    await openPost(page, aaKey);
    await page.evaluate(() => document.fonts.ready);
    const styles = await page.evaluate((names) => {
      const root = document.getElementById("archive-body");
      return [root, ...root.querySelectorAll(".aa-canvas, .aa-canvas *")].map((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
      });
    }, properties);
    const html = await page.locator("#archive-body").innerHTML();
    const pixels = await page.locator(".aa-canvas").screenshot({ animations: "disabled", caret: "hide" });
    return { styles, html, pixels };
  };
  const before = await snapshot();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("redstm.userState.v2"));
    Object.assign(state.settings, {
      theme: "dark", proseAlign: "justify", proseFont: "sans", proseSize: 24, lineHeight: 2.2,
      paragraphSpacing: 2, textIndent: 2, readerSurface: "ink",
    });
    localStorage.setItem("redstm.userState.v2", JSON.stringify(state));
  });
  const after = await snapshot();
  expect(after.html).toBe(before.html);
  expect(after.styles).toEqual(before.styles);
  expect(after.pixels.equals(before.pixels)).toBe(true);
});

// T29 (docs/24 §8.7 D14): comments stay one DOM below the body, folded until asked for; the
// chapter-end shortcut unfolds them in place and 본문으로 returns to the reading place.
test("comments sit open under the text, fold from their heading, and 본문으로 returns to the text", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, firstKey);
  const list = page.locator("#comment-list");
  const toggle = page.locator("#comments-toggle");
  // Text → comments → next/previous: comments start unfolded and the chapter end has no shortcut.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("댓글 2");
  await expect(page.locator(".comment")).toHaveCount(2);
  await expect(page.locator("#end-comments")).toBeHidden();
  // One DOM: nothing was copied into a sheet, so no id appears twice.
  expect(await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    return ids.length - new Set(ids).size;
  })).toBe(0);
  // The heading folds them; browser find (beforematch) unfolds and the heading follows.
  await toggle.click();
  await expect(list).toBeHidden();
  await expect(list).toHaveAttribute("hidden", "until-found");
  await list.evaluate((element) => {
    element.removeAttribute("hidden");
    element.dispatchEvent(new Event("beforematch"));
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("applies and persists prose typography over legacy source styles", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, proseKey);
  await expect(page.locator("#aa-controls")).toBeHidden();
  await page.locator(page.viewportSize().width < 760 ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator('[data-theme-choice="light"]').click();
  await expect(page.locator('[data-theme-choice="light"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(253, 252, 250)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(28, 27, 25)");
  await page.locator('[data-theme-choice="dark"]').click();
  await expect(page.locator("#reader")).toHaveCSS("background-color", "rgb(22, 25, 24)");
  await expect(page.locator("#archive-body")).toHaveCSS("color", "rgb(227, 230, 226)");
  await page.locator('[data-theme-choice="light"]').click();
  await page.locator("#prose-size").evaluate((input) => {
    input.value = "22";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#line-height").evaluate((input) => {
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#prose-font").selectOption("sans");

  const legacyProse = page.locator(".legacy-prose");
  await expect(legacyProse).toHaveCSS("font-size", "22px");
  await expect(legacyProse).toHaveCSS("line-height", "44px");
  await expect(legacyProse).toHaveCSS("font-style", "italic");
  expect(await legacyProse.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Pretendard");

  await page.reload();
  await expect(legacyProse).toHaveCSS("font-size", "22px");
  await expect(legacyProse).toHaveCSS("line-height", "44px");
  expect(await legacyProse.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Pretendard");
});

// P6-7: 고운바탕 is linked only after it is picked, then loads for the body and survives a reload.
test("Gowun Batang is fetched only when chosen as the body font", async ({ page }) => {
  const fetched = [];
  page.on("request", (request) => { if (request.url().includes("/fonts/gowun-batang@")) fetched.push(request.url()); });
  await useCollectionFixture(page);
  await openPost(page, proseKey);
  await page.locator(page.viewportSize().width < 760 ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await expect(page.locator("#prose-font option")).toHaveText(["마루부리", "고운바탕", "프리텐다드"]);
  await expect(page.locator("#gowun-batang-css")).toHaveCount(0);
  expect(fetched).toEqual([]);

  await page.locator("#prose-font").selectOption("gowun");
  await expect(page.locator("#gowun-batang-css")).toHaveCount(1);
  const body = page.locator("#archive-body");
  await expect.poll(() => body.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/^"Gowun Batang"/);
  // Only the unicode-range pieces the page uses are downloaded.
  await expect.poll(() => page.evaluate(() => [...document.fonts].some((face) => face.family.replaceAll('"', "") === "Gowun Batang" && face.status === "loaded"))).toBe(true);
  expect(fetched.some((url) => url.endsWith(".woff2"))).toBe(true);
  await expect(page.locator("#font-preview")).toHaveCSS("font-family", /^"Gowun Batang"/);

  await page.reload();
  await expect(page.locator("#gowun-batang-css")).toHaveCount(1);
  await expect(body).toHaveCSS("font-family", /^"Gowun Batang"/);
  await page.evaluate(() => document.querySelector("#prose-font").scrollIntoView());
  await page.locator(page.viewportSize().width < 760 ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await page.locator("#prose-font").selectOption("serif");
  await expect(body).toHaveCSS("font-family", /^MaruBuri/);
});

// T25: the split MaruBuri 1.000 faces must lay out exactly like the single file readers had, so
// saved lines and positions do not move when the new font CSS is linked.
test("the versioned MaruBuri faces keep the previous body font's advances", async ({ page }) => {
  // The single file readers had is no longer served (P7-2); compare against its kept original.
  await page.route("**/previous-maruburi.woff2", (route) => route.fulfill({ path: "font-sources/MaruBuri-Regular.woff2", contentType: "font/woff2" }));
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const sample = "창밖으로 눈이 내리고 있었다. 그녀는 오래된 책을 덮고 천천히 고개를 들었다. \"약속은 지키는 쪽이 먼저 잊지 않는 법이야.\" 늦었네, 알겠어. 미안해 — 2026년 9월 30일, 119화 · 겨울 정원의 약속! 뜌쉪펲 ABCxyz?";
  const widths = await page.evaluate(async (text) => {
    const previous = new FontFace("PreviousMaruBuri", "url(/previous-maruburi.woff2)");
    document.fonts.add(await previous.load());
    await document.fonts.load("18px MaruBuri", text);
    const context = document.createElement("canvas").getContext("2d");
    const measure = (family) => [...text].map((character) => {
      context.font = `18px ${family}`;
      return context.measureText(character).width;
    });
    const loaded = [...document.fonts].some((face) => face.family === "MaruBuri" && face.status === "loaded");
    return { loaded, previous: measure("PreviousMaruBuri"), current: measure("MaruBuri") };
  }, sample);
  expect(widths.loaded).toBe(true);
  expect(widths.current).toEqual(widths.previous);
});

test("shows progress while receiving a large post", async ({ page }) => {
  await useCollectionFixture(page, { largeStandalone: true });
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.evaluate(() => {
    window.__redstmArchiveStates = [];
    const target = document.getElementById("archive-state");
    new MutationObserver(() => window.__redstmArchiveStates.push(target.textContent)).observe(target, { childList: true });
  });
  await page.locator('[data-destination="browse"]:visible').first().click();
  await expect(page.locator(".result-item").first()).toBeVisible();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const states = await page.evaluate(() => window.__redstmArchiveStates);
  expect(states.some((state) => /^본문 \d+%$/.test(state))).toBe(true);
});

test("reading chrome still folds away when the device asks for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  for (let step = 0; step < 4; step += 1) {
    await page.locator("#reader-pane").evaluate(async (element) => {
      element.scrollTop += 60;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }
  await expect(page.locator("body")).toHaveClass(/reader-controls-hidden/);
  const bar = page.locator(page.viewportSize().width < 760 ? ".reader-bottom" : ".reader-toolbar");
  await expect(bar).toHaveCSS("transition-duration", /^0s|1e-05s$/);
});

test("supports progress, immersive mode, and reader shortcuts", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-pane").evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    element.scrollTop = Math.max(130, Math.floor(element.scrollHeight / 4));
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(async () => {
    const width = await page.locator("#reading-progress").evaluate((element) => element.style.width);
    return Number.parseFloat(width);
  }).toBeGreaterThan(0);
  // Reading chrome folds away on every width (docs/19 §4.3).
  {
    const body = page.locator("body");
    const scrollBy = (delta) => page.locator("#reader-pane").evaluate(async (element, amount) => {
      element.scrollTop += amount;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, delta);
    const tap = async (pointerType = "touch") => {
      await page.locator("#archive-body").dispatchEvent("pointerdown", { isPrimary: true, pointerType, clientX: 120, clientY: 400 });
      await page.locator("#archive-body").dispatchEvent("pointerup", { isPrimary: true, pointerType, clientX: 122, clientY: 401 });
    };
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await expect(page.locator("#reader-status")).toHaveText(/^\d+%$/);
    // Wider screens show the badge in the margin; a phone keeps nothing over the text.
    await expect(page.locator("#reader-status")).toHaveCSS("opacity", page.viewportSize().width >= 760 ? "1" : "0");
    // A lone pointerup (the end of a scroll) must not count as a tap.
    await page.locator("#archive-body").dispatchEvent("pointerup", { isPrimary: true, pointerType: "touch", clientX: 120, clientY: 400 });
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await tap();
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    // The same still tap folds them away again.
    await tap();
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await tap();
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    // A mouse click is text selection, not a toggle; the top edge brings the bars back.
    await tap("mouse");
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    await scrollBy(20);
    await scrollBy(20);
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    await scrollBy(10);
    await expect(body).toHaveClass(/reader-controls-hidden/);
    const paneTop = await page.locator("#reader-pane").evaluate((element) => element.getBoundingClientRect().top);
    await page.locator("#archive-body").dispatchEvent("pointermove", { pointerType: "mouse", clientX: 400, clientY: paneTop + 200 });
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await page.locator("#archive-body").dispatchEvent("pointermove", { pointerType: "mouse", clientX: 400, clientY: paneTop + 20 });
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    await scrollBy(50);
    await expect(body).toHaveClass(/reader-controls-hidden/);
    // Re-reading a few lines up keeps the text clear; a deliberate scroll up shows the bars.
    await scrollBy(-40);
    await scrollBy(-40);
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await scrollBy(-20);
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
    // Reaching the end of the body shows the next/list tools.
    await scrollBy(50);
    await expect(body).toHaveClass(/reader-controls-hidden/);
    await page.locator("#reader-pane").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(body).not.toHaveClass(/reader-controls-hidden/);
  }
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await expect(page.locator("#immersive-exit")).toBeFocused();
  if (page.viewportSize().width < 760) await page.locator("#immersive-exit").click();
  else await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await expect(page.locator("#reader-title")).toBeFocused();
  const moreButton = page.locator(page.viewportSize().width < 760 ? "#reader-bottom-more" : "#reader-toolbar-more");
  await moreButton.click();
  await page.locator("#more-immersive").click();
  await expect(page.locator("#reader-more")).toBeHidden();
  await expect(page.locator("#immersive-exit")).toBeFocused();
  await page.locator("#immersive-exit").click();
  await expect(moreButton).toBeFocused();
  await page.locator("#reader-title").focus();
  await page.keyboard.press("b");
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("/");
  await expect(page.locator("#search-input")).toBeFocused();
  await page.locator("#search-input").fill("비소속");
  await expect(page.locator(".result-item", { hasText: "비소속" })).toBeVisible();
  await expect(page.locator(".result-item", { hasText: "비소속" }).locator(".result-badges .saved-mark")).toHaveAttribute("aria-label", "저장한 글");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".result-item").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#reader")).toBeVisible();
});

test("leaves immersive mode when browser Back returns to the catalog", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('[data-destination="browse"]:visible').first().click();
  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader-title")).toBeFocused();
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
  await expect(page.locator("#immersive-exit")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  if (page.viewportSize().width < 760) await expect(page.locator(".bottom-nav")).toBeVisible();
  else if (page.viewportSize().width < 1200) await expect(page.locator(".app-bar")).toBeVisible();
  else await expect(page.locator(".rail")).toBeVisible();
});

test("searches and renders a representative AA post", async ({ page }, testInfo) => {
  if (!process.env.REDSTM_AA_KEY) await useCollectionFixture(page);
  await openPost(page, aaKey);
  await expect(page.locator("#archive-body")).toHaveClass(/(^|\s)aa(\s|$)/);
  expect(await page.evaluate(async () => {
    await document.fonts.load("16px Saitamaar");
    return document.fonts.check("16px Saitamaar");
  })).toBe(true);
  const title = await page.locator("#reader-title").innerText();
  const query = title.match(/[가-힣]{2}/)?.[0];
  expect(query).toBeTruthy();

  await page.keyboard.press("/");
  await setSelect(page, "board-filter", stableUrl(aaKey).split("/")[2]);
  await page.locator("#search-input").fill(query);
  await expect(page.locator(".result-item", { hasText: title })).toBeVisible();
  await page.locator(".result-item", { hasText: title }).click();

  const mobile = page.viewportSize().width < 760;
  await page.locator(mobile ? "#reader-bottom-settings" : "#reader-settings").click();
  await page.locator("#quick-all-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#export-state")).toBeVisible();
  await expect(page.locator("#import-state")).toBeVisible();
  await page.locator("#settings-dialog button[aria-label='닫기']").click();
  await page.locator(mobile ? "#reader-top-bookmark" : "#bookmark-post").click();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");

  const widthFits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(widthFits).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-aa.png` });
});

test("restores the reading position after immediate SPA switches", async ({ page }, testInfo) => {
  if (!process.env.REDSTM_PROSE_KEY) await useCollectionFixture(page);
  await openPost(page, proseKey);
  await expect(page.locator("#archive-body")).not.toHaveClass(/(^|\s)aa(\s|$)/);

  const available = await page.evaluate(() => {
    const target = document.getElementById("reader-pane");
    return target.scrollHeight - target.clientHeight;
  });
  expect(available).toBeGreaterThan(100);
  const title = await page.locator("#reader-title").innerText();
  const destinationPosition = await page.evaluate(() => {
    const target = document.getElementById("reader-pane");
    target.scrollTop = 300;
    const position = target.scrollTop;
    document.querySelector('[data-destination="library"]').click();
    return position;
  });
  expect(destinationPosition).toBeGreaterThan(200);
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.locator("#reader-title")).toHaveText(title);
  await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
    .toBeGreaterThan(destinationPosition - 20);

  if (!process.env.REDSTM_PROSE_KEY) {
    await expect(page.locator("#previous-post")).toBeEnabled();
    const postPosition = await page.evaluate(() => {
      const target = document.getElementById("reader-pane");
      target.scrollTop = 220;
      const position = target.scrollTop;
      document.getElementById("previous-post").click();
      return position;
    });
    await expect(page.locator("#reader-title")).toHaveText("첫째");
    await page.locator("#next-post").evaluate((button) => button.click());
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await expect.poll(() => page.locator("#reader-pane").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(postPosition - 20);
    // The deep link got a board list under it; episode moves did not add entries.
    await page.goBack();
    await expect(page).toHaveURL(/\/browse\?board=board_a$/);
    await page.goForward();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
  }

  await page.evaluate(() => { document.getElementById("reader-pane").scrollTop = 0; });
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-prose.png` });
});

test("restores collection navigation and keeps list fallback", async ({ page }) => {
  await useCollectionFixture(page);
  const mobile = page.viewportSize().width < 760;
  const previous = mobile ? "#reader-bottom-previous" : "#previous-post";
  const next = mobile ? "#reader-bottom-next" : "#next-post";
  if (mobile) {
    await page.goto("/");
    await expect(page.locator("#archive-state")).toHaveText("보존본");
    await page.locator('.bottom-nav [data-destination="browse"]').click();
    await page.locator(".result-item", { hasText: "첫째" }).click();
    await page.locator(next).click();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await page.reload();
    await expect(page.locator("#reader-title")).toHaveText("둘째");
    await page.locator("#reader-bottom-list").click();
    await expect(page).toHaveURL(/\/browse$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  }

  await openPost(page, secondKey);
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1편 보존 불가");
  await expect(page.locator(previous)).toBeEnabled();
  await expect(page.locator(next)).toBeDisabled();
  await expect(page.locator("#end-next")).toBeEnabled();
  await expect(page.locator("#end-next-title")).toHaveText("작품 목차로 돌아가기");

  await page.locator(previous).click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 1/3 · 1편 보존 불가");
  await expect(page.locator(previous)).toBeDisabled();
  await expect(page.locator(next)).toBeEnabled();
  if (mobile) {
    await page.locator("#reader-bottom-list").click();
    await expect(page).toHaveURL(/\/browse\?board=board_a$/);
    await expect(page.locator(".result-item").first()).toBeVisible();
  }

  await page.goto(`/?fixture=standalone#${encodeURIComponent(standaloneKey)}`);
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("#collection-context")).toBeHidden();
  await expect(page.locator(previous)).toBeDisabled();
  await expect(page.locator(next)).toBeEnabled();
  await page.locator(next).click();
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#collection-context")).toHaveText("테스트 연작 · 3/3 · 1편 보존 불가");
});

// The service worker itself is covered in offline.spec.js (this project blocks workers).
test("publishes install metadata and shortcuts", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await response.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512", "any"]));
  expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(["/?continue=1", "/search", "/saved", "/saved?view=excerpts", "/text"]);
  expect(manifest.shortcuts.map((shortcut) => shortcut.name)).toContain("기록");
  expect(manifest.theme_color).toBe("#1e6b5f");
});

test("searches selected fields with AND or OR token matching and preserves the URL", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search?q=둘째%20비소속&target=title&match=or");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#search-target")).toHaveValue("title");
  await expect(page.locator("#search-match")).toHaveValue("or");
  await expect(page.locator(".result-item")).toHaveCount(2);
  await expect(page.locator(".result-item", { hasText: "둘째" })).toBeVisible();
  await expect(page.locator(".result-item", { hasText: "비소속" })).toBeVisible();

  await setSelect(page, "search-match", "and");
  await expect(page.locator(".result-item")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has("match")).toBe(false);
  await page.locator("#search-input").fill("작성자");
  await setSelect(page, "search-target", "author");
  await expect(page.locator(".result-item")).toHaveCount(3);
  await expect.poll(() => new URL(page.url()).searchParams.get("target")).toBe("author");
  await page.reload();
  await expect(page.locator("#search-target")).toHaveValue("author");
  await expect(page.locator(".result-item")).toHaveCount(3);
});

test("restores loaded collection pages, scroll, and focus after Back and reload", async ({ page }) => {
  await useCollectionPaginationFixture(page, 103);
  await page.goto("/collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item")).toHaveCount(100);
  await page.locator("#result-more").click();
  await expect(page.locator(".result-item")).toHaveCount(103);
  const list = page.locator("#result-list");
  await list.evaluate((element) => {
    element.style.height = "100px";
    element.style.maxHeight = "100px";
  });
  const target = page.locator(".result-item").last();
  await target.focus();
  const expectedScroll = await list.evaluate((element) => element.scrollTop);
  expect(expectedScroll).toBeGreaterThan(0);
  await target.click();
  await expect(page.locator("#collection-title")).toHaveText("작품 103");
  await page.goBack();
  await expect(page.locator(".result-item")).toHaveCount(103);
  await expect(page.locator(".result-item:focus")).toContainText("작품 103");
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(expectedScroll);

  await page.reload();
  await expect(page.locator(".result-item")).toHaveCount(103);
  await expect(page.locator(".result-item:focus")).toContainText("작품 103");
});

test("saves, restores, edits, and removes bookmark notes and tags", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator(page.viewportSize().width < 760 ? "#reader-bottom-more" : "#reader-toolbar-more").click();
  await page.locator("#more-note").click();
  await expect(page.locator("#bookmark-dialog")).toBeVisible();
  await expect(page.locator("#bookmark-remove")).toBeHidden();
  await page.locator("#bookmark-note").fill("다시 볼 장면");
  await page.locator("#bookmark-tags").fill("명장면, AA, aa");
  await page.locator("#bookmark-save").click();
  await expect(page.locator("#bookmark-dialog")).toBeHidden();
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/saved");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const saved = page.locator(".bookmark-row", { hasText: "비소속" });
  await expect(saved).toContainText("다시 볼 장면");
  await expect(saved).toContainText("#명장면");
  await expect(saved).toContainText("#AA");
  await expect(saved).not.toContainText("#aa");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await saved.locator(".bookmark-edit").click();
  await expect(page.locator("#bookmark-note")).toHaveValue("다시 볼 장면");
  await page.locator("#bookmark-remove").click();
  await expect(page.locator(".bookmark-row")).toHaveCount(0);
});

test("browses the v2 collection catalog and loads only the selected detail shard", async ({ page }) => {
  const requested = await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator('[data-scope="collections"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toBeVisible();
  expect(requested.has(collectionIndexKey)).toBe(true);
  expect(requested.has(collectionDetailKey)).toBe(false);
  expect(requested.has(collectionMembershipKey)).toBe(false);

  await page.locator(".result-item", { hasText: "테스트 연작" }).click();
  await expect(page).toHaveURL(/\/collections\/1$/);
  await expect(page.locator("#collection-title")).toHaveText("테스트 연작");
  await expect(page.locator(".collection-entry")).toHaveCount(3);
  await expect(page.locator('.collection-entry[data-position="2"]')).toBeDisabled();
  expect(requested.has(collectionDetailKey)).toBe(true);
  expect(requested.has(collectionMembershipKey)).toBe(false);

  await page.locator('.collection-entry[data-position="1"]').click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await expect(page.locator("#collection-context")).toContainText("테스트 연작 · 1/3");
  expect(requested.has(collectionMembershipKey)).toBe(true);
  await page.locator("#collection-context").click();
  await expect(page.locator("#collection-title")).toHaveText("테스트 연작");
});

test("filters collections by kind and reading state and continues at the next unread entry", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z", progress: 0.4 } },
    bookmarks: {}, scroll: { "board_a:1": 120 }, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/collections?kind=series&read=reading&sort=updated");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#collection-kind-filter")).toHaveValue("series");
  await expect(page.locator("#collection-read-filter")).toHaveValue("reading");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toContainText("0/2편");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toContainText("이어 읽기");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toContainText("1편 보존 불가");

  await setSelect(page, "collection-kind-filter", "oneshot");
  await expect(page).toHaveURL(/kind=oneshot/);
  await expect(page.locator(".result-item")).toHaveCount(0);
  await setSelect(page, "collection-kind-filter", "series");
  await page.locator(".result-item", { hasText: "테스트 연작" }).click();
  await expect(page.locator("#collection-meta")).toContainText("읽음 0/2");
  await expect(page.locator('#collection-entry-list [data-position="1"] .collection-entry-state')).toHaveText("40%");
  await expect(page.locator("#collection-continue")).toContainText("1편부터 이어 읽기");
  await page.locator("#collection-continue").click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
});

test("continues a finished chapter at the next available episode, not a skipped gap", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: {
      "board_a:1": { readAt: "2026-07-11T00:00:00Z", progress: 0 },
      "board_a:2": { readAt: "2026-07-12T00:00:00Z", progress: 0.95 },
    },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/collections/1");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#collection-continue")).toHaveText("앞쪽 미독 1편 보기");
  await expect(page.locator('#collection-entry-list [data-position="3"] .collection-entry-state')).toHaveText("다 읽음");
  await expect(page.locator('#collection-entry-list [data-position="1"] .collection-entry-state')).toHaveText("");
  await page.locator("#collection-continue").click();
  await expect(page.locator("#reader")).toBeHidden();
  await expect(page.locator('.collection-entry[data-position="1"]')).toBeFocused();
});

test("treats a collection as finished when every available episode is done", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: {
      "board_a:1": { readAt: "2026-07-11T00:00:00Z", progress: 0.95 },
      "board_a:2": { readAt: "2026-07-12T00:00:00Z", progress: 1 },
    },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/browse?scope=collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const row = page.locator(".result-item", { hasText: "테스트 연작" });
  await expect(row).toContainText("2/2편");
  await expect(row).toContainText("다시 보기");
  await expect(row).toContainText("1편 보존 불가");
});

test("does not count unavailable finished episodes toward collection occupancy", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: {
      "board_a:2": { readAt: "2026-07-12T00:00:00Z", progress: 1 },
      "board_a:99": { readAt: "2026-07-12T01:00:00Z", progress: 1 },
    },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/browse?scope=collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const row = page.locator(".result-item", { hasText: "테스트 연작" });
  await expect(row).toContainText("1/2편");
  await expect(row).toContainText("이어 읽기");
  await expect(row).not.toContainText("다시 보기");
});

test("keeps older finished history after 500 newer reads", async ({ page }) => {
  await page.addInitScript(() => {
    const history = { "board_a:10": { readAt: "2026-01-01T00:00:00.000Z", progress: 1 } };
    for (let index = 11; index <= 510; index += 1) {
      history[`board_a:${index}`] = { readAt: `2026-06-01T00:00:00.${String(index).padStart(3, "0")}Z`, progress: 1 };
    }
    localStorage.setItem("redstm.userState.v2", JSON.stringify({
      schema_version: 2,
      settings: {},
      history,
      bookmarks: {},
      scroll: { "board_a:10": 321 },
      viewModes: {}, lastCatalogState: null,
    }));
  });
  await useCollectionFixture(page);
  await page.goto("/read/board_a/3");
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  const preserved = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("redstm.userState.v2"));
    return {
      oldest: Boolean(state.history["board_a:10"]),
      progress: state.history["board_a:10"]?.progress,
      scroll: state.scroll["board_a:10"],
      count: Object.keys(state.history).length,
    };
  });
  expect(preserved.oldest).toBe(true);
  expect(preserved.progress).toBe(1);
  expect(preserved.scroll).toBe(321);
  expect(preserved.count).toBe(502);
});

test("still lists collections when an unrelated membership object fails", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z", progress: 0.4 } },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.route("**/archive/collections/membership-v2/**", (route) =>
    route.fulfill({ status: 500, body: "membership failed" }));
  await page.goto("/browse?scope=collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toBeVisible();
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toContainText("읽기 상태 미확인");
  await expect(page.locator("#result-status")).toContainText("일부 읽기 상태 미확인");
  await page.goto("/browse?scope=collections&read=reading");
  await expect(page.locator(".result-item")).toHaveCount(0);
});

test("ignores a late collection response after leaving for home", async ({ page }) => {
  await useCollectionFixture(page, { collectionV2: true });
  let releaseDetail;
  const gate = new Promise((resolve) => { releaseDetail = resolve; });
  await page.route(`**/${collectionDetailKey}`, async (route) => {
    await gate;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: 1, shard: 1, collections: [{
          id: 1, board_id: "board_a", kind: "series", title: "테스트 연작",
          entries: [
            { position: 1, board_id: "board_a", external_post_id: 1, title: "첫째", object_key: firstKey },
            { position: 2, board_id: "board_a", external_post_id: 99, title: "보존 불가", object_key: null },
            { position: 3, board_id: "board_a", external_post_id: 2, title: "둘째", object_key: secondKey },
          ],
        }],
      }),
    });
  });
  await page.goto("/collections/1");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.evaluate(() => document.querySelector('[data-destination="library"]')?.click());
  await expect(page.locator("#empty-reader")).toBeVisible();
  releaseDetail();
  await expect(page.locator("#collection-view")).toBeHidden();
  await expect(page.locator("#home-title")).toBeVisible();
});

test("reads legacy three-tuple membership without an unavailable list", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z", progress: 0.4 } },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.route(`**/${collectionMembershipKey}`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      schema_version: 1, board_id: "board_a",
      members: [[1, 1, 1], [2, 1, 3], [99, 1, 2]],
    }),
  }));
  await page.goto("/browse?scope=collections");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item", { hasText: "테스트 연작" })).toContainText("이어 읽기");
});

test("marks the current episode finished when moving on from the article end", async ({ page }) => {
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/collections/1");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator('.collection-entry[data-position="1"]').click();
  await expect(page.locator("#reader-title")).toHaveText("첫째");
  await page.locator("#end-next").click();
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await page.locator("#collection-context").click();
  await expect(page.locator('#collection-entry-list [data-position="1"] .collection-entry-state')).toHaveText("다 읽음");
});

test("labels standalone next/previous as board order and list next as the current result", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/read/board_a/3");
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("#end-next-kicker")).toHaveText("다음 글 · 게시판");
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator(".result-item", { hasText: "비소속" }).click();
  await expect(page.locator("#end-next-kicker")).toHaveText("다음 글 · 현재 결과");
});

test("offers the next collection episode from Home after finishing the latest chapter", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2,
    settings: {},
    history: { "board_a:1": { readAt: "2026-07-12T00:00:00Z", progress: 0.95 } },
    bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  })));
  await useCollectionFixture(page, { collectionV2: true });
  await page.goto("/?continue=1");
  await expect(page.locator("#reader-title")).toHaveText("둘째");
});

test("widens a failed search one condition at a time", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search?q=없는제목&target=title&board=board_a");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item")).toHaveCount(0);
  await expect(page.locator("#search-widen")).toBeVisible();
  await page.locator("#search-widen button", { hasText: "전체 필드로 검색" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("target")).toBe(false);
});

test("distinguishes a missing preserved object", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/read/board_a/404");
  await expect(page.locator("#archive-state")).toHaveText("본문 오류");
  await expect(page.locator("#empty-reader")).toContainText("현재 보존본에서 글을 찾을 수 없습니다");
});

test("keeps Reader content open when local storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    };
  });
  await useCollectionFixture(page);

  await page.goto(stableUrl(secondKey));

  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#archive-body")).toContainText("둘째 본문 1");
  await expect(page.locator("#archive-state")).toHaveText("로컬 저장 실패");
});

test("distinguishes Access expiry from an archive failure", async ({ page }) => {
  await useAccessExpiredFixture(page);
  await page.goto("/");
  await expect(page.locator("#archive-state")).toHaveText("로그인 필요");
  await expect(page.locator("#home-title")).toHaveText("로그인이 만료되었습니다");
  await expect(page.locator("#home-action")).toHaveText("다시 로그인");
});

test("preserves loaded Reader content while connectivity changes", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, secondKey);
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator("#archive-state")).toHaveText("오프라인");
  await expect(page.locator("#reader-title")).toHaveText("둘째");
  await expect(page.locator("#archive-body")).toContainText("둘째 본문 1");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#archive-state")).toHaveText("보존본");
});

test("uses a full-width discovery canvas and hides the empty reader pane", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("body")).toHaveClass(/discovery/);
  await expect(page.locator("#empty-reader")).toBeHidden();
  await expect(page.locator("#reader")).toBeHidden();
  await expect(page.locator(".result-item")).toHaveCount(3);
  if (page.viewportSize().width >= 1200) {
    const width = await page.locator(".catalog-inner").evaluate((element) => element.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(680);
  }
  if (page.viewportSize().width < 760) {
    const firstTop = await page.locator(".result-item").first().evaluate((element) => element.getBoundingClientRect().top);
    // Heading, source switch (타입문넷 · 소설 · 아카라이브), scope tabs, the board picker and chips.
    expect(firstTop).toBeLessThan(360);
  }

  await page.locator(".result-item").first().click();
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/reading/);
  await page.goBack();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(page.locator("body")).toHaveClass(/discovery/);
});

test("does not dump the whole archive into an empty search", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#mode-chips")).toBeHidden();
  await expect(page.locator("#search-empty")).toBeVisible();
  await expect(page.locator(".result-item")).toHaveCount(0);
  await page.locator("#search-input").fill("첫째");
  await expect(page.locator(".result-item", { hasText: "첫째" })).toBeVisible();
  await expect(page.locator(".result-title mark")).toHaveText("첫째");
});

test("opens a direct Reader deep link without inventing a context list", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/read/board_a/3");
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page.locator("body")).toHaveClass(/reading/);
  await expect(page.locator("body")).not.toHaveClass(/reading-context/);
  if (page.viewportSize().width >= 760) await expect(page.locator(".catalog")).toBeHidden();
  // Reloading does not stack another parent; one Back reaches the post's board list.
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\?board=board_a$/);
  await expect(page.locator(".result-item", { hasText: "비소속" })).toBeVisible();
});

test("picks a board from the board dock without opening filters", async ({ page }) => {
  await useBoardFilterFixture(page);
  await page.goto("/browse?mode=aa");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#board-dock")).toBeVisible();
  await expect(page.locator("#board-dock-name")).toHaveText("전체 게시판");
  await page.locator("#board-dock-button").click();
  const sheet = page.getByRole("dialog", { name: "게시판 선택" });
  await expect(sheet).toBeVisible();
  const creation = sheet.locator('.board-group-toggle[data-group="창작"]');
  await expect(creation).toHaveAttribute("aria-expanded", "false");
  await creation.click();
  await expect(creation).toHaveAttribute("aria-expanded", "true");
  // Starring does not select the row.
  await sheet.locator('[data-star="write_free"]').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-star="write_free"]').first()).toHaveAttribute("aria-pressed", "true");
  await sheet.locator('.board-group [data-board="write_free"]').click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/board=write_free/);
  // An AA-only format filter would hide this prose board, so it is cleared.
  await expect(page).not.toHaveURL(/mode=aa/);
  await expect(page.locator(".result-item .result-title")).toHaveText(["소설 글"]);
  await expect(page.locator("#board-dock-name")).toHaveText("창작집담");
  await expect(page.locator("#board-dock-group")).toHaveText("창작");
  await page.locator("#board-dock-button").click();
  await expect(sheet.locator(".board-section h3", { hasText: "즐겨찾기" })).toBeVisible();
  await sheet.locator("#board-search").fill("19금");
  await expect(sheet.locator(".board-select")).toHaveCount(1);
  await sheet.locator("button[aria-label='닫기']").click();
  await page.locator("#board-dock-clear").click();
  await expect(page).not.toHaveURL(/board=/);
  await expect(page.locator(".result-item")).toHaveCount(3);
});

test("keeps filter sheet edits as a draft until applied", async ({ page }) => {
  test.skip(page.viewportSize().width >= 760, "The filter sheet is the narrow-screen presentation");
  await useCollectionFixture(page);
  await page.goto("/search?q=%EC%A7%B8");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await page.locator("#filter-toggle").click();
  await expect(page.getByRole("dialog", { name: "필터" })).toBeVisible();
  await setSelect(page, "search-target", "title");
  await expect(page).not.toHaveURL(/target=title/);
  await page.locator("#filter-dialog button[aria-label='닫기']").click();
  await expect(page.locator("#search-target")).toHaveValue("all");
  await page.locator("#filter-toggle").click();
  await setSelect(page, "search-target", "title");
  await page.locator("#filter-apply").click();
  await expect(page.getByRole("dialog", { name: "필터" })).toBeHidden();
  await expect(page).toHaveURL(/target=title/);
});

async function usePopularityFixture(page) {
  const fields = ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa", "views", "comment_count"];
  const detailKey = `collections/details-v2/00-${"7".repeat(64)}.json.zst`;
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: 3 }],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1, fields,
      posts: [
        ["board_a", 3, "조용한 새 글", "작성자", null, "2026-07-11", standaloneHash, false, 12, 0],
        ["board_a", 2, "댓글 많은 글", "작성자", null, "2026-07-10", secondHash, false, 300, 48],
        ["board_a", 1, "조회 많은 글", "작성자", null, "2026-07-09", firstHash, false, 25000, 3],
      ],
    }],
    [collectionIndexKey, {
      schema_version: 2, shard_count: 64,
      collections: [
        { id: 1, board_id: "board_a", kind: "series", title: "가 조용한 연재", entry_count: 1, latest_created_at: "2026-07-11T00:00:00Z", views: 10, comments: 1 },
        { id: 2, board_id: "board_a", kind: "series", title: "나 인기 연재", entry_count: 1, latest_created_at: "2026-07-01T00:00:00Z", views: 90000, comments: 5 },
      ],
      detail_shards: [{ shard: 0, object_key: detailKey }], memberships: [],
    }],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

test("offers view and comment sorts when the release carries counts", async ({ page }) => {
  await usePopularityFixture(page);
  await page.goto("/browse?sort=comments");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const sort = page.locator("#sort-filter");
  await expect(sort).toHaveValue("comments");
  await expect(page.locator(".result-item .result-title")).toHaveText(["댓글 많은 글", "조회 많은 글", "조용한 새 글"]);
  await sort.selectOption("views");
  await expect(page).toHaveURL(/sort=views/);
  await expect(page.locator(".result-item .result-title").first()).toHaveText("조회 많은 글");
  await expect(page.locator(".result-item").first().locator(".result-stats")).toHaveText("조회 2.5만 · 댓글 3");
  // Works: the popularity sort from a link waits for the lazily loaded work index.
  await page.goto("/browse?scope=collections&sort=views");
  await expect(page.locator(".result-item .result-title")).toHaveText(["나 인기 연재", "가 조용한 연재"]);
  await expect(page.locator("#sort-filter")).toHaveValue("views");
  await expect(page).toHaveURL(/sort=views/);
});

test("오늘의 발견 suggests unread works, discussed posts, and this day in past years", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-28T10:00:00"));
  const fields = ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa", "views", "comment_count"];
  const membershipKey = `collections/membership-v2/board_a-${"6".repeat(64)}.json.zst`;
  const hotKey = `posts/board_a/3-${standaloneHash}.json.zst`;
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: 3 }],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1, fields,
      posts: [
        ["board_a", 3, "화제의 글", "작성자", null, "2026-09-20", standaloneHash, false, 100, 30],
        ["board_a", 2, "삼 년 전 오늘 글", "작성자", null, "2023-09-28", secondHash, false, 10, 0],
        ["board_a", 4, "사 년 전 화제 글", "작성자", null, "2022-09-28", "8".repeat(64), false, 10, 7],
        ["board_a", 1, "조용한 글", "작성자", null, "2022-01-01", firstHash, false, 1, 0],
      ],
    }],
    [collectionIndexKey, {
      schema_version: 2, shard_count: 64,
      collections: [
        { id: 1, board_id: "board_a", kind: "series", title: "읽던 연재", entry_count: 3, latest_created_at: "2026-09-27T00:00:00Z", views: 5, comments: 1 },
        { id: 2, board_id: "board_a", kind: "series", title: "추천 연재", entry_count: 4, latest_created_at: "2026-01-01T00:00:00Z", views: 900, comments: 20 },
        { id: 3, board_id: "board_a", kind: "oneshot", title: "짧은 단편 묶음", entry_count: 9, latest_created_at: "2026-01-01T00:00:00Z", views: 900, comments: 20 },
      ],
      detail_shards: [], memberships: [{ board_id: "board_a", object_key: membershipKey }],
    }],
    [membershipKey, { schema_version: 1, board_id: "board_a", members: [[1, 1, 1]] }],
    [hotKey, postPayload(3, "화제의 글")],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    history: { "board_a:1": { readAt: "2026-09-01T00:00:00Z", progress: 0.5 } },
  })));
  await page.goto("/");
  const discover = page.locator("#discover");
  await expect(discover).toBeVisible();
  await expect(page.locator("#discover-picks .home-item strong")).toHaveText(["추천 연재"]);
  await expect(page.locator("#discover-picks")).toContainText("조회 900 · 댓글 20");
  await expect(page.locator("#discover-hot .home-item strong")).toHaveText(["화제의 글", "사 년 전 화제 글"]);
  await expect(page.locator("#discover-day-title")).toHaveText("이날의 기록 · 9월 28일");
  // Already shown as 요즘 화제, the four-year-old post is not repeated here.
  await expect(page.locator("#discover-day .home-item strong")).toHaveText(["삼 년 전 오늘 글"]);
  await expect(page.locator("#discover-day")).toContainText("3년 전");
  // The work read before its newest episode is flagged and listed first.
  await expect(page.locator("#reading-works-list .home-item").first()).toContainText("읽던 연재");
  await expect(page.locator("#reading-works-list .home-badge")).toHaveText("새 편");
  await page.locator("#discover-hot .home-item").first().click();
  await expect(page.locator("#reader-title")).toHaveText("화제의 글");
  await expect(page.locator("#reader-list-kicker")).toHaveText("게시판");
});

test("sorts from the result bar on every width, outside the filter sheet", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const sort = page.locator("#result-bar #sort-filter");
  await expect(sort).toBeVisible();
  await sort.selectOption("oldest");
  await expect(page).toHaveURL(/sort=oldest/);
  await expect(page.locator(".result-item .result-title").first()).toHaveText("첫째");
  // This fixture's index has no counts, so popularity sorts are not offered.
  await expect(sort.locator("option")).toHaveText(["최신순", "오래된순"]);
});

test("keeps the filtered result status unchanged while reading and saving", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/browse?board=board_a");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const status = page.locator("#result-status");
  await expect(status).toHaveText("자유게시판 · 3건");
  await page.locator(".result-item", { hasText: "비소속" }).click();
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await page.locator("#reader-title").focus();
  await page.keyboard.press("b");
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  await expect(status).toHaveText("자유게시판 · 3건");
});

test("a board's own categories narrow it and travel in the URL", async ({ page }) => {
  const hash = (n) => String(n).repeat(64).slice(0, 64);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const payload = key === "release.json" ? {
      schema_version: 1, search: { object_key: "search/e2e.json.zst" }, collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "write_plus", name: "일반창작1관", group_name: "창작", post_count: 4 }],
    } : key === "search/e2e.json.zst" ? {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: [
        ["write_plus", 4, "장편 넷", "작성자", "장편", "2026-07-11", hash(4), false],
        ["write_plus", 3, "단편 셋", "작성자", "단편", "2026-07-10", hash(5), false],
        ["write_plus", 2, "장편 둘", "작성자", "장편", "2026-07-09", hash(6), false],
        ["write_plus", 1, "분류 없음", "작성자", null, "2026-07-08", hash(7), false],
      ],
    } : key === collectionIndexKey ? { schema_version: 1, collections: [] } : null;
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/browse");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator("#category-chips")).toBeHidden();
  await page.goto("/browse?board=write_plus");
  const chips = page.locator("#category-chips button");
  await expect(chips).toHaveText(["전체 3", "장편 2", "단편 1"]);
  // The board's categories take the format chips' row.
  await expect(page.locator("#mode-chips")).toBeHidden();
  await chips.filter({ hasText: "장편" }).click();
  await expect(page).toHaveURL(/\/browse\?board=write_plus&category=%EC%9E%A5%ED%8E%B8$/);
  await expect(page.locator(".result-item .result-title")).toHaveText(["장편 넷", "장편 둘"]);
  await page.reload();
  await expect(chips.filter({ hasText: "장편" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".result-item .result-title")).toHaveText(["장편 넷", "장편 둘"]);
  await chips.filter({ hasText: "전체" }).click();
  await expect(page.locator(".result-item")).toHaveCount(4);
});

test("Browse never takes Search's words, and each tab keeps its own conditions", async ({ page }) => {
  await useBoardFilterFixture(page);
  await page.goto("/browse?board=write_free");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  await expect(page.locator(".result-item .result-title")).toHaveText(["소설 글"]);
  await page.locator('[data-destination="search"]').filter({ visible: true }).first().click();
  // Search opened from a board searches that board.
  await expect(page).toHaveURL(/\/search\?board=write_free$/);
  await page.locator("#board-dock-clear").click();
  await page.locator("#search-input").fill("AA");
  await expect(page).toHaveURL(/\/search\?q=AA$/);
  await page.locator('[data-destination="browse"]').filter({ visible: true }).first().click();
  // Browse has no search field, so the words must not filter it; its board comes back.
  await expect(page).toHaveURL(/\/browse\?board=write_free$/);
  await expect(page.locator(".result-item .result-title")).toHaveText(["소설 글"]);
  await page.locator('[data-destination="search"]').filter({ visible: true }).first().click();
  await expect(page.locator("#search-input")).toHaveValue("AA");
  // A /browse link with words still shows the whole board.
  await page.goto("/browse?board=write_free&q=AA");
  await expect(page.locator(".result-item .result-title")).toHaveText(["소설 글"]);
});

test("a second tab's bookmarks survive this tab's next reading save", async ({ page, context }) => {
  await useCollectionFixture(page);
  await openPost(page, secondKey);
  const other = await context.newPage();
  await useCollectionFixture(other);
  await openPost(other, standaloneKey);
  await other.locator("#reader-title").focus();
  await other.keyboard.press("b");
  await expect(other.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "true");
  // The first tab keeps reading; its scroll save must not drop the other tab's bookmark.
  await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop = 300; });
  const bookmarks = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("redstm.userState.v2")).bookmarks));
  await expect.poll(async () => {
    await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop += 5; });
    return bookmarks();
  }).toContain("board_a:3");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")));
  expect(Object.keys(stored.history)).toEqual(expect.arrayContaining(["board_a:2", "board_a:3"]));
  expect(await page.evaluate(() => localStorage.getItem("redstm.userState.v2").includes("\n"))).toBe(false);
});

test("leaves browser shortcuts with modifier keys to the browser", async ({ page }) => {
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-title").focus();
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+b");
  await expect(page.locator("body")).not.toHaveClass(/immersive/);
  await expect(page.locator("#bookmark-post")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("f");
  await expect(page.locator("body")).toHaveClass(/immersive/);
});

test("the 이어서 읽기 app shortcut opens the continued post with Home behind it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("redstm.userState.v2", JSON.stringify({
    schema_version: 2, settings: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    history: { "board_a:3": { readAt: "2026-09-28T00:00:00Z", progress: 0.42 } },
  })));
  await useCollectionFixture(page);
  await page.goto("/?continue=1");
  await expect(page.locator("#reader-title")).toHaveText("비소속");
  await expect(page).toHaveURL(/\/read\/board_a\/3$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#continue-title")).toHaveText("비소속");
});

test("lists the keyboard shortcuts on ? at desktop widths", async ({ page }) => {
  test.skip(page.viewportSize().width < 760, "Phones have no hardware keyboard shortcuts list");
  await useCollectionFixture(page);
  await openPost(page, standaloneKey);
  await page.locator("#reader-title").focus();
  await page.keyboard.press("Shift+Slash");
  await expect(page.getByRole("dialog", { name: "읽기 설정" })).toBeVisible();
  await expect(page.locator("#settings-keys")).toHaveAttribute("open", "");
  await expect(page.locator("#settings-keys")).toContainText("집중 모드");
  await expect(page.locator("#settings-keys")).toBeInViewport();
});

// docs/24 §8.4 · T19: title suggestions for works and boards, forgiving one-jamo typos and
// Latin-keyboard input; the archive-wide post search waits for a composed syllable.
test("search suggests works for partial, typo and Latin-key input and opens one", async ({ page }) => {
  await useCollectionFixture(page);
  await page.goto("/search");
  await expect(page.locator("#archive-state")).toHaveText("보존본");
  const input = page.locator("#search-input");
  const panel = page.locator("#search-suggest");
  await input.fill("연작");
  await expect(panel.locator(".suggest-row").first()).toContainText("테스트 연작");
  await expect(panel.locator(".suggest-row mark").first()).toHaveText("연작");
  // Composition updates only the suggestions.
  await input.evaluate((element) => {
    element.value = "테스트 연자";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  });
  await expect(panel.locator("h3").first()).toBeVisible();
  await input.fill("xptmxm");
  await expect(panel.locator(".suggest-qwerty")).toHaveText("'테스트'(으)로 찾을까요?");
  await panel.locator(".suggest-qwerty").click();
  await expect(input).toHaveValue("테스트");
  await panel.locator(".suggest-row").first().click();
  await expect(page).toHaveURL(/\/collections\//);
});
