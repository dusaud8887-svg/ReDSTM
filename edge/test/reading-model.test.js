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
  readingMinutes,
  readingTimeLabel,
  remainingTimeLabel,
  seededRandom,
  weightedPicks,
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

test("estimates reading time from characters, ignoring whitespace", () => {
  assert.equal(readingMinutes(""), 0);
  assert.equal(readingMinutes("   \n\t "), 0);
  assert.equal(readingMinutes("가"), 1);
  assert.equal(readingMinutes(`${"가 ".repeat(1500)}\n`), 3);
  assert.equal(readingTimeLabel(0), "");
  assert.equal(readingTimeLabel(12), "약 12분");
  assert.equal(readingTimeLabel(60), "약 1시간");
  assert.equal(readingTimeLabel(95), "약 1시간 35분");
});

test("seeded picks are stable for a day, change with the seed, and favour weight", () => {
  const first = seededRandom("2026-09-28");
  const again = seededRandom("2026-09-28");
  const values = Array.from({ length: 5 }, () => first());
  assert.deepEqual(Array.from({ length: 5 }, () => again()), values);
  assert.ok(values.every((value) => value >= 0 && value < 1));
  assert.notDeepEqual(Array.from({ length: 5 }, seededRandom("2026-09-29")), values);

  const items = Array.from({ length: 20 }, (_, index) => ({ id: index, weight: index === 7 ? 1000 : 1 }));
  const picks = weightedPicks(items, { seed: "2026-09-28", count: 3, weight: (item) => item.weight });
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map((item) => item.id)).size, 3);
  assert.deepEqual(weightedPicks(items, { seed: "2026-09-28", count: 3, weight: (item) => item.weight }), picks);
  // A heavily weighted item is picked on almost every seed.
  const hits = Array.from({ length: 50 }, (_, day) =>
    weightedPicks(items, { seed: `day-${day}`, count: 3, weight: (item) => item.weight }).some((item) => item.id === 7));
  assert.ok(hits.filter(Boolean).length >= 45);
  assert.deepEqual(weightedPicks([], { seed: "x", count: 3 }), []);
});

test("describes the time left in a body from its progress", () => {
  assert.equal(remainingTimeLabel(0, 0.5), "");
  assert.equal(remainingTimeLabel(10, 0), "남은 시간 약 10분");
  assert.equal(remainingTimeLabel(10, 0.42), "남은 시간 약 6분");
  assert.equal(remainingTimeLabel(10, 0.93), "1분 안에 끝");
  assert.equal(remainingTimeLabel(10, 0.95), "끝까지 읽음");
  assert.equal(remainingTimeLabel(10, 7), "끝까지 읽음");
});

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

test("the Home quote starts at the sentence holding the saved place and adds nothing", async () => {
  const { lastSentenceQuote } = await import("../public/reading-model.js");
  assert.equal(lastSentenceQuote(null), "");
  // The saved start is mid-sentence; the sentence began inside the saved context.
  assert.equal(lastSentenceQuote({ prefix: "문이 열렸다. 그녀는 오래된 ", exact: "책을 덮고 천천히 고개를", suffix: " 들었다.\n다음 줄" }),
    "그녀는 오래된 책을 덮고 천천히 고개를 들었다. 다음 줄");
  // The context starts mid-sentence: show from the saved start rather than a broken fragment.
  assert.equal(lastSentenceQuote({ prefix: "게 덮여 있었고", exact: " 약속한 사람은", suffix: " 오지 않았다." }), "약속한 사람은 오지 않았다.");
  assert.equal(lastSentenceQuote({ prefix: "", exact: "알겠어.", suffix: "" }), "알겠어.");
  assert.equal(lastSentenceQuote({ prefix: "", exact: "가".repeat(200), suffix: "" }).length, 120);
});
