import { kwicScope } from "./kwic-core.js";

export function createKwic({ overlays, parse, onOpen }) {
  const dialog = document.createElement("dialog");
  dialog.id = "kwic-dialog";
  dialog.setAttribute("aria-labelledby", "kwic-title");
  dialog.innerHTML = `<form method="dialog"><header><div><p id="kwic-work"></p><h2 id="kwic-title">작품에서 찾기</h2></div><button value="close" aria-label="닫기">✕</button></header></form>
    <form id="kwic-search"><label>찾을 말<input id="kwic-input" type="text" autocomplete="off" maxlength="200"></label><button type="submit">찾기</button></form>
    <label class="kwic-scope"><input id="kwic-all" type="checkbox">작품 전체 (안 읽은 회차 포함)</label>
    <p>기본 범위: 읽은 회차만 · 지금 읽는 회차 포함</p><div class="kwic-distribution" id="kwic-distribution" aria-label="검색 결과 분포"></div>
    <p id="kwic-status" role="status"></p><button type="button" id="kwic-cancel">취소</button><ol id="kwic-results"></ol>`;
  document.body.append(dialog);
  overlays.watch(dialog);
  const element = (id) => dialog.querySelector(`#kwic-${id}`);
  let context = null;
  let worker = null;
  let queryId = 0;
  let hits = [];
  let counts = new Map();
  const cancel = () => { queryId += 1; worker?.terminate(); worker = null; };
  dialog.addEventListener("close", cancel);
  element("cancel").addEventListener("click", () => { cancel(); element("status").textContent += " · 취소됨"; });
  function draw() {
    const positions = new Map(context.entries.map((entry, index) => [entry.documentId, index]));
    hits.sort((a, b) => positions.get(a.entry.documentId) - positions.get(b.entry.documentId) || a.locator.start - b.locator.start);
    element("results").replaceChildren(...hits.map((hit) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const title = document.createElement("strong"); title.textContent = hit.entry.title;
      const quote = document.createElement("span");
      const mark = document.createElement("mark"); mark.textContent = hit.exact;
      quote.append(`…${hit.before}`, mark, `${hit.after}…`); button.append(title, quote);
      button.addEventListener("click", () => {
        const parent = new URL(context.from, location.origin);
        parent.searchParams.set("kwic", element("input").value.trim());
        if (element("all").checked) parent.searchParams.set("kwicAll", "1");
        dialog.close();
        void onOpen(hit, `${parent.pathname}${parent.search}`).catch(() => {
          element("status").textContent = "이 회차를 열지 못했어요"; dialog.showModal();
        });
      });
      item.append(button); return item;
    }));
    const bins = Array.from({ length: Math.min(120, context.entries.length) }, () => 0);
    context.entries.forEach((entry, index) => { if (bins.length) bins[Math.floor(index * bins.length / context.entries.length)] += counts.get(entry.documentId) || 0; });
    element("distribution").replaceChildren(...bins.map((count) => {
      const bar = document.createElement("i"); bar.classList.toggle("hit", count > 0); bar.title = `${count}곳`; return bar;
    }));
  }
  function search() {
    cancel(); hits = []; counts = new Map(); draw();
    const query = element("input").value.trim();
    if (!query) { element("status").textContent = "찾을 말을 입력해 주세요"; return; }
    const entries = kwicScope(context.entries, { all: element("all").checked, read: context.read, current: context.current });
    if (!entries.length) { element("status").textContent = "이 범위에 읽은 회차가 없어요"; return; }
    const bytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    if ((navigator.connection?.saveData || bytes > 20 * 1024 * 1024) && !confirm(`${entries.length}화 본문을 받아 검색합니다${bytes ? ` (약 ${Math.ceil(bytes / 1024 / 1024)}MB)` : ""}. 계속할까요?`)) return;
    const id = queryId;
    worker = new Worker("/kwic-worker.js", { type: "module" });
    element("status").textContent = `0/${entries.length}화 확인 중`;
    const failed = () => { if (id !== queryId) return; cancel(); element("status").textContent = "본문 검색을 시작하지 못했어요 · 다시 찾기를 눌러 주세요"; };
    worker.onerror = failed; worker.onmessageerror = failed;
    worker.onmessage = ({ data }) => {
      if (id !== queryId || data.queryId !== id) return;
      if (data.type === "parse") {
        try { worker.postMessage({ type: "parsed", queryId: id, parseId: data.parseId, text: parse(data.entry, data.raw) }); }
        catch { worker.postMessage({ type: "parsed", queryId: id, parseId: data.parseId, error: "본문을 확인하지 못했어요" }); }
      } else if (data.type === "result") {
        counts.set(data.entry.documentId, data.matches.length);
        hits.push(...data.matches.map((hit) => ({ ...hit, entry: data.entry })));
        element("status").textContent = `${data.checked}/${data.total}화 확인 중 · ${[...counts.values()].filter(Boolean).length}화에 걸쳐 ${hits.length}곳${data.failed ? ` · 확인 못 함 ${data.failed}화` : ""}`;
        draw();
      } else if (data.type === "done") {
        element("status").textContent = element("status").textContent.replace("확인 중", "확인 완료");
        worker.terminate(); worker = null;
      }
    };
    worker.postMessage({ type: "search", queryId: id, query, entries });
  }
  element("search").addEventListener("submit", (event) => { event.preventDefault(); search(); });
  element("all").addEventListener("change", search);
  return {
    open(value, query = "", all = false) {
      cancel(); context = value; element("work").textContent = value.title;
      element("input").value = query; element("all").checked = all;
      if (!dialog.open) dialog.showModal();
      element("input").focus(); search();
    },
    close() { if (dialog.open) dialog.close(); else cancel(); },
  };
}
