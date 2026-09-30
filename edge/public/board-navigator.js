// Board picker: a sheet with favourites, recent boards, and collapsible groups from release
// metadata (group_name → board). Selecting a row applies immediately; group headers only
// expand or collapse. Preferences stay in this browser.

const PREFS_KEY = "redstm.boardNav.v1";
const RECENT_LIMIT = 4;

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 50) : [];
    return { favorites: list(saved?.favorites), recents: list(saved?.recents), expanded: list(saved?.expanded) };
  } catch {
    return { favorites: [], recents: [], expanded: [] };
  }
}

function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

const STAR = "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z";
const CHEVRON = "m6 9 6 6 6-6";

export function createBoardNavigator({ dialog, panel, search, boards, selected, onSelect }) {
  const prefs = readPrefs();

  function persist() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
    catch { /* preferences are optional */ }
  }

  function row(board, current) {
    const item = document.createElement("li");
    item.className = "board-row";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "board-select";
    choose.dataset.board = board.id;
    if (board.id === current) choose.setAttribute("aria-current", "true");
    const name = document.createElement("span");
    name.textContent = board.name;
    choose.append(name);
    if (Number.isFinite(board.count)) {
      const count = document.createElement("small");
      count.textContent = board.count.toLocaleString("ko-KR");
      choose.append(count);
    }
    item.append(choose);
    if (board.id) {
      const favorite = prefs.favorites.includes(board.id);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "board-star";
      star.dataset.star = board.id;
      star.setAttribute("aria-pressed", String(favorite));
      star.ariaLabel = favorite ? `${board.name} 즐겨찾기 해제` : `${board.name} 즐겨찾기`;
      star.append(icon(STAR));
      item.append(star);
    }
    return item;
  }

  function section(title, rows, current) {
    const wrapper = document.createElement("section");
    wrapper.className = "board-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const list = document.createElement("ul");
    for (const board of rows) list.append(row(board, current));
    wrapper.append(heading, list);
    return wrapper;
  }

  function render() {
    const all = boards();
    const current = selected();
    const byId = new Map(all.map((board) => [board.id, board]));
    const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ko-KR");
    panel.replaceChildren();
    if (query) {
      const matches = all.filter((board) => `${board.name} ${board.group}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query));
      if (!matches.length) {
        const empty = document.createElement("p");
        empty.className = "board-empty";
        empty.textContent = "이름이 맞는 게시판이 없습니다.";
        panel.append(empty);
        return;
      }
      panel.append(section(`검색 결과 ${matches.length}`, matches, current));
      return;
    }
    const top = document.createElement("ul");
    top.className = "board-all";
    top.append(row({ id: "", name: "전체 게시판" }, current));
    panel.append(top);
    const favorites = prefs.favorites.map((id) => byId.get(id)).filter(Boolean);
    if (favorites.length) panel.append(section("즐겨찾기", favorites, current));
    const recents = prefs.recents.filter((id) => !prefs.favorites.includes(id)).map((id) => byId.get(id)).filter(Boolean);
    if (recents.length) panel.append(section("최근 본 게시판", recents, current));

    const groups = new Map();
    for (const board of all) {
      const list = groups.get(board.group) ?? [];
      list.push(board);
      groups.set(board.group, list);
    }
    let index = 0;
    for (const [group, list] of groups) {
      index += 1;
      const id = `board-group-${index}`;
      const expanded = prefs.expanded.includes(group) || list.some((board) => board.id === current);
      const wrapper = document.createElement("section");
      wrapper.className = "board-group";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "board-group-toggle";
      toggle.dataset.group = group;
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-controls", id);
      const label = document.createElement("span");
      label.textContent = group;
      const count = document.createElement("small");
      count.textContent = `${list.length}개`;
      toggle.append(label, count, icon(CHEVRON));
      const items = document.createElement("ul");
      items.id = id;
      items.hidden = !expanded;
      for (const board of list) items.append(row(board, current));
      wrapper.append(toggle, items);
      panel.append(wrapper);
    }
  }

  function open() {
    search.value = "";
    render();
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => {
      const target = panel.querySelector('.board-select[aria-current="true"]');
      target?.scrollIntoView({ block: "center" });
      (target ?? dialog.querySelector("h2")).focus({ preventScroll: true });
    });
  }

  function remember(boardId) {
    if (!boardId) return;
    prefs.recents = [boardId, ...prefs.recents.filter((id) => id !== boardId)].slice(0, RECENT_LIMIT);
    persist();
  }

  panel.addEventListener("click", (event) => {
    const star = event.target.closest("[data-star]");
    if (star) {
      const id = star.dataset.star;
      prefs.favorites = prefs.favorites.includes(id)
        ? prefs.favorites.filter((item) => item !== id)
        : [...prefs.favorites, id];
      persist();
      render();
      panel.querySelector(`[data-star="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      return;
    }
    const toggle = event.target.closest(".board-group-toggle");
    if (toggle) {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      document.getElementById(toggle.getAttribute("aria-controls")).hidden = !expanded;
      const group = toggle.dataset.group;
      prefs.expanded = expanded
        ? [...new Set([...prefs.expanded, group])]
        : prefs.expanded.filter((item) => item !== group);
      persist();
      return;
    }
    const choose = event.target.closest(".board-select");
    if (choose) {
      const id = choose.dataset.board;
      remember(id);
      dialog.close();
      onSelect(id);
    }
  });
  search.addEventListener("input", render);

  // Favourites first, then recently opened boards, for one-tap entry points outside the sheet.
  function shortcuts() {
    return [...new Set([...prefs.favorites, ...prefs.recents])];
  }

  return { open, render, remember, shortcuts };
}
