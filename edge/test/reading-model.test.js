import assert from "node:assert/strict";
import test from "node:test";

import { postIdentity } from "../public/user-state.js";
import {
  boardDisplayName,
  boardGroupLabel,
  collectionAvailableCount,
  collectionContinueTarget,
  collectionOccupancy,
  collectionRowCopy,
  formatSourceDate,
  postReadingLabel,
  postReadingState,
} from "../public/reading-model.js";

const entry = (position, id, available = true) => ({
  position,
  board_id: "board_a",
  external_post_id: id,
  title: `${position}편`,
  object_key: available ? `posts/board_a/${id}-${"a".repeat(64)}.json.zst` : null,
});

function historyMap(records) {
  return new Map(Object.entries(records).map(([identity, value]) => [identity, value]));
}

test("classifies progress as unread, reading, or finished", () => {
  assert.equal(postReadingState(undefined), "unread");
  assert.equal(postReadingState(0), "unread");
  assert.equal(postReadingState(0.01), "reading");
  assert.equal(postReadingState(0.63), "reading");
  assert.equal(postReadingState(0.94), "reading");
  assert.equal(postReadingState(0.95), "finished");
  assert.equal(postReadingState(1), "finished");
  assert.equal(postReadingLabel(0, { seen: true }), "처음만 봄");
  assert.equal(postReadingLabel(0.63), "63%");
  assert.equal(postReadingLabel(0.95), "완료");
});

test("formats source dates without inventing a time zone shift", () => {
  assert.equal(formatSourceDate("2026-08-02"), "2026.08.02");
  assert.equal(formatSourceDate("2026-08-02 23:08"), "2026.08.02 23:08");
  assert.equal(formatSourceDate("2026.08.02 5:4"), "2026.08.02 05:04");
  assert.equal(formatSourceDate("원문 표기"), "원문 표기");
  assert.equal(formatSourceDate(""), "");
});

test("uses a human board name and falls back to the id", () => {
  assert.equal(boardDisplayName({ board_id: "write_free21", name: "떠돌이개" }), "떠돌이개");
  assert.equal(boardDisplayName({ board_id: "aa_19", name: "aa_19" }), "aa_19");
  assert.equal(boardDisplayName(null, "board_a"), "board_a");
  assert.equal(boardGroupLabel("aa"), "AA");
  assert.equal(boardGroupLabel("창작"), "창작");
  assert.equal(boardGroupLabel(""), "기타");
});

test("resumes the latest unfinished episode instead of the first unread gap", () => {
  const entries = [entry(1, 1), entry(2, 99, false), entry(3, 2)];
  const skipped = historyMap({
    [postIdentity(entries[2])]: { readAt: "2026-08-02T10:00:00Z", progress: 0.63 },
  });
  const resume = collectionContinueTarget(entries, skipped);
  assert.equal(resume.kind, "resume");
  assert.equal(resume.entry.position, 3);

  const finishedLatest = historyMap({
    [postIdentity(entries[0])]: { readAt: "2026-08-01T00:00:00Z", progress: 0 },
    [postIdentity(entries[2])]: { readAt: "2026-08-02T10:00:00Z", progress: 0.95 },
  });
  const done = collectionContinueTarget(entries, finishedLatest);
  assert.equal(done.kind, "finished");
  assert.equal(done.entry.position, 3);

  const finishedMoreRecently = historyMap({
    [postIdentity(entries[0])]: { readAt: "2026-08-02T10:00:00Z", progress: 0.95 },
    [postIdentity(entries[2])]: { readAt: "2026-08-01T00:00:00Z", progress: 0.63 },
  });
  const olderUnfinished = collectionContinueTarget(entries, finishedMoreRecently);
  assert.equal(olderUnfinished.kind, "resume");
  assert.equal(olderUnfinished.entry.position, 3);
});

test("continues at the current 63% chapter, then the next available after 95%", () => {
  const entries = [entry(1, 1), entry(2, 99, false), entry(3, 2)];
  const reading = historyMap({
    [postIdentity(entries[0])]: { readAt: "2026-07-12T00:00:00Z", progress: 0.63 },
  });
  const current = collectionContinueTarget(entries, reading);
  assert.equal(current.kind, "resume");
  assert.equal(current.entry.position, 1);

  const finishedFirst = historyMap({
    [postIdentity(entries[0])]: { readAt: "2026-07-12T00:00:00Z", progress: 0.95 },
  });
  const next = collectionContinueTarget(entries, finishedFirst);
  assert.equal(next.kind, "next");
  assert.equal(next.entry.position, 3);
});

test("starts at the first available episode when nothing has been opened", () => {
  const entries = [entry(1, 1), entry(2, 99, false), entry(3, 2)];
  const target = collectionContinueTarget(entries, new Map());
  assert.equal(target.kind, "start");
  assert.equal(target.entry.position, 1);
  assert.equal(collectionContinueTarget([], new Map()).kind, "empty");
});

test("describes collection occupancy for list rows", () => {
  assert.equal(collectionOccupancy({ availableCount: 2, finishedCount: 0, readingCount: 0 }), "unread");
  assert.equal(collectionOccupancy({ availableCount: 2, finishedCount: 1, readingCount: 0 }), "reading");
  assert.equal(collectionOccupancy({ availableCount: 2, finishedCount: 0, readingCount: 1 }), "reading");
  assert.equal(collectionOccupancy({ availableCount: 2, finishedCount: 2, readingCount: 0 }), "finished");
  assert.deepEqual(collectionRowCopy({ entryCount: 48 }), {
    occupancy: "unread", progress: "48편", action: "시작하기", gap: "",
  });
  assert.deepEqual(collectionRowCopy({
    entryCount: 48, finishedCount: 12, readingCount: 0,
    continueTarget: { kind: "next", entry: { position: 13 } },
  }), {
    occupancy: "reading", progress: "12/48편", action: "다음 13편", gap: "",
  });
  assert.deepEqual(collectionRowCopy({ entryCount: 48, finishedCount: 48 }), {
    occupancy: "finished", progress: "48/48편", action: "다시 보기", gap: "",
  });
  assert.equal(collectionAvailableCount({ entry_count: 3, unavailable_count: 1 }), 2);
  assert.deepEqual(collectionRowCopy({
    entryCount: 3, unavailableCount: 1, finishedCount: 2,
  }), {
    occupancy: "finished", progress: "2/2편", action: "다시 보기", gap: "1편 보존 불가",
  });
  assert.deepEqual(collectionRowCopy({
    entryCount: 3, unavailableCount: 1, readingCount: 1,
    continueTarget: { kind: "resume", entry: { position: 3 } },
  }), {
    occupancy: "reading", progress: "0/2편", action: "3편 이어 읽기", gap: "1편 보존 불가",
  });
  assert.equal(collectionOccupancy({ availableCount: 0, finishedCount: 0, readingCount: 0 }), "empty");
  assert.deepEqual(collectionRowCopy({ entryCount: 2, unavailableCount: 2 }), {
    occupancy: "empty", progress: "2편", action: "본문 없음", gap: "2편 보존 불가",
  });
  assert.deepEqual(collectionRowCopy({
    entryCount: 3, unavailableCount: 0, finishedCount: 1,
    continueTarget: { kind: "finished", entry: { position: 3 } },
  }), {
    occupancy: "reading", progress: "1/3편", action: "앞쪽 미독 2편", gap: "",
  });
  assert.deepEqual(collectionRowCopy({ entryCount: 48, unknown: true }), {
    occupancy: "unknown", progress: "48편", action: "읽기 상태 미확인", gap: "",
  });
});
