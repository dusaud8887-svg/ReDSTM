import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_FIELDS, findPost, prepareSearch, searchPosts } from "../public/search-core.js";

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
  assert.deepEqual(searchPosts(index, { limit: 2 }).posts.map((post) => post.external_post_id), [3, 2]);
  assert.deepEqual(searchPosts(index, { sort: "oldest" }).posts.map((post) => post.external_post_id), [1, 2, 3]);
  assert.deepEqual(searchPosts(index, { category: "팬픽" }).posts.map((post) => post.external_post_id), [3]);
  assert.throws(() => searchPosts(index, { mode: "aa" }), /unavailable/);
  assert.equal(searchPosts(index, { limit: 1 }).total, 3);
  assert.equal(searchPosts(index, { limit: 1 }).posts[0].object_key, `posts/write/3-${"a".repeat(64)}.json.zst`);
  assert.equal(searchPosts(index, { limit: 1 }).posts[0].is_aa, undefined);
  assert.equal(findPost(index, "aa", 2)?.title, "달빛 아래");
  assert.equal(findPost(index, "aa", 99), null);
  assert.throws(() => searchPosts(index, { limit: 0 }), /between 1 and 200/);
  assert.throws(() => searchPosts(index, { mode: "unknown" }), /mode/);
  assert.throws(() => searchPosts(index, { sort: "unknown" }), /sort/);
  assert.throws(() => prepareSearch({ ...payload, fields: [] }), /schema/);
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

  await onMessage({ data: { type: "search", id: 2, limit: 1 } });
  assert.equal(messages.at(-1).posts.length, 1);
  assert.equal(messages.at(-1).total, 7);

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
