import assert from "node:assert/strict";
import test from "node:test";
import { migrateNovelState, parseTitle, serialWorks } from "../public/text-work.js";

test("migrates reading progress and bookmarks from old linked-work URLs", () => {
  const state = {
    history: {
      "novel:novel:toki:63670:8794077": { readAt: "2026-09-20T00:00:00Z", progress: 0.5 },
      "novel:novel:linked:abc:8794077": { readAt: "2026-09-21T00:00:00Z", progress: 0.8 },
    },
    bookmarks: {
      "novel:novel:toki:63670:8794077": { savedAt: "2026-09-20T00:00:00Z", lane: "novel" },
    },
  };
  const work = { work_id: "novel:linked:abc", legacy_work_ids: ["novel:toki:63670"] };

  assert.equal(migrateNovelState(state, [work]), true);
  assert.deepEqual(state.history["novel:novel:linked:abc:8794077"], {
    readAt: "2026-09-21T00:00:00Z", progress: 0.8,
  });
  assert.equal("novel:novel:toki:63670:8794077" in state.history, false);
  assert.equal(state.bookmarks["novel:novel:linked:abc:8794077"].work, work);
  assert.equal("novel:novel:toki:63670:8794077" in state.bookmarks, false);
  assert.equal(migrateNovelState(state, [work]), false);
});

test("parseTitle matches crawler.collections.parse_title", () => {
  assert.deepEqual(parseTitle("[연재] Ｆａｔｅ： 달빛 2화"), {
    base: "fate: 달빛", label: "2화", order: [0, 0, 1, 2, 2],
  });
  assert.equal(parseTitle("작품 (리메이크) 2화").base, "작품 (리메이크)");
  assert.equal(parseTitle("연감 2026").order, null);
  assert.equal(parseTitle("대담한 합성 (Worm/The Gamer) 2부 파트 16").order, null);
  assert.deepEqual(parseTitle("기나긴 서사 프롤로그").order, [0, 0, 0, 0, 0]);
});

test("serial groups follow preview_collections membership and order", () => {
  const posts = [
    { board: "board", post_id: 2, title: "[연재] Ｆａｔｅ： 달빛 2화" },
    { board: "board", post_id: 1, title: "[연재] Fate: 달빛 1화" },
    { board: "board", post_id: 3, title: "마왕: 첫 작품 1화" },
    { board: "board", post_id: 4, title: "마왕: 다른 작품 2화" },
    { board: "board", post_id: 5, title: "작품 (리메이크) 1화" },
    { board: "board", post_id: 6, title: "작품 (리메이크) 2화" },
    { board: "board", post_id: 7, title: "중복 작품 1화" },
    { board: "board", post_id: 8, title: "중복 작품 1화" },
    { board: "board", post_id: 9, title: "연감 2026" },
    { board: "board", post_id: 10, title: "기나긴 서사 프롤로그" },
    { board: "board", post_id: 11, title: "기나긴 서사 1화" },
    { board: "board", post_id: 12, title: "기나긴 서사 에필로그" },
    { board: "board", post_id: 13, title: "기나긴 서사" },
    { board: "board", post_id: 14, title: "[연재] Fate: 달빛" },
  ];
  const { works, loose } = serialWorks(posts);
  assert.deepEqual(works.map((work) => work.posts.map((post) => post.post_id)), [
    [1, 2],
    [10, 11, 12],
    [5, 6],
  ]);
  assert.deepEqual(loose.map((post) => post.post_id), [3, 4, 7, 8, 9, 13, 14]);
});
