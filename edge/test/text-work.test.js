import assert from "node:assert/strict";
import test from "node:test";
import {
  compactTextHistory, trimTextState,
  arcaliveBody, migrateNovelChapterState, migrateNovelState, novelBody, novelRecordWorkId, orderChapters,
} from "../public/text-work.js";

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

test("lifts the Newtomi novel wrapper out of the body", () => {
  const body = "# 1화\n# https://blacktoon452.com/novel/24753/914174\n\n　첫 문단\n\n둘째 문단\n";
  assert.deepEqual(novelBody(body), {
    text: "　첫 문단\n\n둘째 문단\n",
    sourceUrl: "https://blacktoon452.com/novel/24753/914174",
  });
  assert.deepEqual(novelBody("# 제목\n#\nhttps://toki31.com/novel/1/2\n\n본문"), {
    text: "본문",
    sourceUrl: "https://toki31.com/novel/1/2",
  });
  // Oracle bodies and other "#" lines stay as they are.
  assert.deepEqual(novelBody("본문만 있다\n"), { text: "본문만 있다\n", sourceUrl: "" });
  assert.deepEqual(novelBody("# 장 제목\n본문"), { text: "# 장 제목\n본문", sourceUrl: "" });
});

test("keeps the Arcalive body after its front matter", () => {
  const post = "# 제목\n\n- channel: novel\n- url: https://arca.live/b/novel/108\n\n---\n\n본문\n";
  assert.deepEqual(arcaliveBody(post), { text: "본문\n", sourceUrl: "https://arca.live/b/novel/108" });
});

test("old text records shrink to what progress needs; the latest per work keeps its detail", () => {
  const full = (readAt, progress, extra = {}) => ({
    readAt, progress, route: "/text?lane=novel", listRoute: "/text?lane=novel&work=w", title: "1화", work: "작품",
    total: 10, anchor: "문장", offset: 5, anchorTop: 1, scroll: 900, revision: "a".repeat(64), chapterId: "1",
    workId: "novel:a", ...extra,
  });
  const history = {
    "novel:novel:a:1": full("2026-09-01T00:00:00Z", 1),
    "novel:novel:a:2": full("2026-09-02T00:00:00Z", 0.123456),
    "novel:novel:a:3": full("2026-09-03T00:00:00Z", 0.5),
    "novel:novel:b:1": full("2026-08-01T00:00:00Z", 1, { workId: "novel:b" }),
  };
  assert.equal(compactTextHistory(history, { keepRecent: 0 }), true);
  // Finished and old: only when and how far.
  assert.deepEqual(history["novel:novel:a:1"], { readAt: "2026-09-01T00:00:00Z", progress: 1 });
  // Unfinished and old: keeps its position for 이어 읽기 inside the chapter.
  assert.deepEqual(history["novel:novel:a:2"], {
    readAt: "2026-09-02T00:00:00Z", progress: 0.123, anchor: "문장", offset: 5, anchorTop: 1, scroll: 900,
    revision: "a".repeat(64), chapterId: "1",
  });
  // The latest record of each work is untouched.
  assert.equal(history["novel:novel:a:3"].route, "/text?lane=novel");
  assert.equal(history["novel:novel:b:1"].total, 10);
  assert.equal(compactTextHistory(history, { keepRecent: 0 }), false);

  const state = { history: {}, bookmarks: { keep: { savedAt: "x" } } };
  for (let index = 0; index < 100; index += 1) {
    state.history[`novel:w:${index}`] = { readAt: `2026-09-01T00:00:${String(index % 60).padStart(2, "0")}Z`, progress: 1 };
  }
  const removed = trimTextState(state, 2000);
  assert.ok(removed > 0);
  assert.ok(JSON.stringify(state).length <= 2000);
  assert.deepEqual(state.bookmarks, { keep: { savedAt: "x" } });
});
