import { postIdentity } from "./user-state.js";

export const FINISHED_PROGRESS = 0.95;

export function postReadingState(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value) || value <= 0) return "unread";
  if (value < FINISHED_PROGRESS) return "reading";
  return "finished";
}

export function postReadingLabel(progress, { seen = false } = {}) {
  const state = postReadingState(progress);
  if (state === "reading") return `${Math.round(Number(progress) * 100)}%`;
  if (state === "finished") return "완료";
  return seen ? "처음만 봄" : "";
}

// Silent reading of Korean prose runs at roughly 500 characters a minute; whitespace is not read.
const CHARACTERS_PER_MINUTE = 500;

export function readingMinutes(text) {
  const characters = String(text ?? "").replace(/\s+/g, "").length;
  return characters ? Math.max(1, Math.round(characters / CHARACTERS_PER_MINUTE)) : 0;
}

export function readingTimeLabel(minutes) {
  const value = Math.round(Number(minutes));
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 60) return `약 ${value}분`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `약 ${hours}시간 ${rest}분` : `약 ${hours}시간`;
}

// What is left of a body of `minutes` after reading `progress` (0–1) of it.
export function remainingTimeLabel(minutes, progress) {
  if (!(minutes > 0)) return "";
  const ratio = Math.min(1, Math.max(0, Number(progress) || 0));
  if (ratio >= FINISHED_PROGRESS) return "끝까지 읽음";
  const left = Math.ceil(minutes * (1 - ratio));
  return left <= 1 ? "1분 안에 끝" : `남은 시간 ${readingTimeLabel(left)}`;
}

// A repeatable random sequence for a text seed (FNV-1a hash into mulberry32), so a "today's
// pick" stays the same all day and on every device, and changes with the date.
export function seededRandom(text) {
  let state = 0x811c9dc5;
  for (const character of String(text)) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// `count` items drawn without replacement, each with probability proportional to weight(item)
// (Efraimidis–Spirakis keys), deterministic for a seed.
export function weightedPicks(items, { seed, count, weight = () => 1 }) {
  const random = seededRandom(seed);
  return items
    .map((item) => ({ item, key: random() ** (1 / Math.max(Number(weight(item)) || 0, 1e-6)) }))
    .sort((left, right) => right.key - left.key)
    .slice(0, count)
    .map(({ item }) => item);
}

export function formatSourceDate(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  const match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::\d{2})?)?/.exec(text);
  if (!match) return text;
  const date = `${match[1]}.${match[2].padStart(2, "0")}.${match[3].padStart(2, "0")}`;
  return match[4] == null ? date : `${date} ${match[4].padStart(2, "0")}:${match[5].padStart(2, "0")}`;
}

export function boardDisplayName(board, fallbackId = "") {
  const id = board?.board_id || fallbackId;
  const name = typeof board?.name === "string" ? board.name.trim() : "";
  if (name && name !== id) return name;
  return name || id;
}

export function boardGroupLabel(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "기타";
  return raw.toLowerCase() === "aa" ? "AA" : raw;
}

export function collectionContinueTarget(entries, historyByIdentity) {
  const available = (entries ?? []).filter((entry) => entry?.object_key);
  if (!available.length) return { kind: "empty", entry: null };

  const stamped = available
    .map((entry) => {
      const history = historyByIdentity.get(postIdentity(entry));
      return history ? { entry, history } : null;
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.history.readAt) - Date.parse(left.history.readAt));

  if (!stamped.length) return { kind: "start", entry: available[0] };

  const reading = stamped.find(({ history }) => postReadingState(history.progress) === "reading");
  if (reading) {
    return { kind: "resume", entry: reading.entry, progress: reading.history.progress ?? 0 };
  }

  const latest = stamped[0];
  if (postReadingState(latest.history.progress) === "unread") {
    return { kind: "resume", entry: latest.entry, progress: latest.history.progress ?? 0 };
  }
  const next = available.find((entry) => {
    if (entry.position <= latest.entry.position) return false;
    return postReadingState(historyByIdentity.get(postIdentity(entry))?.progress) !== "finished";
  });
  if (next) return { kind: "next", entry: next };
  return { kind: "finished", entry: latest.entry };
}

export function collectionOccupancy({ availableCount, finishedCount, readingCount }) {
  if (availableCount <= 0) return "empty";
  if (readingCount > 0 || (finishedCount > 0 && finishedCount < availableCount)) return "reading";
  if (finishedCount >= availableCount) return "finished";
  return "unread";
}

export function collectionAvailableCount(collection) {
  const total = Number(collection?.entry_count) || 0;
  const unavailable = Number.isInteger(collection?.unavailable_count) ? collection.unavailable_count : 0;
  return Math.max(0, total - Math.min(Math.max(0, unavailable), total));
}

export function collectionRowCopy({
  entryCount,
  unavailableCount = 0,
  finishedCount = 0,
  readingCount = 0,
  continueTarget = null,
  unknown = false,
}) {
  const total = Number(entryCount) || 0;
  const unavailable = Math.max(0, Number(unavailableCount) || 0);
  const available = Math.max(0, total - Math.min(unavailable, total));
  const gap = unavailable ? `${unavailable.toLocaleString("ko-KR")}편 보존 불가` : "";
  if (unknown) {
    return {
      occupancy: "unknown",
      progress: `${available.toLocaleString("ko-KR")}편`,
      action: "읽기 상태 미확인",
      gap,
    };
  }
  const occupancy = collectionOccupancy({
    availableCount: available,
    finishedCount,
    readingCount,
  });
  if (occupancy === "empty") {
    return { occupancy, progress: `${total.toLocaleString("ko-KR")}편`, action: "본문 없음", gap };
  }
  if (occupancy === "unread") {
    return {
      occupancy,
      progress: `${total.toLocaleString("ko-KR")}편`,
      action: "시작하기",
      gap,
    };
  }
  if (occupancy === "finished") {
    return {
      occupancy,
      progress: `${available.toLocaleString("ko-KR")}/${available.toLocaleString("ko-KR")}편`,
      action: "다시 보기",
      gap,
    };
  }
  const skipped = Math.max(0, available - finishedCount - readingCount);
  if (continueTarget?.kind === "finished") {
    return {
      occupancy,
      progress: `${finishedCount.toLocaleString("ko-KR")}/${available.toLocaleString("ko-KR")}편`,
      action: skipped ? `앞쪽 미독 ${skipped.toLocaleString("ko-KR")}편` : "다음 편 없음",
      gap,
    };
  }
  const resumePosition = continueTarget?.kind === "resume" ? continueTarget.entry.position : null;
  const nextPosition = continueTarget?.kind === "next" ? continueTarget.entry.position : null;
  return {
    occupancy,
    progress: `${finishedCount.toLocaleString("ko-KR")}/${available.toLocaleString("ko-KR")}편`,
    action: resumePosition ? `${resumePosition}편 이어 읽기` : nextPosition ? `다음 ${nextPosition}편` : "이어 읽기",
    gap,
  };
}
