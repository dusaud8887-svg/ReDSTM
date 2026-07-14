import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_FIELDS, findPost, prepareSearch, searchPosts } from "../public/search-core.js";
import { createIndexLoader } from "../public/search-worker.js";

const payload = {
  schema_version: 1,
  fields: SEARCH_FIELDS,
  posts: [
    ["write", 3, "ＦＡＴＥ 달빛", "홍길동", "팬픽", "2026-03-03", "a".repeat(64)],
    ["aa", 2, "달빛 아래", "작가 나", "AA", "2026-03-02", "b".repeat(64)],
    ["write", 1, "첫 글", "작가 가", null, "2026-03-01", "c".repeat(64)],
  ],
};

test("searches Korean metadata with normalization, filters, and stable limits", () => {
  const index = prepareSearch(payload);

  assert.deepEqual(index.boards, ["aa", "write"]);
  assert.deepEqual(searchPosts(index, { query: "fate 달빛" }).posts.map((post) => post.external_post_id), [3]);
  assert.deepEqual(searchPosts(index, { query: "작가", boardId: "aa" }).posts.map((post) => post.external_post_id), [2]);
  assert.deepEqual(searchPosts(index, { query: "달빛 작가", match: "or" }).posts.map((post) => post.external_post_id), [3, 2, 1]);
  assert.deepEqual(searchPosts(index, { query: "달빛 작가", target: "title", match: "or" }).posts.map((post) => post.external_post_id), [3, 2]);
  assert.deepEqual(searchPosts(index, { query: "작가 나", target: "author" }).posts.map((post) => post.external_post_id), [2]);
  assert.deepEqual(searchPosts(index, { query: "팬픽", target: "title" }).posts, []);
  assert.deepEqual(searchPosts(index, { limit: 2 }).posts.map((post) => post.external_post_id), [3, 2]);
  assert.deepEqual(searchPosts(index, { limit: 1, offset: 1 }).posts.map((post) => post.external_post_id), [2]);
  assert.deepEqual(searchPosts(index, { sort: "oldest" }).posts.map((post) => post.external_post_id), [1, 2, 3]);
  assert.deepEqual(searchPosts(index, { category: "팬픽" }).posts.map((post) => post.external_post_id), [3]);
  assert.throws(() => searchPosts(index, { mode: "aa" }), /unavailable/);
  assert.equal(searchPosts(index, { limit: 1 }).total, 3);
  assert.equal(searchPosts(index, { limit: 1 }).posts[0].object_key, `posts/write/3-${"a".repeat(64)}.json.zst`);
  assert.equal(searchPosts(index, { limit: 1 }).posts[0].is_aa, undefined);
  assert.equal(findPost(index, "aa", 2)?.title, "달빛 아래");
  assert.equal(findPost(index, "aa", 99), null);
  assert.throws(() => searchPosts(index, { limit: 0 }), /between 1 and 200/);
  assert.throws(() => searchPosts(index, { offset: -1 }), /offset/);
  assert.throws(() => searchPosts(index, { mode: "unknown" }), /mode/);
  assert.throws(() => searchPosts(index, { sort: "unknown" }), /sort/);
  assert.throws(() => searchPosts(index, { target: "unknown" }), /target/);
  assert.throws(() => searchPosts(index, { match: "unknown" }), /match/);
  assert.throws(() => prepareSearch({ ...payload, fields: [] }), /schema/);
});

test("paginates matches with a stable offset window over a constant total", () => {
  const index = prepareSearch(payload);

  const first = searchPosts(index, { limit: 2, offset: 0 });
  assert.deepEqual(first.posts.map((post) => post.external_post_id), [3, 2]);
  assert.equal(first.total, 3);

  const second = searchPosts(index, { limit: 2, offset: 2 });
  assert.deepEqual(second.posts.map((post) => post.external_post_id), [1]);
  assert.equal(second.total, 3);

  // Offset past the end yields no rows but still reports the full match count.
  const beyond = searchPosts(index, { limit: 2, offset: 3 });
  assert.deepEqual(beyond.posts, []);
  assert.equal(beyond.total, 3);

  // Offset respects filters (aa board has a single match).
  assert.deepEqual(searchPosts(index, { boardId: "aa", offset: 1 }).posts, []);
  assert.equal(searchPosts(index, { boardId: "aa", offset: 1 }).total, 1);

  assert.throws(() => searchPosts(index, { offset: -1 }), /offset/);
  assert.throws(() => searchPosts(index, { offset: 1.5 }), /offset/);
});

test("accepts is_aa appended to the search tuple", () => {
  const extended = prepareSearch({
    ...payload,
    fields: [...SEARCH_FIELDS, "is_aa"],
    posts: payload.posts.map((row, index) => [...row, index === 1 ? 1 : 0]),
  });

  assert.equal(searchPosts(extended, { boardId: "aa" }).posts[0].is_aa, true);
  assert.equal(searchPosts(extended, { boardId: "write" }).posts[0].is_aa, false);
  assert.deepEqual(searchPosts(extended, { mode: "prose" }).posts.map((post) => post.external_post_id), [3, 1]);
  assert.throws(() => prepareSearch({
    ...payload,
    fields: [...SEARCH_FIELDS, "is_aa"],
    posts: [[...payload.posts[0], 2]],
  }), /row/);
});

test("retries a failed search index load once after two seconds", async () => {
  const requests = [];
  const delays = [];
  let searchAttempts = 0;
  const load = createIndexLoader({
    fetcher: async (url) => {
      requests.push(url);
      if (url === "/archive/release.json") {
        return Response.json({ schema_version: 1, search: { object_key: "search/test.json" } });
      }
      searchAttempts += 1;
      return searchAttempts === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json(payload);
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  const loaded = await load();
  assert.equal(loaded.index.rows.length, payload.posts.length);
  assert.deepEqual(requests, [
    "/archive/release.json",
    "/archive/search/test.json",
    "/archive/release.json",
    "/archive/search/test.json",
  ]);
  assert.deepEqual(delays, [2_000]);
});

test("clears a rejected index promise so a later message can recover", async () => {
  let available = false;
  let requests = 0;
  const delays = [];
  const load = createIndexLoader({
    fetcher: async (url) => {
      requests += 1;
      if (!available) return new Response("unavailable", { status: 503 });
      return url === "/archive/release.json"
        ? Response.json({ schema_version: 1, search: { object_key: "search/test.json" } })
        : Response.json(payload);
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  await assert.rejects(load(), /Release manifest could not be loaded/);
  available = true;
  assert.equal((await load()).index.rows.length, payload.posts.length);
  assert.equal(requests, 4);
  assert.deepEqual(delays, [2_000]);
});

test("worker exposes release metadata, exact totals, and stable identity resolution", async (context) => {
  const messages = [];
  let onMessage;
  const previousSelf = globalThis.self;
  const previousFetch = globalThis.fetch;
  globalThis.self = {
    addEventListener(type, handler) {
      if (type === "message") onMessage = handler;
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  const workerPayload = {
    ...payload,
    posts: [
      ...payload.posts,
      ...Array.from({ length: 4 }, (_, index) => [
        "write",
        10 + index,
        `추가 ${index}`,
        "추가 작가",
        "팬픽",
        `2026-02-0${index + 1}`,
        String(index + 1).repeat(64),
      ]),
    ],
  };
  globalThis.fetch = async (url) => {
    if (url === "/archive/release.json") {
      return {
        ok: true,
        headers: { get: (name) => name === "Last-Modified" ? "Sun, 12 Jul 2026 00:00:00 GMT" : null },
        json: async () => ({
          schema_version: 1,
          search: { object_key: "search/test.json.zst" },
          boards: [
            { board_id: "aa", name: "AA", group_name: "AA", post_count: 1 },
            { board_id: "write", name: "창작", group_name: "소설", post_count: 6 },
          ],
        }),
      };
    }
    return { ok: true, json: async () => workerPayload };
  };
  context.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
    globalThis.fetch = previousFetch;
  });

  await import("../public/search-worker.js?search-worker-test");
  await onMessage({ data: { type: "init", id: 1 } });
  assert.equal(messages.at(-1).count, 7);
  assert.equal(messages.at(-1).hasIsAa, false);
  assert.equal(messages.at(-1).recentPosts.length, 6);
  assert.equal(messages.at(-1).publishedAt, "2026-07-12T00:00:00.000Z");
  assert.equal(messages.at(-1).boardMetadata[1].name, "창작");

  await onMessage({ data: { type: "search", id: 2, limit: 1, offset: 1 } });
  assert.equal(messages.at(-1).posts.length, 1);
  assert.equal(messages.at(-1).posts[0].external_post_id, 2);
  assert.equal(messages.at(-1).total, 7);
  assert.equal(messages.at(-1).offset, 1);

  await onMessage({
    data: {
      type: "resolve",
      id: 3,
      identities: ["write:3", "write:999"],
    },
  });
  assert.equal(messages.at(-1).summaries[0].external_post_id, 3);
  assert.equal(messages.at(-1).summaries[1], null);

  await onMessage({
    data: {
      type: "resolve",
      id: 4,
      identities: Array.from({ length: 501 }, () => "write:3"),
    },
  });
  assert.equal(messages.at(-1).type, "error");
});

test("worker identifies an expired Access session", async (context) => {
  const messages = [];
  let onMessage;
  const previousSelf = globalThis.self;
  const previousFetch = globalThis.fetch;
  globalThis.self = {
    addEventListener(type, handler) {
      if (type === "message") onMessage = handler;
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    redirected: true,
    url: "https://example.cloudflareaccess.com/cdn-cgi/access/login",
  });
  context.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
    globalThis.fetch = previousFetch;
  });

  await import("../public/search-worker.js?access-expiry-test");
  await onMessage({ data: { type: "init", id: 1 } });
  assert.deepEqual(messages.at(-1), {
    type: "error",
    id: 1,
    code: "access_expired",
    message: "Cloudflare Access session expired",
  });
});
