const labels = {
  idle: "대기 중", running: "작업 중", degraded: "확인 필요", failed: "실패",
  stale: "응답 없음", not_enrolled: "연결 대기", paused: "일시정지", succeeded: "성공", partial: "일부 완료",
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
let lastRunner = null;
let lastState = "not_enrolled";
let lastActiveCommands = 0;
const pendingActions = new Set();
const commandKeys = new Map();

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
  if (!runner?.heartbeat_at) return ["not_enrolled", "Runner가 아직 상태를 보고하지 않았습니다. 초기 연결을 확인하세요."];
  const heartbeatAge = Date.now() - Date.parse(runner.heartbeat_at);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > 180_000) return ["stale", "마지막 신호가 3분보다 오래됐습니다. Reader는 활성 보존본으로 계속 사용할 수 있습니다."];
  if (runner.state === "paused") return ["paused", "예약 실행이 일시정지되어 있습니다."];
  if (runner.safe_warning_code) return ["degraded", warningLabels[runner.safe_warning_code] || "운영 경고가 있습니다."];
  if (latestRun?.state === "partial") return ["degraded", "최근 실행이 일부 완료됐습니다. 실행 기록을 확인하세요."];
  if (latestRun?.state === "failed") return ["failed", "최근 실행이 실패했습니다. 실행 기록을 확인하세요."];
  return [runner.state || "idle", runner.state === "running" ? "Oracle이 보존 작업을 수행하고 있습니다." : "지금 사용자가 처리할 긴급 작업은 없습니다."];
}

function updateControls(runner, state, activeCommands) {
  const unavailable = state === "stale" || state === "not_enrolled";
  const paused = runner?.state === "paused";
  const running = runner?.state === "running";
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    const copy = button.querySelector("small");
    copy.dataset.default ||= copy.textContent;
    let reason = copy.dataset.default;
    let disabled = pendingActions.has(action);
    if (pendingActions.has(action)) reason = "요청을 보내는 중입니다.";
    else if (unavailable) { disabled = true; reason = "Runner가 다시 연결된 뒤 요청할 수 있습니다."; }
    else if (running && action !== "pause-after-current") { disabled = true; reason = "현재 작업 중에는 이후 예약만 일시정지할 수 있습니다."; }
    else if (paused && action !== "resume-schedule") { disabled = true; reason = "예약이 일시정지되어 있습니다."; }
    else if (!paused && action === "resume-schedule") { disabled = true; reason = "일시정지 상태에서만 사용할 수 있습니다."; }
    button.disabled = disabled;
    copy.textContent = reason;
  }
  byId("control-summary").textContent = activeCommands
    ? `활성 명령 ${activeCommands}개 · 완료될 때까지 같은 작업을 다시 요청하지 마세요.`
    : "자동 실행이 기본입니다. 필요한 경우에만 고정된 작업을 요청합니다.";
}

function renderOverview(data) {
  const runner = data.runner;
  const latest = data.latest_run;
  const [state, reason] = overallState(runner, latest);
  const verdicts = {
    idle: "개입할 일 없음", running: "자동 보존 중", degraded: "확인 필요", failed: "실행 확인 필요",
    stale: "Runner 응답 없음", paused: "자동 실행 일시정지", not_enrolled: "Runner 연결 대기",
  };
  byId("overview-title").textContent = verdicts[state] || labels[state] || state;
  byId("overview-reason").textContent = reason;
  byId("overview-kicker").textContent = `${labels[state] || state} · Oracle runner`;
  byId("status-signal").dataset.state = state;
  const stale = state === "stale";
  byId("last-heartbeat").textContent = runner?.heartbeat_at ? `${age(runner.heartbeat_at)} · ${time(runner.heartbeat_at)}` : "— · 아직 보고되지 않음";
  byId("active-step-label").textContent = stale ? "마지막 보고 단계" : "현재 단계";
  byId("next-schedule-label").textContent = stale ? "마지막 보고 다음 실행" : "다음 실행";
  byId("disk-free-label").textContent = stale ? "마지막 보고 디스크" : "남은 디스크";
  byId("active-step").textContent = runner?.active_step || runner?.state || "—";
  byId("next-schedule").textContent = time(runner?.next_scheduled_at);
  byId("disk-free").textContent = Number.isFinite(runner?.disk_free_bytes) ? `${(runner.disk_free_bytes / 2 ** 30).toFixed(1)} GiB` : "—";
  const warning = runner?.safe_warning_code;
  byId("warning-line").hidden = !warning;
  byId("warning-label").textContent = warningLabels[warning] || warning || "";
  byId("active-title").textContent = latest ? `${labels[latest.kind] || latest.kind} · ${labels[latest.state] || latest.state}` : "아직 보고된 실행 없음";
  byId("active-reason").textContent = latest
    ? `${latest.source || "source 미보고"} · ${latest.finished_at ? `완료 ${time(latest.finished_at)}` : `시작 ${time(latest.started_at)}`}`
    : "자동 수집 전이거나 runner telemetry가 D1에 아직 연결되지 않았습니다.";
  byId("latest-start").textContent = time(latest?.started_at);
  byId("latest-changed").textContent = latest ? String(latest.changed_posts ?? 0) : "—";
  byId("latest-failed").textContent = latest ? String(latest.failed_posts ?? 0) : "—";
  byId("latest-boards").textContent = latest ? `${latest.boards_ok ?? 0}/${(latest.boards_ok ?? 0) + (latest.boards_failed ?? 0)}` : "—";
  lastRunner = runner;
  lastState = state;
  lastActiveCommands = Number(data.active_commands ?? 0);
  updateControls(lastRunner, lastState, lastActiveCommands);
}

function runRow(run) {
  const row = node("details", "run-entry");
  const summary = node("summary", "run-row");
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
  summary.append(state, identity, changed, failed, boards, started);
  const detail = node("div", "run-detail");
  detail.append(
    node("span", "", `출처 ${run.source || "—"}`),
    node("span", "", `최근 단계 ${run.latest_event?.step || "—"}`),
    node("span", "", run.latest_event?.safe_message || "추가 경고 없음"),
    node("span", "", `보고서 ${shortId(run.run_id)}`),
  );
  row.append(summary, detail);
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
  const row = node("article", "board-row");
  const identity = node("div", "board-identity");
  const outcome = node("small", "state-text", `${labels[board.last_outcome] || board.last_outcome || "결과 미보고"} · ${time(board.last_scanned_at)}`);
  outcome.dataset.state = board.last_outcome || "unknown";
  identity.append(node("strong", "", board.board_id), outcome);
  const metrics = node("dl", "board-metrics");
  const values = [["최근 발견", board.discovered], ["최근 변경", board.changed], ["현재 대기", board.pending], ["재시도 예정", board.retry], ["수동 확인", board.dead]];
  for (const [label, value] of values) {
    const item = document.createElement("div");
    item.append(node("dt", "", label), node("dd", "", value ?? "—"));
    metrics.append(item);
  }
  row.append(identity, metrics);
  if (board.warning_code) row.append(node("p", "board-warning", warningLabels[board.warning_code] || board.warning_code));
  return row;
}

async function loadBoards(append = false) {
  const data = await api(`/api/v1/ops/boards?limit=50${append && boardsCursor ? `&cursor=${encodeURIComponent(boardsCursor)}` : ""}`);
  const list = byId("boards-list");
  if (!append) list.replaceChildren();
  if (!data.items.length && !append) {
    list.append(node("p", "empty-row", "board 운영 telemetry가 아직 보고되지 않았습니다. 활성 릴리스의 게시판 수와는 별도 상태입니다."));
  }
  for (const board of data.items) list.append(boardRow(board));
  boardsCursor = data.next_cursor;
  byId("boards-more").hidden = !boardsCursor;
}

function renderReleases(data) {
  const available = Boolean(data.current?.release_id);
  byId("reader-continuity").dataset.state = available ? "available" : "unavailable";
  byId("reader-state").textContent = available ? "Reader 사용 가능" : "Reader 보존본 없음";
  byId("reader-release").textContent = available ? `활성 보존본 ${shortId(data.current.release_id)} · ${time(data.current.activated_at)}` : "활성 R2 보존본을 확인할 수 없습니다.";
  byId("release-current").textContent = available ? `사용 가능 · ${shortId(data.current.release_id)}` : "사용 불가";
  byId("release-current-time").textContent = time(data.current?.activated_at);
  byId("release-previous").textContent = data.previous ? shortId(data.previous.release_id) : "D1 metadata 없음";
  byId("release-previous-time").textContent = time(data.previous?.activated_at);
  const counts = byId("release-counts");
  counts.replaceChildren();
  const names = { post_count: "글", comment_count: "댓글", board_count: "게시판", collection_count: "모음" };
  for (const [key, label] of Object.entries(names)) {
    const item = document.createElement("div");
    const value = data.current?.counts?.[key];
    item.append(node("dt", "", label), node("dd", "", value == null ? "—" : value.toLocaleString("ko-KR")));
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
  if (results[3].status === "rejected") renderReleases({ current: null, previous: null });
  const failure = results.find((result) => result.status === "rejected");
  if (failure) showError(failure.reason);
  byId("updated-at").textContent = `화면 갱신 ${new Intl.DateTimeFormat("ko-KR", { timeStyle: "medium" }).format(new Date())}`;
  byId("refresh").disabled = false;
}

function renderCommand(command, background = false) {
  const result = byId("command-result");
  result.hidden = false;
  const message = `${commandCopy[command.action]?.[0] || command.action} · ${labels[command.state] || command.state} · ${command.command_id} · 만료 ${time(command.expires_at)}`;
  result.replaceChildren(node("span", "", background ? `${message} · 백그라운드에서 계속 실행 중` : message));
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
  if (!terminal.has(command.state)) renderCommand(command, true);
  await Promise.allSettled([api("/api/v1/ops/overview").then(renderOverview), loadRuns()]);
}

async function createCommand(action) {
  const key = commandKeys.get(action) || `web-${crypto.randomUUID()}`;
  commandKeys.set(action, key);
  pendingActions.add(action);
  updateControls(lastRunner, lastState, lastActiveCommands);
  let command;
  try {
    command = await api("/api/v1/ops/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-ReDSTM-Command": "1" },
      body: JSON.stringify({ action, args: {} }),
    });
    commandKeys.delete(action);
  } finally {
    pendingActions.delete(action);
    updateControls(lastRunner, lastState, lastActiveCommands);
  }
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
