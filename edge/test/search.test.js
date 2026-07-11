import assert from "node:assert/strict";
import test from "node:test";

import { SEARCH_FIELDS, prepareSearch, searchPosts } from "../public/search-core.js";

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
  assert.deepEqual(searchPosts(index, { query: "fate 달빛" }).map((post) => post.external_post_id), [3]);
  assert.deepEqual(searchPosts(index, { query: "작가", boardId: "aa" }).map((post) => post.external_post_id), [2]);
  assert.deepEqual(searchPosts(index, { limit: 2 }).map((post) => post.external_post_id), [3, 2]);
  assert.equal(searchPosts(index, { limit: 1 })[0].object_key, `posts/write/3-${"a".repeat(64)}.json.zst`);
  assert.throws(() => searchPosts(index, { limit: 0 }), /between 1 and 200/);
  assert.throws(() => prepareSearch({ ...payload, fields: [] }), /schema/);
});
