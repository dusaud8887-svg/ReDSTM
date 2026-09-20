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

export function boardSelectLabel(board, fallbackId = "") {
  return boardDisplayName(board, fallbackId) || fallbackId;
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
  if (readingCount > 0 || (finishedCount > 0 && finishedCount < availableCount)) return "reading";
  if (availableCount > 0 && finishedCount >= availableCount) return "finished";
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
}) {
  const total = Number(entryCount) || 0;
  const unavailable = Math.max(0, Number(unavailableCount) || 0);
  const available = Math.max(0, total - Math.min(unavailable, total));
  const occupancy = collectionOccupancy({
    availableCount: available,
    finishedCount,
    readingCount,
  });
  const gap = unavailable ? `${unavailable.toLocaleString("ko-KR")}편 보존 불가` : "";
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
  const resumePosition = continueTarget?.kind === "resume" ? continueTarget.entry.position : null;
  const nextPosition = continueTarget?.kind === "next" ? continueTarget.entry.position : null;
  return {
    occupancy,
    progress: `${finishedCount.toLocaleString("ko-KR")}/${available.toLocaleString("ko-KR")}편`,
    action: resumePosition ? `${resumePosition}편 이어 읽기` : nextPosition ? `다음 ${nextPosition}편` : "이어 읽기",
    gap,
  };
}
