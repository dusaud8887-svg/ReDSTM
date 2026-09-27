import assert from "node:assert/strict";
import test from "node:test";
import { migrateNovelState, orderChapters } from "../public/text-work.js";

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
