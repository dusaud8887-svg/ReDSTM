const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("ko-KR");

function text(id, value) {
  byId(id).textContent = value ?? "—";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function cell(value, status) {
  const element = document.createElement("td");
  element.textContent = value ?? "—";
  if (status) element.dataset.status = status;
  return element;
}

function renderTable(id, rows, columns) {
  const body = byId(id);
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const empty = cell("표시할 항목이 없습니다.");
    empty.colSpan = columns.length;
    empty.className = "empty";
    row.append(empty);
    body.append(row);
    return;
  }
  for (const item of rows) {
    const row = document.createElement("tr");
    for (const column of columns) row.append(cell(column.value(item), column.status?.(item)));
    body.append(row);
  }
}

function evidence(id, label, value) {
  const root = byId(id);
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  title.textContent = label;
  detail.textContent = value;
  root.replaceChildren(title, detail);
}

function render(data) {
  const verdict = document.querySelector(".verdict");
  verdict.dataset.state = data.readiness.state;
  text("readiness-title", data.readiness.state);
  text("readiness-reason", data.readiness.reason);
  text("connection", `마지막 확인 ${new Date().toLocaleTimeString("ko-KR")}`);

  text("boards", number.format(data.archive.counts.boards));
  text("posts", number.format(data.archive.counts.posts));
  text("versions", number.format(data.archive.counts.versions));
  text("archive-bytes", formatBytes(data.archive.bytes));
  text("archive-path", data.archive.path);

  const frontier = byId("frontier");
  frontier.replaceChildren();
  for (const state of ["pending", "running", "retry", "done", "dead"]) {
    const item = document.createElement("div");
    item.className = state;
    const term = document.createElement("dt");
    const count = document.createElement("dd");
    term.textContent = state;
    count.textContent = number.format(data.frontier[state]);
    item.append(term, count);
    frontier.append(item);
  }

  evidence(
    "doctor",
    "DOCTOR",
    data.doctor ? `${data.doctor.ok ? "PASS" : "FAIL"} · ${data.doctor.checked_at ?? "시각 없음"}` : "report 없음",
  );
  evidence(
    "release",
    "RELEASE",
    data.release ? `${number.format(data.release.posts)} posts · ${number.format(data.release.comments)} comments` : "release 없음",
  );
  evidence(
    "backups",
    "BACKUP",
    data.backups.length ? `${data.backups.length}개 manifest · 최근 ${data.backups[0].created_at ?? data.backups[0].name}` : "등록된 backup 없음",
  );

  renderTable("queue-body", data.queue_boards, [
    { value: (item) => item.board_id },
    { value: (item) => number.format(item.pending) },
    { value: (item) => number.format(item.retry) },
    { value: (item) => number.format(item.dead) },
  ]);
  renderTable("runs-body", data.recent_runs, [
    { value: (item) => item.started_at },
    { value: (item) => item.kind },
    { value: (item) => item.status, status: (item) => item.status },
    { value: (item) => number.format(item.fetched) },
    { value: (item) => number.format(item.failed) },
  ]);
}

async function exchangeSession() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return;
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("startup token이 거부됐습니다.");
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

async function refresh() {
  const button = byId("refresh");
  button.disabled = true;
  text("connection", "상태 읽는 중");
  try {
    const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
    if (response.status === 401) throw new Error("console을 시작할 때 출력된 URL로 다시 여세요.");
    if (!response.ok) throw new Error("상태 report를 읽지 못했습니다.");
    render(await response.json());
  } catch (error) {
    text("connection", error.message);
    text("readiness-title", "연결 필요");
    text("readiness-reason", "로컬 console process와 startup URL을 확인하세요.");
  } finally {
    button.disabled = false;
  }
}

byId("refresh").addEventListener("click", refresh);
try {
  await exchangeSession();
  await refresh();
} catch (error) {
  text("connection", error.message);
  text("readiness-title", "세션 오류");
}
