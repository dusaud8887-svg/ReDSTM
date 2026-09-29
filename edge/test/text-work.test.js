import assert from "node:assert/strict";
import test from "node:test";
import { migrateNovelChapterState, migrateNovelState, novelRecordWorkId, orderChapters } from "../public/text-work.js";

test("finds the work of a novel reading record with production-shaped ids", () => {
  const workId = "novel:1b2c3d4e-0000-4000-8000-000000000001";
  const key = `novel:${workId}:novel:bookkor:123:456`;
  const known = new Set([workId, "novel:other"]);
  assert.equal(novelRecordWorkId(key, {}, known), workId);
  // A record's own workId covers works missing from the loaded catalog; the key wins otherwise.
  assert.equal(novelRecordWorkId(key, { workId: "novel:renamed" }, new Set()), "novel:renamed");
  assert.equal(novelRecordWorkId(key, { workId: "novel:stale-alias" }, known), workId);
  assert.equal(novelRecordWorkId(key, {}, new Set()), null);
  assert.equal(novelRecordWorkId("arcalive:board:1:body", {}, known), null);
});

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

test("published reading order survives list sorting and misleading chapter labels", () => {
  const chapters = [{ label: "1화" }, { label: "제3화: 귀환" }, { label: "2화" }];
  assert.deepEqual(orderChapters(chapters, "oldest"), chapters);
  assert.deepEqual(orderChapters(chapters, "latest").map((row) => row.label),
    ["2화", "제3화: 귀환", "1화"]);
  assert.deepEqual(chapters.map((row) => row.label), ["1화", "제3화: 귀환", "2화"]);
});

test("chapter aliases restore progress and bookmarks across PC and Oracle IDs", () => {
  const oldPc = "novel:toki:63670:42";
  const oldOracle = "novel_chapter:toki:63670:42";
  const work = { work_id: "novel:stable", legacy_work_ids: ["novel:toki:63670"] };
  const chapter = { chapter_id: oldOracle, legacy_chapter_ids: [oldPc, oldOracle] };
  const current = `novel:${work.work_id}:${oldOracle}`;
  const state = {
    history: {
      [`novel:${work.work_id}:${oldPc}`]: { readAt: "2026-09-20T00:00:00Z", progress: 0.7 },
      [current]: { readAt: "2026-09-21T00:00:00Z", progress: 0.8 },
    },
    bookmarks: {
      [`novel:novel:toki:63670:${oldPc}`]: { savedAt: "2026-09-20T00:00:00Z" },
    },
  };
  assert.equal(migrateNovelChapterState(state, work, [chapter]), true);
  assert.equal(state.history[current].progress, 0.8);
  assert.equal(state.bookmarks[current].work, work);
  assert.equal(migrateNovelChapterState(state, work, [chapter]), false);
});
