import assert from "node:assert/strict";
import test from "node:test";

import {
  charactersRead, closeSpans, dailyReading, extendSpans, finishedWorks, heatLevel, localDay, minutesLabel, monthCells,
  readingStreak, unionLength, weekSummary, workReading,
} from "../public/stats.js";

const minute = 60_000;
const at = (day, hour, minutes = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`).getTime();

test("an input keeps reading active for a minute, and leaving the screen stops it", () => {
  const spans = [];
  extendSpans(spans, 0);
  extendSpans(spans, 30_000);
  assert.deepEqual(spans, [[0, 90_000]]);
  extendSpans(spans, 200_000);
  assert.deepEqual(spans, [[0, 90_000], [200_000, 260_000]]);
  closeSpans(spans, 210_000);
  assert.deepEqual(spans.at(-1), [200_000, 210_000]);
  assert.equal(unionLength(spans), 100_000);
});

test("the same moment in two tabs counts once", () => {
  const day = "2026-10-01";
  const sessions = [
    { day, spans: [[at(day, 9), at(day, 9, 30)]] },
    { day, spans: [[at(day, 9, 20), at(day, 9, 40)]] },
  ];
  assert.equal(dailyReading(sessions, at(day, 23)).get(day), 40 * minute);
});

test("a session belongs to the local day it started, and open spans stop at now", () => {
  const start = at("2026-10-01", 23, 50);
  const sessions = [{ day: localDay(start), spans: [[start, start + 30 * minute]] }];
  const later = start + 24 * 60 * minute;
  assert.equal(dailyReading(sessions, later).get("2026-10-01"), 30 * minute);
  assert.equal(dailyReading(sessions, later).get("2026-10-02"), undefined);
  assert.equal(dailyReading(sessions, start + 5 * minute).get("2026-10-01"), 5 * minute);
});

test("the streak counts back from today, or from yesterday before today's reading", () => {
  const daily = new Map([["2026-09-29", 1], ["2026-09-30", 1], ["2026-10-01", 1], ["2026-09-27", 1]]);
  assert.equal(readingStreak(daily, "2026-10-01"), 3);
  assert.equal(readingStreak(daily, "2026-10-02"), 3);
  assert.equal(readingStreak(daily, "2026-10-03"), 0);
});

test("the month heat map starts on Monday and grades minutes", () => {
  assert.equal(heatLevel(30_000), 0);
  assert.equal(heatLevel(5 * minute), 1);
  assert.equal(heatLevel(10 * minute), 2);
  assert.equal(heatLevel(45 * minute), 3);
  assert.equal(heatLevel(90 * minute), 4);
  const cells = monthCells(new Map([["2026-10-01", 12 * minute]]), 2026, 10);
  // 1 October 2026 is a Thursday: three empty cells first.
  assert.deepEqual(cells.slice(0, 4).map((cell) => cell?.date ?? null), [null, null, null, 1]);
  assert.equal(cells[3].level, 2);
  assert.equal(cells.filter(Boolean).length, 31);
});

test("this week runs Monday to Sunday", () => {
  const week = weekSummary(new Map([["2026-09-28", 20 * minute], ["2026-10-01", 30_000], ["2026-10-04", 5 * minute]]), "2026-10-01");
  assert.equal(week.days[0].day, "2026-09-28");
  assert.equal(week.days[6].day, "2026-10-04");
  assert.equal(week.total, 25 * minute + 30_000);
  assert.equal(week.activeDays, 2);
});

test("finished works, characters and one work's time come from the sessions", () => {
  const sessions = [
    { workKey: "a", endOfWork: true, chars: 1200, spans: [[0, 10 * minute]] },
    { workKey: "a", endOfWork: true, chars: -5, spans: [[5 * minute, 20 * minute]] },
    { workKey: "b", chars: 300, spans: [[0, minute]] },
  ];
  assert.equal(finishedWorks(sessions), 1);
  assert.equal(charactersRead(sessions), 1500);
  assert.equal(workReading(sessions, "a", Number.MAX_SAFE_INTEGER), 20 * minute);
  assert.equal(minutesLabel(45 * minute), "45분");
  assert.equal(minutesLabel(125 * minute), "2시간 5분");
  assert.equal(minutesLabel(120 * minute), "2시간");
});
