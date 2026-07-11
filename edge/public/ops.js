const labels = {
  idle: "대기 중", running: "작업 중", degraded: "확인 필요", failed: "실패",
  stale: "신호 끊김", paused: "일시정지", succeeded: "성공", partial: "일부 완료",
  queued: "대기", claimed: "수락됨", expired: "만료", cancelled: "취소됨",
  scheduled: "예약 실행", "manual-sync": "수동 동기화", retry: "재시도", publish: "게시",
};
const warningLabels = {
  auth_failed: "원본 인증을 확인해야 합니다.", parse_drift: "원본 구조 변경이 감지됐습니다.",
  rate_limited: "원본 서버의 속도 제한으로 감속했습니다.", site_unreachable: "원본 서버에 도달하지 못했습니다.",
  disk_low: "Oracle 저장 공간이 부족합니다.", token_expiring: "runner 인증 갱신이 필요합니다.",
  publish_stale: "새 보존본 게시가 지연되고 있습니다.", backup_stale: "복구 증거가 오래됐습니다.",
};
const commandCopy = {
  "sync-now": ["지금 동기화", "46개 게시판을 순차적으로 한 번 확인합니다. 원본 요청 간격은 빨라지지 않습니다."],
  "retry-batch": ["재시도 처리", "처리 시각이 된 실패 항목을 우선순위대로 최대 100건 다시 확인합니다."],
  "publish-if-changed": ["변경분 게시", "변경 marker가 있고 하루 게시 window가 열렸을 때만 검증 후 pointer를 바꿉니다."],
  "pause-after-current": ["현재 작업 뒤 일시정지", "진행 중 요청과 저장은 끝낸 뒤 다음 예약 실행을 멈춥니다."],
  "resume-schedule": ["예약 재개", "일시정지 marker만 해제합니다. 새 작업을 즉시 시작하지는 않습니다."],
};

const byId = (id) => document.getElementById(id);
const terminal = new Set(["succeeded", "partial", "failed", "expired", "cancelled"]);
let runsCursor = null;
let boardsCursor = null;
let selectedAction = null;

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = String(value);
  return element;
}

function time(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function age(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "확인 전";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

function shortId(value) {
  return typeof value === "string" && value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value || "—";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("X-Request-Id", crypto.randomUUID());
  headers.set("X-ReDSTM-Protocol", "1");
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.code || `http_${response.status}`);
  }
  return payload.data;
}

function overallState(runner, latestRun) {
  if (!runner?.heartbeat_at) return ["stale", "runner 신호가 아직 없습니다."];
  const heartbeatAge = Date.now() - Date.parse(runner.heartbeat_at);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > 180_000) return ["stale", "마지막 신호가 3분보다 오래됐습니다."];
  if (runner.safe_warning_code) return ["degraded", warningLabels[runner.safe_warning_code] || "운영 경고가 있습니다."];
  if (latestRun?.state === "failed") return ["failed", "최근 실행이 실패했습니다. 실행 기록을 확인하세요."];
  return [runner.state || "idle", runner.state === "running" ? "Oracle이 보존 작업을 수행하고 있습니다." : "지금 사용자가 처리할 긴급 작업은 없습니다."];
}

function renderOverview(data) {
  const runner = data.runner;
  const latest = data.latest_run;
  const [state, reason] = overallState(runner, latest);
  byId("overview-title").textContent = labels[state] || state;
  byId("overview-reason").textContent = reason;
  byId("overview-kicker").textContent = `RUNNER STATE / ${state.toUpperCase()}`;
  byId("status-signal").dataset.state = state;
  byId("last-heartbeat").textContent = runner?.heartbeat_at ? `${age(runner.heartbeat_at)} · ${time(runner.heartbeat_at)}` : "신호 없음";
  byId("active-step").textContent = runner?.active_step || runner?.state || "—";
  byId("next-schedule").textContent = time(runner?.next_scheduled_at);
  byId("disk-free").textContent = Number.isFinite(runner?.disk_free_bytes) ? `${(runner.disk_free_bytes / 2 ** 30).toFixed(1)} GiB` : "—";
  const warning = runner?.safe_warning_code;
  byId("warning-line").hidden = !warning;
  byId("warning-label").textContent = warningLabels[warning] || warning || "";
  byId("active-title").textContent = latest ? `${labels[latest.kind] || latest.kind} · ${labels[latest.state] || latest.state}` : "최근 실행 없음";
  byId("latest-start").textContent = time(latest?.started_at);
  byId("latest-changed").textContent = String(latest?.changed_posts ?? 0);
  byId("latest-failed").textContent = String(latest?.failed_posts ?? 0);
  byId("active-commands").textContent = String(data.active_commands ?? 0);
}

function runRow(run) {
  const row = node("article", "run-row");
  const state = node("span", "run-state", labels[run.state] || run.state);
  state.dataset.state = run.state;
  const identity = node("div", "run-id");
  identity.append(node("strong", "", labels[run.kind] || run.kind), node("small", "", shortId(run.run_id)));
  const changed = node("div", "run-metric");
  changed.append(node("strong", "", run.changed_posts), node("small", "", "변경"));
  const failed = node("div", "run-metric");
  failed.append(node("strong", "", run.failed_posts), node("small", "", "실패"));
  const boards = node("div", "run-metric");
  boards.append(node("strong", "", `${run.boards_ok}/${run.boards_ok + run.boards_failed}`), node("small", "", "게시판"));
  const started = node("div", "run-metric");
  started.append(node("strong", "", age(run.started_at)), node("small", "", time(run.started_at)));
  row.append(state, identity, changed, failed, boards, started);
  return row;
}

async function loadRuns(append = false) {
  const data = await api(`/api/v1/ops/runs?limit=20${append && runsCursor ? `&cursor=${encodeURIComponent(runsCursor)}` : ""}`);
  const list = byId("runs-list");
  if (!append) list.replaceChildren();
  if (!data.items.length && !append) list.append(node("p", "empty-row", "아직 기록된 실행이 없습니다."));
  for (const run of data.items) list.append(runRow(run));
  runsCursor = data.next_cursor;
  byId("runs-more").hidden = !runsCursor;
}

function boardRow(board) {
  const row = document.createElement("tr");
  const values = [board.board_id, labels[board.last_outcome] || board.last_outcome || "확인 전", time(board.last_scanned_at), board.discovered, board.changed, board.pending, board.retry, board.dead];
  values.forEach((value, index) => {
    const cell = node("td", index === 1 ? "state-text" : "", value);
    if (index === 1) cell.dataset.state = board.last_outcome || "unknown";
    row.append(cell);
  });
  return row;
}

async function loadBoards(append = false) {
  const data = await api(`/api/v1/ops/boards?limit=50${append && boardsCursor ? `&cursor=${encodeURIComponent(boardsCursor)}` : ""}`);
  const body = byId("boards-body");
  if (!append) body.replaceChildren();
  if (!data.items.length && !append) {
    const row = document.createElement("tr");
    const cell = node("td", "empty-row", "아직 게시판 상태가 없습니다.");
    cell.colSpan = 8;
    row.append(cell);
    body.append(row);
  }
  for (const board of data.items) body.append(boardRow(board));
  boardsCursor = data.next_cursor;
  byId("boards-more").hidden = !boardsCursor;
}

function renderReleases(data) {
  byId("release-current").textContent = shortId(data.current?.release_id);
  byId("release-current-time").textContent = time(data.current?.activated_at);
  byId("release-previous").textContent = data.previous ? shortId(data.previous.release_id) : "기록 없음";
  byId("release-previous-time").textContent = time(data.previous?.activated_at);
  const counts = byId("release-counts");
  counts.replaceChildren();
  const names = { post_count: "글", comment_count: "댓글", board_count: "게시판", collection_count: "모음" };
  for (const [key, label] of Object.entries(names)) {
    const item = document.createElement("div");
    item.append(node("dt", "", label), node("dd", "", (data.current?.counts?.[key] ?? 0).toLocaleString("ko-KR")));
    counts.append(item);
  }
}

function showError(error) {
  const banner = byId("error-banner");
  banner.hidden = false;
  banner.textContent = `Operations 일부를 불러오지 못했습니다 · ${error instanceof Error ? error.message : "unknown"}`;
}

async function loadAll() {
  byId("refresh").disabled = true;
  byId("error-banner").hidden = true;
  const results = await Promise.allSettled([
    api("/api/v1/ops/overview").then(renderOverview),
    loadRuns(),
    loadBoards(),
    api("/api/v1/ops/releases").then(renderReleases),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) showError(failure.reason);
  byId("updated-at").textContent = `확인 ${new Intl.DateTimeFormat("ko-KR", { timeStyle: "medium" }).format(new Date())}`;
  byId("refresh").disabled = false;
}

function renderCommand(command) {
  const result = byId("command-result");
  result.hidden = false;
  result.replaceChildren(node("span", "", `${commandCopy[command.action]?.[0] || command.action} · ${labels[command.state] || command.state} · ${command.command_id} · 만료 ${time(command.expires_at)}`));
  if (command.state === "queued") {
    const cancel = node("button", "", "대기 명령 취소");
    cancel.type = "button";
    cancel.addEventListener("click", () => { void cancelCommand(command).catch(showError); });
    result.append(cancel);
  }
}

async function cancelCommand(command) {
  const cancelled = await api(`/api/v1/ops/commands/${command.command_id}`, {
    method: "DELETE",
    headers: {
      "Idempotency-Key": `cancel-${crypto.randomUUID()}`,
      "X-ReDSTM-Command": "1",
    },
  });
  renderCommand(cancelled);
}

async function watchCommand(command) {
  renderCommand(command);
  for (let attempt = 0; attempt < 20 && !terminal.has(command.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    command = await api(`/api/v1/ops/commands/${command.command_id}`);
    renderCommand(command);
  }
  await Promise.allSettled([api("/api/v1/ops/overview").then(renderOverview), loadRuns()]);
}

async function createCommand(action) {
  const command = await api("/api/v1/ops/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `web-${crypto.randomUUID()}`,
      "X-ReDSTM-Command": "1",
    },
    body: JSON.stringify({ action, args: {} }),
  });
  await watchCommand(command);
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedAction = button.dataset.action;
    const [title, impact] = commandCopy[selectedAction];
    byId("dialog-title").textContent = title;
    byId("dialog-impact").textContent = impact;
    byId("command-dialog").showModal();
  });
});
byId("command-dialog").addEventListener("close", () => {
  if (byId("command-dialog").returnValue === "confirm" && selectedAction) {
    createCommand(selectedAction).catch(showError);
  }
  selectedAction = null;
});
byId("refresh").addEventListener("click", () => { void loadAll(); });
byId("runs-more").addEventListener("click", () => { void loadRuns(true).catch(showError); });
byId("boards-more").addEventListener("click", () => { void loadBoards(true).catch(showError); });
void loadAll();
setInterval(() => { if (!document.hidden) void loadAll(); }, 60_000);
