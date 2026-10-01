// Reading statistics (DESIGN §9). 읽은 시간(추정) is the time the Reader was on screen with a scroll,
// tap or key within the last 60 seconds; sessions in several tabs or devices at the same moment
// count once (union of their spans). A day is the device's local day of the session's start.
// 끝까지 읽음 means reaching the end of the last preserved chapter, not the work being finished.

export const IDLE_MS = 60_000;
export const HEAT_STEPS = [0, 10, 30, 60]; // minutes: 1–9 → 1, 10–29 → 2, 30–59 → 3, 60+ → 4

// An input at `time` keeps the session active for the next minute.
export function extendSpans(spans, time, idle = IDLE_MS) {
  const last = spans.at(-1);
  if (last && time <= last[1]) last[1] = Math.max(last[1], time + idle);
  else spans.push([time, time + idle]);
  return spans;
}

// The Reader left the screen (hidden tab, closed Reader, another document): stop counting there.
export function closeSpans(spans, time) {
  const last = spans.at(-1);
  if (last && last[1] > time) last[1] = Math.max(last[0], time);
  return spans;
}

export function unionLength(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  return current ? total + current[1] - current[0] : 0;
}

export function localDay(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Milliseconds read per local day; spans still open are cut at `now`.
export function dailyReading(sessions, now = Date.now()) {
  const byDay = new Map();
  for (const session of sessions) {
    if (!Array.isArray(session.spans)) continue;
    const spans = session.spans.map(([start, end]) => [start, Math.min(end, now)]);
    byDay.set(session.day, [...(byDay.get(session.day) ?? []), ...spans]);
  }
  return new Map([...byDay].map(([day, spans]) => [day, unionLength(spans)]));
}

function shiftDay(day, offset) {
  const [year, month, date] = day.split("-").map(Number);
  return localDay(new Date(year, month - 1, date + offset).getTime());
}

// Days in a row with reading, up to today (or up to yesterday when today has none yet).
export function readingStreak(daily, today) {
  let day = daily.get(today) ? today : shiftDay(today, -1);
  let count = 0;
  while (daily.get(day)) {
    count += 1;
    day = shiftDay(day, -1);
  }
  return count;
}

export function heatLevel(milliseconds) {
  const minutes = milliseconds / 60_000;
  if (minutes < 1) return 0;
  return HEAT_STEPS.filter((step) => minutes >= step).length;
}

// One month as calendar cells (Monday first), padded with nulls before the first day.
export function monthCells(daily, year, month) {
  const first = new Date(year, month - 1, 1);
  const days = new Date(year, month, 0).getDate();
  const cells = Array.from({ length: (first.getDay() + 6) % 7 }, () => null);
  for (let date = 1; date <= days; date += 1) {
    const day = localDay(new Date(year, month - 1, date).getTime());
    const milliseconds = daily.get(day) ?? 0;
    cells.push({ day, date, milliseconds, level: heatLevel(milliseconds) });
  }
  return cells;
}

// This week (Monday to Sunday) for the Home module: minutes per day and the total.
export function weekSummary(daily, today) {
  const [year, month, date] = today.split("-").map(Number);
  const monday = new Date(year, month - 1, date - ((new Date(year, month - 1, date).getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = localDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index).getTime());
    return { day, milliseconds: daily.get(day) ?? 0 };
  });
  return { days, total: days.reduce((sum, item) => sum + item.milliseconds, 0), activeDays: days.filter((item) => item.milliseconds >= 60_000).length };
}

export function finishedWorks(sessions) {
  return new Set(sessions.filter((session) => session.endOfWork && session.workKey).map((session) => session.workKey)).size;
}

export function charactersRead(sessions) {
  return sessions.reduce((sum, session) => sum + (Number.isFinite(session.chars) && session.chars > 0 ? session.chars : 0), 0);
}

// Time spent in one work (its sessions' union), for the work header.
export function workReading(sessions, workKey, now = Date.now()) {
  return unionLength(sessions.filter((session) => session.workKey === workKey && Array.isArray(session.spans))
    .flatMap((session) => session.spans.map(([start, end]) => [start, Math.min(end, now)])));
}

export function minutesLabel(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
}
