import { createSuggester, createSuggestIndex } from "./search-suggest.js";
import { addShelf, renameShelf, sanitizeShelfState } from "./text-shelves.js";

export const DEFAULT_VIEWS = [
  { id: "new", name: "새 화 있는 작품", conditions: { fresh: true } },
  { id: "reading", name: "읽는 중", conditions: { read: "reading" } },
  { id: "aa", name: "AA 모음", conditions: { aa: true } },
  { id: "finished", name: "다 읽은 작품", conditions: { read: "finished" } },
  { id: "short", name: "10화 이하", conditions: { maxChapters: 10 } },
];
const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value) => Number.isFinite(Date.parse(value ?? ""));
const name = (value) => typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 30) : "";

export function sanitizeConditions(value) {
  const source = record(value) ? value : {};
  const result = {};
  if (["typemoon", "novel", "arcalive"].includes(source.source)) result.source = source.source;
  if (["unread", "reading", "finished"].includes(source.read)) result.read = source.read;
  for (const key of ["fresh", "aa", "pinned"]) if (source[key] === true) result[key] = true;
  if (Number.isInteger(source.maxChapters) && source.maxChapters > 0 && source.maxChapters <= 10000) result.maxChapters = source.maxChapters;
  if (/^s[a-z0-9]{1,15}$/.test(source.shelfId ?? "")) result.shelfId = source.shelfId;
  return result;
}

export function sanitizeLibrary(value) {
  const source = record(value) ? value : {};
  const shelves = sanitizeShelfState(source).shelves;
  const ids = new Set();
  const views = [];
  for (const view of Array.isArray(source.views) ? source.views : DEFAULT_VIEWS) {
    const label = name(view?.name);
    if (!label || !/^[a-z0-9-]{1,60}$/.test(view?.id ?? "") || ids.has(view.id)) continue;
    ids.add(view.id);
    views.push({ id: view.id, name: label, conditions: sanitizeConditions(view.conditions) });
    if (views.length >= 50) break;
  }
  return { key: "library", shelves, views, updatedAt: time(source.updatedAt) ? new Date(source.updatedAt).toISOString() : "1970-01-01T00:00:00.000Z" };
}

export function sanitizeWorkStyle(value) {
  if (!record(value) || typeof value.workKey !== "string" || value.workKey.length > 300 ||
      !/^(?:typemoon:(?:collection|post):|novel:|arcalive:)/.test(value.workKey) || !time(value.updatedAt)) return null;
  const kept = { workKey: value.workKey, updatedAt: new Date(value.updatedAt).toISOString() };
  if (Number.isInteger(value.hue) && value.hue >= 0 && value.hue < 10) kept.hue = value.hue;
  if (typeof value.note === "string") kept.note = value.note.slice(0, 1000);
  if (typeof value.pinned === "boolean") kept.pinned = value.pinned;
  if (/^s[a-z0-9]{1,15}$/.test(value.shelfId ?? "")) kept.shelfId = value.shelfId;
  if (time(value.deletedAt)) kept.deletedAt = new Date(value.deletedAt).toISOString();
  return kept;
}

export function matchesView(work, conditions, style = {}) {
  const query = sanitizeConditions(conditions);
  return (!query.source || work.source === query.source) && (!query.read || work.read === query.read) &&
    (!query.fresh || work.fresh === true) && (!query.aa || work.aa === true) &&
    (!query.pinned || (!style.deletedAt && style.pinned === true)) &&
    (!query.shelfId || (!style.deletedAt && style.shelfId === query.shelfId)) &&
    (!query.maxChapters || (work.chapters > 0 && work.chapters <= query.maxChapters));
}

// A later configuration replaces the older one as a unit: removed views stay removed.
export function mergeLibrary(current, incoming) {
  const mine = sanitizeLibrary(current);
  const other = sanitizeLibrary(incoming);
  return !record(current) || Date.parse(other.updatedAt) > Date.parse(mine.updatedAt) ? other : mine;
}

export function mergeWorkStyles(current, incoming) {
  const mine = new Map(current.map(sanitizeWorkStyle).filter(Boolean).map((item) => [item.workKey, item]));
  const changed = new Map();
  for (const value of incoming) {
    const other = sanitizeWorkStyle(value);
    if (!other) continue;
    const previous = changed.get(other.workKey) || mine.get(other.workKey);
    if (!previous || Date.parse(other.updatedAt) > Date.parse(previous.updatedAt)) changed.set(other.workKey, other);
  }
  return [...changed.values()];
}


// All three sources use the same Korean metadata engine and the same named conditions.
export function createPersonalLibrary({ host, overlays, getData, load, save, commands, libraries, onOpen, onChanged, feedback, visible, makeCard }) {
  const section = document.createElement("section");
  section.id = "smart-library"; section.className = "smart-library"; section.hidden = true;
  section.innerHTML = '<header><h2>스마트 서재</h2><button type="button" id="smart-library-edit">편집</button></header><div id="smart-library-chips"></div><section class="reading-works" id="library-pinned" hidden><h3>고정한 작품</h3><ol class="shelf"></ol></section>';
  host.after(section);
  const dialog = (id, title, contents) => {
    const node = document.createElement("dialog"); node.id = id; node.className = "personal-library-dialog";
    node.setAttribute("aria-labelledby", `${id}-title`);
    node.innerHTML = `<form method="dialog"><header><h2 id="${id}-title">${title}</h2><button value="close" aria-label="닫기">✕</button></header></form>${contents}`;
    document.body.append(node); overlays.watch(node); return node;
  };
  const palette = dialog("command-palette", "작품·명령 찾기", '<label class="sr-only" for="palette-input">작품·작가·명령</label><input id="palette-input" type="text" autocomplete="off" placeholder="작품·작가·명령 찾기" role="combobox" aria-controls="palette-results" aria-expanded="true" aria-autocomplete="list"><p id="palette-status" role="status"></p><ul id="palette-results" role="listbox" aria-label="작품·명령 결과"></ul>');
  const input = palette.querySelector("input");
  const results = palette.querySelector("ul");
  let paletteRows = [];
  let selected = 0;
  let paletteGeneration = 0;
  const select = (position) => {
    if (!paletteRows.length) { input.removeAttribute("aria-activedescendant"); return; }
    selected = (position + paletteRows.length) % paletteRows.length;
    for (const [index, row] of [...results.querySelectorAll('[role="option"]')].entries()) row.setAttribute("aria-selected", String(index === selected));
    input.setAttribute("aria-activedescendant", results.children[selected].firstElementChild.id);
    results.children[selected].scrollIntoView({ block: "nearest" });
  };
  const choose = (row) => {
    palette.close();
    if (row.command) row.command();
    else void onOpen(row.work);
  };
  const renderPalette = (rows) => {
    paletteRows = rows; selected = 0;
    results.replaceChildren(...rows.map((row, index) => {
      const item = document.createElement("li"); item.role = "presentation";
      const button = document.createElement("button"); button.type = "button"; button.tabIndex = -1;
      button.id = `palette-result-${index}`; button.role = "option";
      if (row.work) button.dataset.workKey = row.work.key;
      const title = document.createElement("strong"); title.textContent = row.displayTitle || row.title;
      const meta = document.createElement("small"); meta.textContent = row.meta || (row.command ? "명령" : "작품");
      button.append(title, meta); button.addEventListener("click", () => choose(row)); item.append(button); return item;
    }));
    palette.querySelector("#palette-status").textContent = rows.length ? `${rows.length}개 · ↑↓ 선택 · Enter 열기` : "일치하는 작품·명령이 없어요";
    select(0);
  };
  let metadata = [];
  const suggester = createSuggester(async () => {
    const data = await getData();
    metadata = [
      ...commands().map((entry) => ({ key: `command:${entry.title}`, title: entry.title, command: entry.run })),
      ...data.map((work) => ({ key: work.key, title: `${work.title} ${work.author || ""}`, displayTitle: work.title, meta: work.sourceLabel, work })),
    ];
    return createSuggestIndex(metadata, libraries);
  });
  function searchPalette() {
    const generation = ++paletteGeneration;
    const query = input.value.trim();
    if (!query) {
      suggester.cancel(); renderPalette(commands().map((entry) => ({ title: entry.title, command: entry.run })));
      return;
    }
    palette.querySelector("#palette-status").textContent = "작품을 확인하는 중…";
    void suggester.request(query, (answer) => {
      if (!palette.open || generation !== paletteGeneration) return;
      renderPalette([...answer.exact, ...answer.choseong, ...answer.similar].map((hit) => hit.item));
      if (answer.qwerty) {
        const button = document.createElement("button"); button.type = "button";
        button.textContent = `'${answer.qwerty}'(으)로 찾을까요?`;
        button.addEventListener("click", () => { input.value = answer.qwerty; searchPalette(); });
        palette.querySelector("#palette-status").replaceChildren(button);
      }
    }).catch(() => { if (generation === paletteGeneration) palette.querySelector("#palette-status").textContent = "작품을 확인하지 못했어요 · 다시 입력해 주세요"; });
  }
  input.addEventListener("input", searchPalette);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowDown") select(selected + 1);
    else if (event.key === "ArrowUp") select(selected - 1);
    else if (event.key === "Enter" && paletteRows[selected]) choose(paletteRows[selected]);
  });
  palette.addEventListener("close", () => { paletteGeneration += 1; suggester.cancel(); input.removeAttribute("aria-activedescendant"); });

  const viewDialog = dialog("smart-library-view", "스마트 서재", '<p id="library-view-status" role="status"></p><ol id="library-view-works"></ol>');
  const editor = dialog("smart-library-editor", "스마트 서재 편집", '<ul id="library-view-list"></ul><form id="library-view-form"><label>이름<input name="name" maxlength="30" required></label><label>출처<select name="source"><option value="">전체</option><option value="typemoon">타입문넷</option><option value="novel">소설</option><option value="arcalive">아카라이브</option></select></label><label>읽기 상태<select name="read"><option value="">전체</option><option value="unread">안 읽음</option><option value="reading">읽는 중</option><option value="finished">다 읽음</option></select></label><label>분류<select name="shelfId"></select></label><label>최대 회차 수<input name="maxChapters" type="number" min="1" max="10000" placeholder="제한 없음"></label><label><input name="fresh" type="checkbox">새 화 있음</label><label><input name="aa" type="checkbox">AA</label><label><input name="pinned" type="checkbox">고정한 작품</label><button type="submit">조건 조합 저장</button><p id="library-editor-status" role="status"></p></form>');
  const styleDialog = dialog("work-style-dialog", "작품 분류·고정", '<p id="work-style-title"></p><form id="work-style-form"><label>분류<select name="shelfId"></select></label><label><input name="pinned" type="checkbox">서재에 고정</label><button type="button" id="library-shelf-add">새 분류</button><button type="button" id="library-shelf-rename">분류 이름 바꾸기</button><button type="button" id="library-shelf-remove">분류 지우기</button><button type="submit">저장</button><p id="library-style-status" role="status"></p></form>');
  let state = { config: sanitizeLibrary(null), styles: new Map(), canSave: false };
  let styleWork = null;
  let homeGeneration = 0;
  let editingViewId = null;
  const choices = (selectNode, emptyLabel) => {
    selectNode.replaceChildren(...[{ id: "", name: emptyLabel }, ...state.config.shelves].map((shelf) => {
      const option = document.createElement("option"); option.value = shelf.id; option.textContent = shelf.name; return option;
    }));
  };
  async function write(config, changes = []) {
    if (!state.canSave) { feedback("이 기기에 기록을 저장할 수 없어요"); return false; }
    try {
      const next = { ...config, updatedAt: new Date().toISOString() };
      await save(next, changes);
      state = await load();
      await onChanged(state); void renderHome(); return true;
    } catch { feedback("저장하지 못했어요 · 이전 기록은 그대로 있어요"); return false; }
  }
  async function renderHome() {
    const generation = ++homeGeneration;
    const [data, next] = await Promise.all([getData(), load()]);
    if (generation !== homeGeneration || !visible()) return;
    state = next; section.hidden = !data.length;
    section.querySelector("#smart-library-chips").replaceChildren(...state.config.views.map((view) => {
      const button = document.createElement("button"); button.type = "button"; button.dataset.viewId = view.id;
      const count = data.filter((work) => matchesView(work, view.conditions, state.styles.get(work.key))).length;
      button.textContent = `${view.name} ${count}`; button.addEventListener("click", () => void openView(view)); return button;
    }));
    const pinned = data.filter((work) => matchesView(work, { pinned: true }, state.styles.get(work.key)));
    const pinnedSection = section.querySelector("#library-pinned"); pinnedSection.hidden = !pinned.length;
    pinnedSection.querySelector("ol").replaceChildren(...pinned.map(makeCard));
  }
  async function openView(view) {
    viewDialog.querySelector("h2").textContent = view.name;
    viewDialog.querySelector("#library-view-status").textContent = "작품을 확인하는 중…";
    viewDialog.showModal();
    const [data, next] = await Promise.all([getData(), load()]);
    if (!viewDialog.open) return;
    state = next;
    const works = data.filter((work) => matchesView(work, view.conditions, state.styles.get(work.key)))
      .sort((a, b) => Number(state.styles.get(b.key)?.pinned === true) - Number(state.styles.get(a.key)?.pinned === true));
    viewDialog.querySelector("#library-view-status").textContent = `${works.length}개 작품 · 조건을 모두 만족하는 작품`;
    viewDialog.querySelector("ol").replaceChildren(...works.map((work) => {
      const item = document.createElement("li");
      const button = document.createElement("button"); button.type = "button"; button.dataset.workKey = work.key;
      const title = document.createElement("strong"); title.textContent = work.title;
      const meta = document.createElement("small"); meta.textContent = `${work.sourceLabel} · ${work.chapters}화`;
      button.append(title, meta); button.addEventListener("click", () => { viewDialog.close(); void onOpen(work); });
      const classify = document.createElement("button"); classify.type = "button"; classify.textContent = "분류·고정";
      classify.addEventListener("click", () => void openWork(work)); item.append(button, classify); return item;
    }));
  }
  function renderEditor() {
    editor.querySelector("ul").replaceChildren(...state.config.views.map((view) => {
      const item = document.createElement("li"); const label = document.createElement("span"); label.textContent = view.name;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "지우기"; remove.ariaLabel = `${view.name} 지우기`;
      remove.addEventListener("click", async () => { if (await write({ ...state.config, views: state.config.views.filter((item) => item.id !== view.id) })) renderEditor(); });
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "고치기"; edit.ariaLabel = `${view.name} 고치기`;
      edit.addEventListener("click", () => {
        editingViewId = view.id;
        const form = editor.querySelector("#library-view-form");
        for (const key of ["name", "source", "read", "shelfId", "maxChapters", "fresh", "aa", "pinned"]) {
          const field = form.elements.namedItem(key);
          if (field.type === "checkbox") field.checked = view.conditions[key] === true;
          else field.value = key === "name" ? view.name : view.conditions[key] ?? "";
        }
      });
      item.append(label, edit, remove); return item;
    }));
    choices(editor.querySelector('[name="shelfId"]'), "전체");
  }
  section.querySelector("#smart-library-edit").addEventListener("click", async () => {
    state = await load(); editingViewId = null; editor.querySelector("#library-view-form").reset(); editor.showModal(); renderEditor();
  });
  editor.querySelector("#library-view-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.target; const values = new FormData(form);
    const label = name(values.get("name"));
    if (!label || state.config.views.some((view) => view.name === label && view.id !== editingViewId) || (!editingViewId && state.config.views.length >= 50)) {
      editor.querySelector("#library-editor-status").textContent = "서로 다른 이름으로 50개까지 저장할 수 있어요"; return;
    }
    const conditions = sanitizeConditions({ source: values.get("source"), read: values.get("read"), shelfId: values.get("shelfId"),
      maxChapters: Number(values.get("maxChapters")), fresh: values.has("fresh"), aa: values.has("aa"), pinned: values.has("pinned") });
    const view = { id: editingViewId || `view-${crypto.randomUUID()}`, name: label, conditions };
    const views = editingViewId ? state.config.views.map((item) => item.id === editingViewId ? view : item) : [...state.config.views, view];
    if (await write({ ...state.config, views })) {
      editingViewId = null; form.reset(); renderEditor(); editor.querySelector("#library-editor-status").textContent = "저장했어요";
    }
  });
  async function openWork(work) {
    state = await load(); if (!state.canSave) return false;
    styleWork = work;
    styleDialog.querySelector("#work-style-title").textContent = work.title;
    choices(styleDialog.querySelector("select"), "미분류");
    const style = state.styles.get(work.key);
    styleDialog.querySelector("select").value = style?.deletedAt ? "" : style?.shelfId || "";
    styleDialog.querySelector('[name="pinned"]').checked = !style?.deletedAt && style?.pinned === true;
    styleDialog.querySelector("#library-style-status").textContent = "";
    styleDialog.showModal(); return true;
  }
  styleDialog.querySelector("#work-style-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.target;
    const previous = state.styles.get(styleWork.key);
    const value = { ...previous, workKey: styleWork.key, pinned: form.elements.pinned.checked, updatedAt: new Date().toISOString() };
    delete value.deletedAt;
    if (form.elements.shelfId.value) value.shelfId = form.elements.shelfId.value;
    else delete value.shelfId;
    if (await write(state.config, [value])) styleDialog.close();
  });
  styleDialog.querySelector("#library-shelf-add").addEventListener("click", async () => {
    const label = prompt("새 분류 이름"); if (label === null) return;
    const config = structuredClone(state.config); const result = addShelf(config, label);
    if (result.error) { styleDialog.querySelector("#library-style-status").textContent = "서로 다른 이름으로 분류를 만들어 주세요 (최대 50개)"; return; }
    if (await write(config)) { choices(styleDialog.querySelector("select"), "미분류"); styleDialog.querySelector("select").value = result.id; }
  });
  styleDialog.querySelector("#library-shelf-rename").addEventListener("click", async () => {
    const id = styleDialog.querySelector("select").value;
    const shelf = state.config.shelves.find((item) => item.id === id); if (!shelf) return;
    const label = prompt("분류 이름", shelf.name); if (label === null) return;
    const config = structuredClone(state.config); const result = renameShelf(config, id, label);
    if (result.error) { styleDialog.querySelector("#library-style-status").textContent = "서로 다른 이름으로 분류를 만들어 주세요"; return; }
    if (await write(config)) { choices(styleDialog.querySelector("select"), "미분류"); styleDialog.querySelector("select").value = id; }
  });
  styleDialog.querySelector("#library-shelf-remove").addEventListener("click", async () => {
    const id = styleDialog.querySelector("select").value;
    if (!id || !confirm("분류를 지울까요? 작품은 미분류로 남습니다.")) return;
    const styles = [...state.styles.values()].filter((value) => value.shelfId === id).map((value) => {
      const next = { ...value, updatedAt: new Date().toISOString() }; delete next.shelfId; return next;
    });
    if (await write({ ...state.config, shelves: state.config.shelves.filter((shelf) => shelf.id !== id) }, styles)) choices(styleDialog.querySelector("select"), "미분류");
  });
  return {
    renderHome,
    openWork,
    openPalette() { if (!palette.open) palette.showModal(); input.value = ""; input.focus(); searchPalette(); },
    close() { for (const node of [palette, viewDialog, editor, styleDialog]) if (node.open) node.close(); homeGeneration += 1; },
  };
}
