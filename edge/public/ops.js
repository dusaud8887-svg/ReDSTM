const labels = {
  idle: "대기 중", running: "작업 중", degraded: "확인 필요", failed: "실패",
  stale: "응답 없음", not_enrolled: "연결 대기", paused: "일시정지", succeeded: "성공", partial: "일부 완료",
  queued: "대기", claimed: "수락됨", expired: "만료", cancelled: "취소됨",
  scheduled: "예약 실행", "manual-sync": "수동 동기화", retry: "재시도", publish: "게시",
  "bootstrap-recovery": "최초 본문 채우기",
  "full-catalog": "전체 목차", "full-content": "전체 본문",
};
const stepLabels = {
  idle: "대기", scheduled: "예약 준비", "sync-now": "최신 목록 확인",
  crawling: "상세 수집", inventory: "전체 목록 확인", recovery: "본문 대기 재시도",
  "full-catalog": "전체 목차 재수집", "full-content": "전체 본문 재수집",
  "retry-batch": "본문 대기 재시도", "bootstrap-recovery": "최초 본문 채우기",
  maintenance: "보관소 무결성 점검",
  archive_snapshot: "중간 집계",
  exporting: "Reader 내보내기", publishing: "Reader 반영", verifying: "게시 검증",
  smoking: "Reader 게시 검증", rolling_back: "이전 Reader 복구",
  rollback_smoking: "Reader 복구 검증",
};
export const safeCodeLabels = {
  cycle_succeeded: "증분 수집 완료", inventory_succeeded: "목록 전수 확인 완료",
  full_catalog_succeeded: "전체 목차 재수집 완료",
  full_content_succeeded: "전체 본문 재수집 완료",
  bootstrap_recovery_succeeded: "최초 본문 채우기 완료",
  recovery_succeeded: "본문 재시도 완료", publish_succeeded: "Reader 반영 완료",
  scheduled_succeeded: "예약 실행 완료", scheduled_partial: "예약 실행 일부 완료",
  scheduled_failed: "예약 실행 실패", run_partial: "일부 항목 미완료",
  run_failed: "실행 실패", run_stale: "실행 종료 신호 누락", runner_failed: "수집기 내부 실패",
  runner_interrupted: "수집기 프로세스 중단 · 진행분은 보존됨",
  archive_locked: "보관소 파일이 다른 작업에 잠김 · 이전 수집/백업 프로세스 종료 후 재시도",
  full_catalog_no_progress: "전체 목차 커서 정체 · 원본·파서 확인 후 같은 명령으로 이어서 재시도",
  disk_low: "저장 공간 안전 하한 도달 · 진행분 보존 후 수집 중단",
  auth_failed: "원본 인증 실패", parse_drift: "원본 구조 변경",
  site_unreachable: "원본 연결 실패 · 전체 목차는 체크포인트 유지 후 자동 재개",
  rate_limited: "원본 속도 제한",
  export_failed: "Reader 내보내기 실패", publish_failed: "Reader 반영 실패",
  incremental_base_invalid: "Reader 증분 기준 보존본 검증 실패",
  incremental_bootstrap_required: "Reader 증분 상태 초기화 필요",
  incremental_state_invalid: "Reader 증분 상태 불일치",
  incremental_source_changed: "Reader 원본 identity 변경 확인 필요",
  incremental_source_rewound: "Reader 원본 이력 후퇴 확인 필요",
  incremental_projection_untracked: "추적되지 않은 Reader 변경 감지",
  incremental_snapshot_changed: "Reader snapshot 변경으로 재시도 필요",
  incremental_delta_too_large: "Reader 변경분 수동 재구축 필요",
  incremental_publish_bootstrap_required: "Reader 게시 기준선 초기화 필요",
  incremental_publish_validation_failed: "Reader 증분 검증 실패",
  incremental_publish_ledger_invalid: "Reader 게시 복구 상태 검증 실패",
  incremental_publish_smoke_marker_invalid: "Reader 게시 검증 상태 복구 실패",
  incremental_publish_smoke_pointer_conflict: "Reader 게시 포인터와 복구 상태 충돌",
  incremental_publish_pointer_unavailable: "Reader 게시 포인터 연결 실패 · 다음 주기 재시도",
  incremental_publish_predecessor_unavailable: "이전 Reader 보존본 검증 실패 · 다음 주기 재시도",
  publish_report_invalid: "Reader 게시 결과 검증 실패",
  publish_smoke_failed: "현재 Reader 보존본 검증 실패",
  publish_smoke_confirmation_failed: "Reader 게시 검증 완료 상태 저장 실패",
  publish_reconciliation_limit: "Reader 게시 복구 후 새 변경 반영 재시도 필요",
  publish_rollback_unavailable: "복구할 이전 Reader 보존본 없음",
  publish_rollback_failed: "이전 Reader 보존본 복구 실패",
  publish_smoke_failed_rolled_back: "게시 검증 실패 · 이전 보존본 복구 완료",
  publish_rollback_smoke_failed: "이전 보존본 복구 후 검증 실패",
  publish_rollback_confirmation_failed: "이전 보존본 복구 완료 상태 저장 실패",
  schedule_paused: "요청에 따라 일시정지",
};
const warningLabels = {
  auth_failed: "원본 인증을 확인해야 합니다.", parse_drift: "원본 구조 변경이 감지됐습니다.",
  rate_limited: "원본 서버의 속도 제한으로 감속했습니다.",
  site_unreachable: "원본 서버가 느리거나 응답이 끊겼습니다. 전체 목차는 체크포인트부터 자동으로 이어 재시도합니다.",
  disk_low: "Oracle 저장 공간이 부족합니다.",
  control_rejected: "운영 상태 전달이 영구 거절됐습니다. 배포 호환성을 확인해야 합니다.",
  token_expiring: "수집기 인증 갱신이 필요합니다.",
  publish_stale: "새 보존본 게시가 지연되고 있습니다.",
  maintenance: "Oracle 보관소를 점검하고 있습니다. 수동 수집은 점검 완료 후 다시 사용할 수 있습니다.",
  schedule_overdue: "자동 실행 예정 시각이 지났거나 마지막 자동 실행이 7시간보다 오래됐습니다.",
  schedule_unverified: "예약은 켜져 있지만 자동 실행 완료 이력이 아직 없습니다.",
};
const sourceLabels = { systemd: "자동 예약", command: "운영 페이지 요청", worker: "현재 Worker" };
const commandCopy = {
  "sync-now": ["증분 수집 지금 실행", "등록된 게시판의 최신 페이지를 순차적으로 한 번 확인합니다. 원본 요청 간격은 빨라지지 않습니다."],
  "full-catalog": ["전체 게시글 목차 다시 수집", "선택 범위의 모든 게시판에서 제목·주소·목록을 첫 페이지부터 끝까지 확인합니다. 본문은 수집하지 않습니다. 진행 중 게시판은 끝날 때까지 이어서 처리하고, 원본 장애·일시정지도 체크포인트(게시판·페이지)를 보존한 채 같은 작업을 자동으로 재개합니다. 이미 요청한 전체 목차가 작업 중이면 새 요청 대신 그 실행 기록을 여세요. 원본이 느리면 며칠 걸릴 수 있습니다."],
  "full-content": ["전체 게시글 본문 다시 수집", "선택 범위에서 발견된 모든 글을 성공 여부와 관계없이 다시 수집합니다. 장기간 실행될 수 있습니다."],
  "retry-batch": ["본문 대기 재시도", "처리 시각이 된 모든 대기 또는 재시도 항목을 우선순위대로 확인합니다."],
  "publish-if-changed": ["변경분 Reader 반영", "새 변경이 있을 때만 검증 후 Reader 보존본을 바꿉니다."],
  "pause-after-current": ["수집 일시정지", "진행 중 수집은 안전한 지점에서 멈추고 다음 자동 실행도 막습니다. 수동 전체수집은 다시 실행하면 체크포인트부터 이어집니다."],
  "resume-schedule": ["자동 수집 켜기", "다음 예약 시각부터 최신 글 자동 수집을 허용합니다."],
};

const byId = (id) => document.getElementById(id);
const terminal = new Set(["succeeded", "partial", "failed", "expired", "cancelled"]);
const AUTOMATIC_RUN_STALE_MS = 7 * 60 * 60 * 1000;
const RECENT_ISSUE_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULE_GRACE_MS = 20 * 60 * 1000;
const RUNNER_STALE_MS = 3 * 60 * 1000;
const RUN_PAGE_SIZE = 20;
const BOARD_PAGE_SIZE = 50;
const COMMAND_WATCH_ATTEMPTS = 20;
const COMMAND_WATCH_INTERVAL_MS = 3_000;
const ACTIVE_REFRESH_MS = 15_000;
const IDLE_REFRESH_MS = 60_000;
const COMMAND_KEY_PREFIX = "redstm.commandIntent.v1.";
let runsCursor = null;
let boardsCursor = null;
let failuresCursor = null;
let runItems = [];
let boardItems = [];
let selectedAction = null;
let selectedArgs = {};
let lastRunner = null;
let lastState = "not_enrolled";
let lastActiveCommands = 0;
let lastSnapshot = null;
let lastScheduleEnabled = false;
const pendingActions = new Set();
const commandKeys = new Map();

function commandKey(action, args = {}) {
  const intent = `${action}.${args.board_id || "all"}`;
  let key = commandKeys.get(intent);
  let storage = null;
  try {
    storage = typeof sessionStorage === "undefined" ? null : sessionStorage;
    key ||= storage?.getItem(`${COMMAND_KEY_PREFIX}${intent}`);
  } catch {
    storage = null;
  }
  if (!/^web-[0-9a-f-]{36}$/.test(key || "")) key = `web-${crypto.randomUUID()}`;
  commandKeys.set(intent, key);
  try {
    storage?.setItem(`${COMMAND_KEY_PREFIX}${intent}`, key);
  } catch {
    // The in-memory key still protects same-document retries when storage is unavailable.
  }
  return key;
}

function forgetCommandKey(action, args = {}) {
  const intent = `${action}.${args.board_id || "all"}`;
  commandKeys.delete(intent);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(`${COMMAND_KEY_PREFIX}${intent}`);
    }
  } catch {
    // A successful server response is authoritative even if browser storage is unavailable.
  }
}

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
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86_400)}일 전`;
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

function runnerState(runner) {
  if (!runner?.heartbeat_at) return "not_enrolled";
  const heartbeatAge = Date.now() - Date.parse(runner.heartbeat_at);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > RUNNER_STALE_MS) return "stale";
  return runner.state || "idle";
}

function updateControls(runner, state, activeCommands, scheduleEnabled, snapshot) {
  const unavailable = state === "stale" || state === "not_enrolled";
  const maintenance = runner?.state === "degraded" && runner?.active_step === "maintenance";
  const paused = runner?.state === "paused";
  const running = runner?.state === "running";
  const retryWaiting = snapshot
    ? (snapshot.frontier_pending ?? 0) + (snapshot.frontier_retry ?? 0)
    : null;
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    const copy = button.querySelector("small");
    copy.dataset.default ||= copy.textContent;
    let reason = copy.dataset.default;
    let disabled = pendingActions.has(action);
    if (pendingActions.has(action)) reason = "요청을 보내는 중입니다.";
    else if (unavailable) { disabled = true; reason = "수집기가 다시 연결된 뒤 요청할 수 있습니다."; }
    else if (maintenance) { disabled = true; reason = "보관소 무결성 점검이 끝난 뒤 요청할 수 있습니다."; }
    else if (running && action !== "pause-after-current") { disabled = true; reason = "현재 작업 중에는 수집 일시정지만 요청할 수 있습니다."; }
    else if (paused && action === "pause-after-current") { disabled = true; reason = "자동 수집이 이미 꺼져 있습니다."; }
    else if (!paused && action === "resume-schedule") { disabled = true; reason = "일시정지 상태에서만 사용할 수 있습니다."; }
    else if (!scheduleEnabled && !running && action === "pause-after-current") { disabled = true; reason = "자동 예약이 이미 꺼져 있습니다."; }
    else if (action === "retry-batch" && retryWaiting === 0) { disabled = true; reason = "현재 처리할 본문 대기 또는 재시도 항목이 없습니다."; }
    button.disabled = disabled;
    copy.textContent = reason;
  }
  byId("control-summary").textContent = activeCommands
    ? `활성 명령 ${activeCommands}개 · 완료될 때까지 같은 작업을 다시 요청하지 마세요.`
    : unavailable
    ? "수집기 신호가 돌아오면 수동 작업을 요청할 수 있습니다."
    : maintenance
    ? "Oracle 보관소 점검이 끝나면 수동 작업이 자동으로 다시 열립니다."
    : scheduleEnabled
    ? "자동 수집이 켜져 있습니다. 예외가 있을 때만 고정된 작업을 요청합니다."
    : "Oracle 자동 예약이 꺼져 있습니다. redstm-schedule.timer를 활성화하기 전까지 1회 작업만 수동으로 요청할 수 있습니다.";
}

function number(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString("ko-KR") : "—";
}

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return "미보고";
  if (value >= 2 ** 30) return `${(value / 2 ** 30).toFixed(1)} GiB`;
  if (value >= 2 ** 20) return `${(value / 2 ** 20).toFixed(1)} MiB`;
  if (value >= 2 ** 10) return `${(value / 2 ** 10).toFixed(1)} KiB`;
  return `${number(value)} B`;
}

function runCountersReported(run) {
  if (typeof run?.counters_reported === "boolean") return run.counters_reported;
  return run?.safe_summary_code !== "runner_interrupted" ||
    [run.changed_posts, run.failed_posts, run.boards_ok, run.boards_failed]
      .some((value) => Number.isFinite(value) && value > 0);
}

function isInventoryFocusedRun(run, activeStep = null) {
  const step = activeStep || run?.latest_event?.step;
  return step === "full-catalog" || step === "inventory" ||
    run?.safe_summary_code === "full_catalog_succeeded" ||
    run?.safe_summary_code === "full_catalog_no_progress" ||
    run?.safe_summary_code === "inventory_succeeded";
}

function runLabel(run, activeStep = null) {
  const action = run?.source === "command" ? activeStep || run.latest_event?.step : null;
  return stepLabels[action] || labels[run?.kind] || run?.kind;
}

function renderArchiveSnapshot(snapshot) {
  const counters = snapshot?.counters || null;
  lastSnapshot = counters;
  if (!counters) {
    byId("outline-only").textContent = "미보고";
    byId("frontier-waiting").textContent = "미보고";
    byId("inventory-progress").textContent = "미보고";
    byId("frontier-dead").textContent = "미보고";
    byId("inventory-detail").textContent = "게시판별 전체 목록 확인 이력 집계";
    byId("archive-as-of").textContent = "Oracle 원본 DB 집계가 아직 보고되지 않았습니다.";
    return;
  }
  const waiting = (counters.frontier_pending ?? 0) +
    (counters.frontier_running ?? 0) + (counters.frontier_retry ?? 0);
  const completed = counters.inventory_completed_boards ?? 0;
  const total = counters.inventory_total_boards ?? 0;
  const inProgress = counters.inventory_in_progress_boards ?? 0;
  byId("outline-only").textContent = number(counters.outline_only);
  byId("frontier-waiting").textContent = number(waiting);
  byId("inventory-progress").textContent = total
    ? `${completed === total ? "완료" : "진행 중"} · ${number(completed)}/${number(total)}`
    : "—";
  byId("inventory-detail").textContent = inProgress
    ? `${number(inProgress)}개 게시판의 전체 목록을 계속 확인 중`
    : completed === total && total
    ? "전체 목록 확인 완료 · 이후 최신 페이지만 주기적으로 확인"
    : "전체 분량을 알 수 없어 완료 게시판 수로 표시";
  byId("frontier-dead").textContent = number(counters.frontier_dead);
  byId("archive-as-of").textContent = `Oracle 원본 DB · 최근 집계 ${time(snapshot.recorded_at)}`;
}

function renderIssue(issue) {
  const issueAt = Date.parse(issue?.finished_at || issue?.started_at);
  const recent = Number.isFinite(issueAt) && Date.now() - issueAt <= RECENT_ISSUE_MS ? issue : null;
  const section = document.querySelector(".issue-strip");
  const metrics = byId("issue-metrics");
  if (!recent) {
    section.dataset.state = "clear";
    metrics.hidden = true;
    byId("issue-title").textContent = "최근 7일 실패 없음";
    byId("issue-reason").textContent = "최근 운영 기록에서 일부 완료 또는 실패가 보고되지 않았습니다.";
    byId("issue-time").textContent = "—";
    byId("issue-kind").textContent = "—";
    byId("issue-posts").textContent = "—";
    byId("issue-boards").textContent = "—";
    byId("issue-link").hidden = true;
    return;
  }
  const recovered = Boolean(recent.recovered || recent.recovered_at);
  const reason = safeCodeLabels[recent.safe_summary_code] || "원인 미보고";
  section.dataset.state = recovered ? "recovered" : "active";
  metrics.hidden = false;
  byId("issue-title").textContent = `${recovered ? "정상화됨" : labels[recent.state] || recent.state} · ${reason}`;
  byId("issue-reason").textContent = recovered
    ? `이후 자동 실행이 성공했습니다${recent.recovered_at ? ` · 정상화 ${time(recent.recovered_at)}` : ""}.`
    : recent.safe_summary_code === "runner_interrupted"
    ? "같은 작업을 다시 요청하면 저장된 체크포인트부터 이어갑니다. 실행 기록과 Oracle 여유 공간을 확인하세요."
    : recent.safe_summary_code === "site_unreachable"
    ? "원본이 다시 응답하면 같은 전체 목차·수집 명령을 요청하세요. 게시판 페이지 진행분은 보존되어 이어서 갑니다."
    : "남은 항목은 다음 자동 실행에서 재시도하며, 반복 실패는 사람 확인 필요로 분리됩니다.";
  byId("issue-time").textContent = `${age(recent.finished_at || recent.started_at)} · ${time(recent.finished_at || recent.started_at)}`;
  byId("issue-kind").textContent = labels[recent.kind] || recent.kind;
  const countersReported = runCountersReported(recent);
  byId("issue-posts").textContent = countersReported ? number(recent.failed_posts ?? 0) : "미보고";
  byId("issue-boards").textContent = countersReported ? number(recent.boards_failed ?? 0) : "미보고";
  byId("issue-link").hidden = false;
}

function renderOverview(data) {
  const runner = data.runner;
  const latest = data.latest_run;
  const active = data.active_run;
  const latestAutomatic = data.latest_automatic_run || (latest?.kind === "scheduled" ? latest : null);
  const state = runnerState(runner);
  const stale = state === "stale";
  const maintenance = runner?.state === "degraded" && runner?.active_step === "maintenance";
  const scheduleEnabled = Boolean(data.schedule_enabled);
  const baseAutomation = maintenance
    ? "maintenance"
    : state === "not_enrolled" || stale
    ? "unknown"
    : runner?.state === "paused"
    ? "paused"
    : scheduleEnabled
    ? "on"
    : "off";
  const automaticRunning = active?.kind === "scheduled" && active.state === "running";
  const automaticAt = Date.parse(latestAutomatic?.finished_at || latestAutomatic?.started_at);
  const nextAt = Date.parse(runner?.next_scheduled_at);
  const nextOverdue = scheduleEnabled && Number.isFinite(nextAt) &&
    nextAt < Date.now() - SCHEDULE_GRACE_MS && !automaticRunning;
  const automaticOverdue = scheduleEnabled && Number.isFinite(automaticAt) &&
    Date.now() - automaticAt > AUTOMATIC_RUN_STALE_MS;
  const automaticUnverified = scheduleEnabled && !automaticRunning && !Number.isFinite(automaticAt);
  const automation = baseAutomation === "on" && automaticUnverified
    ? "unverified"
    : baseAutomation === "on" && (nextOverdue || automaticOverdue)
    ? "delayed"
    : baseAutomation;
  const verdicts = {
    on: "자동 수집 켜짐", off: "자동 수집 꺼짐", paused: "자동 수집 일시정지",
    delayed: "자동 수집 지연", unverified: "자동 실행 확인 전",
    maintenance: "보관소 점검 중",
    unknown: state === "stale" ? "수집기 응답 없음" : "자동 수집 상태 미보고",
  };
  const reasons = {
    on: runner?.state === "running"
      ? "예약된 보존 작업을 수행하고 있습니다. Reader는 현재 활성 보존본으로 계속 사용할 수 있습니다."
      : "6시간마다 최신 페이지를 확인하고, 변경분이 있으면 검증 후 Reader에 반영합니다.",
    delayed: nextOverdue
      ? "다음 자동 실행 예정 시각이 지났지만 새 실행이 보고되지 않았습니다. 수집기와 Oracle timer를 확인하세요."
      : "마지막 자동 실행이 7시간보다 오래됐습니다. 다음 실행 시각과 수집기 기록을 확인하세요.",
    unverified: "Oracle timer는 켜져 있지만 완료된 자동 실행 증거가 없습니다. 첫 실행 결과를 확인하기 전에는 정상 운전으로 판정하지 않습니다.",
    off: "Oracle 자동 예약이 꺼져 있습니다. redstm-schedule.timer를 활성화하기 전까지 정기 수집은 시작되지 않습니다.",
    paused: "현재 요청과 저장은 마친 뒤 다음 예약 실행을 건너뜁니다.",
    maintenance: "Oracle에서 보관소 무결성을 확인하고 있습니다. Reader는 계속 사용할 수 있고, 수동 수집은 점검이 끝나면 다시 열립니다.",
    unknown: state === "stale"
      ? "마지막 수집기 신호가 3분보다 오래됐습니다. Reader는 활성 보존본으로 계속 사용할 수 있습니다."
      : "수집기가 아직 상태를 보고하지 않았습니다. Oracle control timer와 Access 연결을 확인하세요.",
  };
  byId("overview-title").textContent = verdicts[automation];
  byId("overview-reason").textContent = reasons[automation];
  const automationLabel = {
    on: "켜짐", delayed: "켜짐 · 지연", unverified: "켜짐 · 확인 전",
    off: "꺼짐", paused: "일시정지", maintenance: "점검 중", unknown: "확인 불가",
  }[automation];
  byId("overview-kicker").textContent = `${automationLabel} · 자동 예약`;
  byId("status-signal").dataset.state = automation === "on"
    ? state
    : automation === "maintenance"
    ? "degraded"
    : automation === "delayed" || automation === "unverified"
    ? "degraded"
    : automation;
  byId("automation-mode").textContent = automationLabel;
  byId("last-heartbeat").textContent = runner?.heartbeat_at
    ? `${stale ? "응답 없음" : labels[runner.state] || runner.state} · ${age(runner.heartbeat_at)}`
    : "— · 아직 보고되지 않음";
  byId("last-automatic").textContent = automaticRunning
    ? `실행 중 · ${age(active.started_at)}`
    : latestAutomatic
    ? `${labels[latestAutomatic.state] || latestAutomatic.state} · ${age(latestAutomatic.finished_at || latestAutomatic.started_at)}`
    : "이력 없음";
  byId("active-step-label").textContent = stale ? "마지막 보고 작업" : "현재 작업";
  byId("next-schedule-label").textContent = stale ? "마지막 보고 다음 실행" : "다음 자동 실행";
  const step = stepLabels[runner?.active_step] || runner?.active_step || labels[runner?.state] || "—";
  byId("active-step").textContent = [
    step,
    runner?.active_board_id,
    Number.isFinite(runner?.active_post_id) ? `#${runner.active_post_id}` : null,
  ].filter(Boolean).join(" · ");
  byId("runner-disk").textContent = bytes(runner?.disk_free_bytes);
  byId("next-schedule").textContent = !scheduleEnabled
    ? "예약 없음"
    : nextOverdue
    ? `지연 · ${time(runner?.next_scheduled_at)}`
    : time(runner?.next_scheduled_at);
  const warning = automation === "delayed"
    ? "schedule_overdue"
    : automation === "unverified"
    ? "schedule_unverified"
    : runner?.safe_warning_code;
  byId("warning-line").hidden = !warning;
  byId("warning-label").textContent = warningLabels[warning] || warning || "";
  const shown = active || latest;
  const activeCounters = active?.latest_event?.counters;
  const telemetryReported = Boolean(activeCounters) && Object.keys(activeCounters).length > 0;
  const progressReported = Boolean(active) &&
    ["changed_posts", "failed_posts", "boards_ok", "boards_failed"]
      .every((name) => Number.isFinite(activeCounters?.[name]));
  const shownCountersReported = runCountersReported(shown);
  byId("active-kicker").textContent = active ? "현재 작업" : "최근 완료";
  byId("active-title").textContent = shown ? `${runLabel(shown, active ? runner?.active_step : null)} · ${labels[shown.state] || shown.state}` : "아직 보고된 실행 없음";
  byId("active-reason").textContent = shown
    ? `${sourceLabels[shown.source] || shown.source || "출처 미보고"} · ${active ? `시작 ${time(shown.started_at)} · ${telemetryReported ? `중간 집계 ${time(active.latest_event.recorded_at)}` : "중간 집계 대기"}` : `완료 ${time(shown.finished_at)}`}`
    : "수집기 실행 기록이 아직 보고되지 않았습니다.";
  byId("latest-start").textContent = time(shown?.started_at);
  const inventoryFocus = isInventoryFocusedRun(shown, active ? runner?.active_step : null);
  byId("latest-changed-label").textContent = inventoryFocus ? "본문 저장" : "본문 변경";
  byId("latest-failed-label").textContent = inventoryFocus ? "목록 실패" : "항목 실패";
  byId("latest-boards-label").textContent = inventoryFocus ? "게시판 처리" : "게시판";
  byId("latest-changed").textContent = shown && (!active || progressReported) && shownCountersReported ? number(shown.changed_posts) : active || !shown ? "—" : "미보고";
  byId("latest-failed").textContent = shown && (!active || progressReported) && shownCountersReported ? number(shown.failed_posts) : active || !shown ? "—" : "미보고";
  const boardsReported = Number.isFinite(shown?.boards_ok) && Number.isFinite(shown?.boards_failed);
  byId("latest-boards").textContent = boardsReported && (!active || progressReported) && shownCountersReported
    ? `${shown.boards_ok}/${shown.boards_ok + shown.boards_failed}`
    : active || !shown ? "—" : "미보고";
  if (shown && inventoryFocus && shownCountersReported && Number(shown.changed_posts || 0) === 0) {
    const base = byId("active-reason").textContent;
    if (base && !base.includes("목차만")) {
      byId("active-reason").textContent =
        `${base} · 목차만 확인하므로 본문 저장 0은 정상입니다`;
    }
  }
  renderIssue(data.recent_issue);
  renderArchiveSnapshot(data.archive_snapshot);
  lastRunner = runner;
  lastState = state;
  lastActiveCommands = Number(data.active_commands ?? 0);
  lastScheduleEnabled = scheduleEnabled;
  updateControls(lastRunner, lastState, lastActiveCommands, lastScheduleEnabled, lastSnapshot);
}

function runRow(run) {
  const row = node("details", "run-entry");
  const summary = node("summary", "run-row");
  const state = node("span", "run-state", labels[run.state] || run.state);
  state.dataset.state = run.state;
  const identity = node("div", "run-id");
  identity.append(node("strong", "", runLabel(run)), node("small", "", shortId(run.run_id)));
  const countersReported = runCountersReported(run);
  const inventoryFocus = isInventoryFocusedRun(run);
  const changed = node("div", "run-metric");
  changed.append(
    node("strong", "", countersReported ? run.changed_posts : "미보고"),
    node("small", "", inventoryFocus ? "본문" : "변경"),
  );
  const failed = node("div", "run-metric");
  failed.append(
    node("strong", "", countersReported ? run.failed_posts : "미보고"),
    node("small", "", inventoryFocus ? "목록실패" : "실패"),
  );
  const boards = node("div", "run-metric");
  boards.append(
    node("strong", "", countersReported ? `${run.boards_ok}/${run.boards_ok + run.boards_failed}` : "미보고"),
    node("small", "", "게시판"),
  );
  const started = node("div", "run-metric");
  started.append(node("strong", "", age(run.started_at)), node("small", "", time(run.started_at)));
  summary.append(state, identity, changed, failed, boards, started);
  const detail = node("div", "run-detail");
  detail.append(
    node("span", "", `출처 ${sourceLabels[run.source] || run.source || "—"}`),
    node("span", "", `최근 단계 ${stepLabels[run.latest_event?.step] || run.latest_event?.step || "—"}`),
    node("span", "", safeCodeLabels[run.latest_event?.safe_message] ||
      safeCodeLabels[run.safe_summary_code] || (run.state === "succeeded" ? "경고 미보고" : "원인 미보고")),
    node("span", "", `보고서 ${shortId(run.run_id)}`),
  );
  row.append(summary, detail);
  return row;
}

function runSearchText(run) {
  return [
    run.run_id, run.kind, runLabel(run), run.state, labels[run.state], run.source, sourceLabels[run.source],
    run.latest_event?.step, stepLabels[run.latest_event?.step], run.latest_event?.safe_message,
    safeCodeLabels[run.latest_event?.safe_message], run.safe_summary_code, safeCodeLabels[run.safe_summary_code],
  ].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function renderRuns() {
  const list = byId("runs-list");
  const state = byId("run-state-filter").value;
  const query = byId("run-query").value.trim().normalize("NFKC").toLocaleLowerCase("ko-KR");
  const visible = runItems
    .filter((run) => state === "all" ||
      (state === "succeeded" && run.state === "succeeded") ||
      (state === "warning" && ["partial", "degraded", "stale"].includes(run.state)) ||
      (state === "error" && ["failed", "expired", "cancelled"].includes(run.state)))
    .filter((run) => !query || runSearchText(run).includes(query));
  list.replaceChildren();
  if (!visible.length) {
    list.append(node("p", "empty-row", runItems.length ? "조건에 맞는 실행 기록이 없습니다." : "아직 기록된 실행이 없습니다."));
  } else {
    for (const run of visible) list.append(runRow(run));
  }
  byId("run-filter-status").textContent = `${number(visible.length)}/${number(runItems.length)}개 표시 · 불러온 기록 기준`;
}

async function loadRuns(append = false) {
  const data = await api(`/api/v1/ops/runs?limit=${RUN_PAGE_SIZE}${append && runsCursor ? `&cursor=${encodeURIComponent(runsCursor)}` : ""}`);
  runItems = append ? [...runItems, ...data.items] : data.items;
  renderRuns();
  runsCursor = data.next_cursor;
  byId("runs-more").hidden = !runsCursor;
}

function inventoryComplete(board) {
  return Number.isFinite(Date.parse(board.last_inventory_at)) &&
    Number.isFinite(Date.parse(board.inventory_pass_started_at)) &&
    Date.parse(board.last_inventory_at) >= Date.parse(board.inventory_pass_started_at) &&
    Number(board.inventory_next_page) === 1;
}

function boardNeedsAttention(board) {
  return Boolean(board.warning_code) || ["partial", "failed"].includes(board.last_outcome) ||
    [board.pending, board.running, board.retry, board.dead].some((value) => Number(value) > 0) ||
    !inventoryComplete(board);
}

export function compareBoardPriority(left, right) {
  const leftPriority = [
    Number(left.last_outcome === "running"),
    Number(Boolean(left.warning_code)),
    Number(left.dead ?? 0),
    Number(left.retry ?? 0),
    Number(left.pending ?? 0),
  ];
  const rightPriority = [
    Number(right.last_outcome === "running"),
    Number(Boolean(right.warning_code)),
    Number(right.dead ?? 0),
    Number(right.retry ?? 0),
    Number(right.pending ?? 0),
  ];
  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] !== rightPriority[index]) {
      return rightPriority[index] > leftPriority[index] ? 1 : -1;
    }
  }
  return left.board_id.localeCompare(right.board_id);
}

function boardRow(board) {
  const row = node("article", "board-row");
  const identity = node("div", "board-identity");
  const outcome = node("small", "state-text", `${labels[board.last_outcome] || board.last_outcome || "결과 미보고"} · ${time(board.last_scanned_at)}`);
  outcome.dataset.state = board.last_outcome || "unknown";
  const boardLabel = board.board_name || board.board_id;
  const identityLine = board.board_name
    ? `${board.board_id}${board.group_name ? ` · ${board.group_name}` : ""}`
    : board.group_name || "이름 미보고";
  const collectionState = board.collection_enabled ? "자동 수집 대상" : "수집 안 함";
  const inventoryDone = inventoryComplete(board);
  const inventory = !board.inventory_pass_started_at
    ? "전체 목차 확인 대기"
    : inventoryDone
    ? `전체 목차 확인 완료 · ${time(board.last_inventory_at)}`
    : board.inventory_next_page > 1
    ? `전체 목차 수집 중 · ${number(board.inventory_next_page - 1)}쪽까지 확인 · 중단 시 다음 쪽부터 재개`
    : "이번 전체 목차 수집 대기";
  identity.append(
    node("strong", "", boardLabel),
    node("small", "", identityLine),
    node("small", "collection-state", collectionState),
    outcome,
    node("small", "inventory-text", inventory),
  );
  const metrics = node("dl", "board-metrics");
  const values = [
    ["이번 발견", board.discovered], ["이번 변경", board.changed], ["본문 대기", board.pending],
    ["처리 중", board.running], ["재시도", board.retry], ["수동 확인", board.dead],
    ["목차만", board.outline_only],
  ];
  for (const [label, value] of values) {
    const item = document.createElement("div");
    item.append(node("dt", "", label), node("dd", "", value ?? "—"));
    metrics.append(item);
  }
  const actions = node("div", "board-actions");
  for (const [action, label] of [
    ["sync-now", "이 게시판 최신"],
    ["full-catalog", "이 게시판 전체 목차"],
    ["full-content", "이 게시판 전체 본문"],
  ]) {
    const button = node("button", "", label);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.board = board.board_id;
    button.append(node("small", "", ""));
    actions.append(button);
  }
  row.append(identity, metrics, actions);
  if (board.warning_code) row.append(node("p", "board-warning", warningLabels[board.warning_code] || board.warning_code));
  return row;
}

function renderBoards() {
  const list = byId("boards-list");
  list.replaceChildren();
  if (!boardItems.length) {
    list.append(node("p", "empty-row", "게시판 운영 기록이 아직 보고되지 않았습니다. Reader 게시판 수와는 별도 상태입니다."));
    return;
  }
  const ordered = [...boardItems].sort(compareBoardPriority);
  const attention = ordered.filter(boardNeedsAttention);
  const healthy = ordered.filter((board) => !boardNeedsAttention(board));
  for (const board of attention) list.append(boardRow(board));
  if (healthy.length) {
    const details = node("details", "healthy-boards");
    const summary = node("summary", "", `정상 게시판 ${number(healthy.length)}개`);
    const body = node("div", "healthy-board-list");
    for (const board of healthy) body.append(boardRow(board));
    details.append(summary, body);
    list.append(details);
  }
  updateControls(lastRunner, lastState, lastActiveCommands, lastScheduleEnabled, lastSnapshot);
}

function renderFailures(items, append = false) {
  const list = byId("failures-list");
  if (!append) list.replaceChildren();
  if (!items.length && !append) {
    list.append(node("p", "empty-row", "현재 최종 실패로 분리된 게시글이 없습니다."));
    return;
  }
  for (const item of items) {
    const row = node("article", "failure-row");
    row.append(
      node("strong", "", `${item.board_id} / ${item.external_post_id}`),
      node("span", "", `${item.attempts}회 실패`),
      node("span", "", safeCodeLabels[item.error_code] || item.error_code),
      node("time", "", time(item.last_attempt_at)),
    );
    list.append(row);
  }
}

async function loadFailures(append = false) {
  const data = await api(`/api/v1/ops/failures?limit=${BOARD_PAGE_SIZE}${append && failuresCursor ? `&cursor=${encodeURIComponent(failuresCursor)}` : ""}`);
  renderFailures(data.items, append);
  failuresCursor = data.next_cursor;
  byId("failures-more").hidden = !failuresCursor;
}

async function loadBoards(append = false) {
  const data = await api(`/api/v1/ops/boards?limit=${BOARD_PAGE_SIZE}${append && boardsCursor ? `&cursor=${encodeURIComponent(boardsCursor)}` : ""}`);
  boardItems = append ? [...boardItems, ...data.items] : data.items;
  renderBoards();
  boardsCursor = data.next_cursor;
  byId("boards-more").hidden = !boardsCursor;
}

function renderReleases(data) {
  const available = Boolean(data.current?.release_id);
  const releaseCounts = data.current?.counts || {};
  const commentParts = [releaseCounts.comment_count, releaseCounts.unavailable_comment_count]
    .filter(Number.isFinite);
  const collectedComments = commentParts.length
    ? commentParts.reduce((total, value) => total + value, 0)
    : null;
  byId("reader-continuity").dataset.state = available ? "available" : "unavailable";
  byId("reader-state").textContent = available ? "Reader 사용 가능" : "Reader 보존본 없음";
  byId("reader-release").textContent = available ? `현재 보존본 활성 · ${time(data.current.activated_at)}` : "활성 Reader 보존본을 확인할 수 없습니다.";
  byId("reader-posts").textContent = number(releaseCounts.post_count);
  byId("collected-comments").textContent = number(collectedComments);
  byId("release-current").textContent = available ? `사용 가능 · ${shortId(data.current.release_id)}` : "사용 불가";
  byId("release-current-time").textContent = time(data.current?.activated_at);
  byId("release-previous").textContent = data.previous ? shortId(data.previous.release_id) : "이전 보존본 정보 없음";
  byId("release-previous-time").textContent = time(data.previous?.activated_at);
  byId("release-validation").textContent = data.current?.validation
    ? `${labels[data.current.validation.state] || data.current.validation.state} · 포인터·manifest 확인`
    : "현재 Worker 확인 실패";
  byId("release-validation-time").textContent = data.current?.validation
    ? `${sourceLabels[data.current.validation.source] || data.current.validation.source} · ${time(data.current.validation.as_of)}`
    : "—";
  byId("release-smoke").textContent = data.smoke
    ? `${labels[data.smoke.state] || data.smoke.state} · ${shortId(data.smoke.release_id)}`
    : "게시 후 smoke 이력 없음";
  byId("release-smoke-time").textContent = data.smoke
    ? `${sourceLabels[data.smoke.source] || data.smoke.source} · ${time(data.smoke.as_of)}`
    : "—";
  byId("local-recovery").textContent = data.local_recovery
    ? `${labels[data.local_recovery.state] || data.local_recovery.state} · ${safeCodeLabels[data.local_recovery.code] || data.local_recovery.code || "결과 미보고"}`
    : "복구 실행 이력 없음";
  byId("local-recovery-time").textContent = data.local_recovery
    ? `${sourceLabels[data.local_recovery.source] || data.local_recovery.source} · ${time(data.local_recovery.as_of)}`
    : "—";
  const counts = byId("release-counts");
  counts.replaceChildren();
  const names = {
    post_count: "Reader 글",
    unavailable_post_count: "본문 미확보 기록",
    comment_count: "Reader 글 댓글",
    unavailable_comment_count: "본문 미확보 글 댓글",
    board_count: "게시판",
    collection_count: "모음",
  };
  for (const [key, label] of Object.entries(names)) {
    const item = document.createElement("div");
    const value = data.current?.counts?.[key];
    item.append(node("dt", "", label), node("dd", "", number(value)));
    counts.append(item);
  }
}

function showError(error, scopes = "운영 정보") {
  const banner = byId("error-banner");
  const impact = Array.isArray(scopes) ? scopes.join(" · ") : scopes;
  const code = error instanceof Error ? error.message : "unknown";
  banner.hidden = false;
  banner.textContent = `일부 갱신 실패 · 영향: ${impact} · ${code} · 새로고침으로 다시 시도하세요.`;
}

async function loadAll() {
  byId("refresh").disabled = true;
  byId("error-banner").hidden = true;
  const tasks = [
    ["자동 수집 상태", api("/api/v1/ops/overview").then(renderOverview)],
    ["실행 기록", loadRuns()],
    ["게시판별 진척", loadBoards()],
    ["최종 실패 게시글", loadFailures()],
    ["Reader 글·댓글", api("/api/v1/ops/releases").then(renderReleases)],
  ];
  const results = await Promise.allSettled(tasks.map(([, task]) => task));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [{ scope: tasks[index][0], error: result.reason }] : []);
  if (failures.length) showError(failures[0].error, failures.map(({ scope }) => scope));
  const updated = new Intl.DateTimeFormat("ko-KR", { timeStyle: "medium" }).format(new Date());
  if (failures.length === tasks.length) {
    const code = failures[0].error instanceof Error ? failures[0].error.message : "unknown";
    byId("error-banner").textContent = `전체 갱신 실패 · 이전 화면 값을 유지합니다 · ${code}`;
  }
  byId("updated-at").textContent = failures.length === tasks.length
    ? "화면 갱신 실패 · 이전 값 유지"
    : failures.length
    ? `일부 갱신 실패 · 성공 항목 ${updated}`
    : `화면 갱신 ${updated}`;
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
    cancel.addEventListener("click", () => { void cancelCommand(command).catch((error) => showError(error, "수동 작업")); });
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
  for (let attempt = 0; attempt < COMMAND_WATCH_ATTEMPTS &&
      !terminal.has(command.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_WATCH_INTERVAL_MS));
    command = await api(`/api/v1/ops/commands/${command.command_id}`);
    renderCommand(command);
  }
  if (!terminal.has(command.state)) renderCommand(command, true);
  await Promise.allSettled([api("/api/v1/ops/overview").then(renderOverview), loadRuns()]);
}

async function createCommand(action, args = {}) {
  const key = commandKey(action, args);
  pendingActions.add(action);
  updateControls(lastRunner, lastState, lastActiveCommands, lastScheduleEnabled, lastSnapshot);
  let command;
  try {
    command = await api("/api/v1/ops/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-ReDSTM-Command": "1" },
      body: JSON.stringify({ action, args }),
    });
    forgetCommandKey(action, args);
  } finally {
    pendingActions.delete(action);
    updateControls(lastRunner, lastState, lastActiveCommands, lastScheduleEnabled, lastSnapshot);
  }
  await watchCommand(command);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-action]");
    if (!button || button.disabled) return;
    selectedAction = button.dataset.action;
    selectedArgs = button.dataset.board ? { board_id: button.dataset.board } : {};
    const [title, impact] = commandCopy[selectedAction];
    byId("dialog-title").textContent = button.dataset.board
      ? `${title} · ${button.dataset.board}`
      : title;
    byId("dialog-impact").textContent = impact;
    byId("command-dialog").showModal();
  });
  byId("command-dialog").addEventListener("close", () => {
    if (byId("command-dialog").returnValue === "confirm" && selectedAction) {
      createCommand(selectedAction, selectedArgs).catch((error) => showError(error, "수동 작업"));
    }
    selectedAction = null;
    selectedArgs = {};
  });
  byId("refresh").addEventListener("click", () => { void loadAll(); });
  byId("runs-more").addEventListener("click", () => { void loadRuns(true).catch((error) => showError(error, "실행 기록")); });
  byId("run-state-filter").addEventListener("change", renderRuns);
  byId("run-query").addEventListener("input", renderRuns);
  byId("boards-more").addEventListener("click", () => { void loadBoards(true).catch((error) => showError(error, "게시판별 진척")); });
  byId("failures-more").addEventListener("click", () => { void loadFailures(true).catch((error) => showError(error, "최종 실패 게시글")); });
  void loadAll();
}
async function refreshLoop() {
  const delay = lastRunner?.state === "running" ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (!document.hidden) await loadAll().catch(showError);
  void refreshLoop();
}
if (typeof document !== "undefined") void refreshLoop();
