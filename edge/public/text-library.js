import { parseTitle, serialWorks } from "/text-work.js";

const STATE_KEY = "redstm.textState.v1";
const LANES = new Set(["novel", "arcalive"]);
const VIEWS = new Set([...LANES, "saved"]);
const HASH = /^[a-f0-9]{64}$/;

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (saved?.schema_version === 1 && saved.history && saved.bookmarks) return saved;
  } catch { /* use an empty local state */ }
  return { schema_version: 1, history: {}, bookmarks: {} };
}

export function createTextLibrary({ onChange = () => {}, readerPane }) {
  const list = document.querySelector("#result-list");
  const status = document.querySelector("#result-status");
  const search = document.querySelector("#search-input");
  const reader = document.querySelector("#text-reader");
  const body = document.querySelector("#text-reader-body");
  const history = readState();
  const catalogs = new Map();
  const details = new Map();
  let lane = "novel";
  let catalog = [];
  let visible = [];
  let work = null;
  let chapterSource = [];
  let chapters = [];
  let sortMode = "title";
  let folderBoard = null;
  let folderCategory = null;
  let folderWork = null;
  let current = null;
  let saveTimer;
  let requestId = 0;

  function persist() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(history)); }
    catch (error) { console.warn("Text reading state could not be saved", error); }
  }

  function identity(entry, sourceLane = lane, sourceWork = work) {
    return sourceLane === "novel"
      ? `novel:${sourceWork?.work_id}:${entry.chapter_id}`
      : String(entry.identity || `arcalive:${entry.board}:${entry.post_id}:${entry.content_lane}`);
  }

  function route() {
    const params = new URLSearchParams();
    params.set("lane", lane);
    if (search.value.trim()) params.set("q", search.value.trim());
    if (work) params.set("work", work.work_id);
    if (lane === "arcalive" && folderBoard) params.set("board", folderBoard);
    if (lane === "arcalive" && folderWork) params.set("series", folderWork);
    if (lane === "arcalive" && folderCategory) params.set("category", folderCategory);
    if (current?.lane === "novel") params.set("chapter", current.entry.chapter_id);
    if (current) params.set("item", current.identity);
    return `/text?${params}`;
  }

  function navigate(replace = false) {
    if (replace) historyReplace();
    else window.history.pushState({ redstmText: true }, "", route());
  }

  function historyReplace() {
    window.history.replaceState({ redstmText: true }, "", route());
  }

  function setReader(open) {
    reader.hidden = !open;
    document.body.classList.toggle("reader-open", open);
    onChange();
  }

  function renderRows(rows, { chaptersMode = false, folderMode = null } = {}) {
    visible = rows;
    list.replaceChildren();
    rows.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      button.dataset.index = String(index);
      const line = document.createElement("span");
      line.className = "result-title-line";
      const name = document.createElement("span");
      name.className = "result-title";
      name.textContent = folderMode ? entry.folder_label
        : chaptersMode ? (entry.label || "회차")
        : lane === "novel" ? (entry.title || entry.work_id)
          : lane === "saved" ? (entry.title || entry.entry?.label || entry.identity)
            : (entry.title || entry.category || entry.identity);
      line.append(name);
      const meta = document.createElement("span");
      meta.className = "result-meta";
      if (chaptersMode) {
        const saved = history.history[identity(entry)];
        meta.textContent = `${entry.kind || "회차"}${saved?.progress ? ` · ${Math.round(saved.progress * 100)}%` : ""}${history.bookmarks[identity(entry)] ? " · 저장됨" : ""}`;
      } else {
        meta.textContent = folderMode
          ? `${folderMode === "work" ? `${entry.folder_count.toLocaleString("ko-KR")}화` : `${folderMode === "board" ? "게시판" : entry.board} · ${entry.folder_count.toLocaleString("ko-KR")}개 글`}`
          : lane === "novel"
          ? `${entry.author || "작가 미상"} · ${entry.chapter_count ?? 0}화`
          : lane === "saved"
            ? `${entry.lane === "novel" ? entry.work?.author || "소설" : entry.entry?.board || "아카라이브"} · 저장한 자료`
            : `${entry.board || "아카라이브"} · ${entry.post_id || ""}`;
      }
      button.append(line, meta);
      const row = document.createElement("li");
      row.append(button);
      list.append(row);
    });
    document.querySelector("#result-more").hidden = true;
    document.querySelector("#search-empty").hidden = true;
    status.textContent = `${rows.length.toLocaleString("ko-KR")}개 ${chaptersMode ? "회차" : folderMode === "board" ? "게시판" : folderMode === "work" ? "작품" : folderMode === "category" ? "분류" : lane === "arcalive" ? "글" : "자료"}`;
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = catalog.length ? "검색 결과가 없습니다." : "아직 게시된 자료가 없습니다.";
      list.append(empty);
    }
  }

  function episodeRank(label) {
    const text = String(label || "").normalize("NFKC");
    const numbered = /(?:제\s*)?(\d+)\s*(?:화|話|회)/.exec(text);
    return {
      side: /외전|특별편|후기/.test(text) ? 1 : 0,
      number: numbered ? Number(numbered[1]) : Number.MAX_SAFE_INTEGER,
      label: text,
    };
  }

  function latestEpisodeNumber(label) {
    const parsed = parseTitle(String(label || ""));
    if (parsed.order && parsed.order[2] === 1) return parsed.order[3];
    const ranked = episodeRank(label);
    return ranked.number === Number.MAX_SAFE_INTEGER ? -1 : ranked.number;
  }

  function latestExplicitLabel(posts) {
    for (let index = posts.length - 1; index >= 0; index -= 1) {
      const order = posts[index].order;
      if (order && order[2] === 1) return posts[index].label || posts[index].title || "";
    }
    const last = posts[posts.length - 1];
    return last ? (last.label || last.title || "") : "";
  }

  function resolvedOrder(entry) {
    if (Array.isArray(entry.order)) return entry.order;
    return parseTitle(entry.label || entry.title || "").order;
  }

  function sameChapter(chapter, entry) {
    if (chapter.chapter_id && entry.chapter_id) return String(chapter.chapter_id) === String(entry.chapter_id);
    if (chapter.identity && entry.identity) return chapter.identity === entry.identity;
    return chapter.post_id != null && entry.post_id != null
      && String(chapter.post_id) === String(entry.post_id);
  }

  function compareChapters(left, right) {
    const id = String(left.chapter_id || left.source_chapter_id || left.post_id || "")
      .localeCompare(String(right.chapter_id || right.source_chapter_id || right.post_id || ""));
    const leftOrder = resolvedOrder(left);
    const rightOrder = resolvedOrder(right);
    if (leftOrder && rightOrder) {
      let byOrder = 0;
      for (let index = 0; index < leftOrder.length; index += 1) {
        if (leftOrder[index] !== rightOrder[index]) {
          byOrder = leftOrder[index] - rightOrder[index];
          break;
        }
      }
      if (sortMode === "title") {
        return String(left.label || "").localeCompare(String(right.label || ""), "ko-KR", { numeric: true }) || id;
      }
      return (sortMode === "latest" ? -byOrder : byOrder) || id;
    }
    const a = episodeRank(left.label);
    const b = episodeRank(right.label);
    if (sortMode === "title") {
      return a.label.localeCompare(b.label, "ko-KR", { numeric: true }) || id;
    }
    const direction = sortMode === "latest" ? -1 : 1;
    const numbered = a.number === Number.MAX_SAFE_INTEGER || b.number === Number.MAX_SAFE_INTEGER
      ? (a.number === b.number ? 0 : (a.number === Number.MAX_SAFE_INTEGER ? 1 : -1))
      : (a.number - b.number) * direction;
    return a.side - b.side || numbered
      || a.label.localeCompare(b.label, "ko-KR", { numeric: true }) || id;
  }

  function orderedChapters(rows) {
    return [...rows].sort(compareChapters);
  }

  function orderedWorks(rows) {
    const title = (left, right) => String(left.title || left.work_id || "")
      .localeCompare(String(right.title || right.work_id || ""), "ko-KR", { numeric: true })
      || String(left.work_id || "").localeCompare(String(right.work_id || ""));
    const copy = [...rows];
    if (sortMode === "longest") {
      copy.sort((left, right) => (right.chapter_count || 0) - (left.chapter_count || 0) || title(left, right));
    } else if (sortMode === "updated") {
      copy.sort((left, right) => latestEpisodeNumber(right.latest_label) - latestEpisodeNumber(left.latest_label)
        || title(left, right));
    } else copy.sort(title);
    return copy;
  }

  function renderCatalog() {
    if (work) {
      const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ko-KR");
      chapters = orderedChapters(chapterSource);
      renderRows(chapters.filter((chapter) =>
        `${chapter.label || ""} ${chapter.kind || ""}`.normalize("NFKC").toLocaleLowerCase("ko-KR")
          .includes(query)), { chaptersMode: true });
      return;
    }
    const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ko-KR");
    const matching = orderedWorks(catalog.filter((item) =>
      `${item.title || item.category || ""} ${item.author || ""} ${item.board || ""}`
        .normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query)));
    if (lane === "arcalive") {
      const group = (items, key) => {
        const grouped = new Map();
        for (const item of items) {
          const label = String(item[key] || "미분류");
          const entry = grouped.get(label) || { folder_label: label, folder_count: 0, board: folderBoard || "" };
          entry.folder_count += 1;
          grouped.set(label, entry);
        }
        return [...grouped.values()].sort((a, b) => a.folder_label.localeCompare(b.folder_label, "ko-KR"));
      };
      if (!folderBoard) return renderRows(group(matching, "board"), { folderMode: "board" });
      const boardItems = catalog.filter((item) => String(item.board) === folderBoard);
      const visibleBoard = query
        ? boardItems.filter((item) => `${item.title || ""} ${item.category || ""}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query))
        : boardItems;
      const { works, loose } = serialWorks(boardItems);
      if (works.length && !folderCategory) {
        const shownLoose = query
          ? loose.filter((post) => `${post.title || ""} ${post.category || ""}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query))
          : loose;
        if (folderWork === "단편·기타") {
          return renderRows(orderedChapters(shownLoose.map((post) => ({ ...post, label: post.title }))));
        }
        if (folderWork) {
          const found = works.find((entry) => entry.title === folderWork);
          chapterSource = found ? found.posts : [];
          chapters = orderedChapters(chapterSource);
          return renderRows(chapters.filter((chapter) =>
            `${chapter.label || ""} ${chapter.title || ""}`.normalize("NFKC").toLocaleLowerCase("ko-KR")
              .includes(query)), { chaptersMode: true });
        }
        const shownWorks = query
          ? works.filter((entry) => entry.title.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query)
            || entry.posts.some((post) => `${post.title || ""} ${post.label || ""}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(query)))
          : works;
        const folders = shownWorks.map((entry) => ({
          folder_label: entry.title,
          folder_count: entry.posts.length,
          title: entry.title,
          chapter_count: entry.posts.length,
          latest_label: latestExplicitLabel(entry.posts),
          work_id: entry.title,
        }));
        const rows = orderedWorks(folders);
        if (shownLoose.length) rows.push({ folder_label: "단편·기타", folder_count: shownLoose.length, title: "단편·기타", chapter_count: shownLoose.length, work_id: "단편·기타" });
        return renderRows(rows, { folderMode: "work" });
      }
      if (!folderCategory) return renderRows(group(visibleBoard, "category"), { folderMode: "category" });
      return renderRows(visibleBoard.filter((item) => String(item.category || "미분류") === folderCategory));
    }
    renderRows(matching);
  }

  function syncBackButton() {
    const button = document.querySelector("#text-work-back");
    const visible = Boolean(work || folderBoard);
    button.hidden = !visible;
    button.textContent = work ? "← 작품 목록"
      : folderWork ? `← ${folderBoard}`
      : folderCategory ? `← ${folderBoard}` : "← 아카라이브";
  }

  async function json(path) {
    const response = await fetch(path, { credentials: "same-origin", redirect: "error" });
    if (!response.ok) throw new Error(`request_${response.status}`);
    return response.json();
  }

  async function loadCatalog(selectedLane) {
    const pointer = await json(`/api/v1/text/release/${selectedLane}`).catch((error) => {
      if (selectedLane === "novel" && error.message === "request_404") throw new Error("novel_unpublished");
      throw error;
    });
    if (pointer.schema !== 1 || pointer.lane !== selectedLane || !HASH.test(pointer.sha256)) {
      throw new Error("release_pointer_invalid");
    }
    if (catalogs.get(selectedLane)?.sha256 === pointer.sha256) return catalogs.get(selectedLane).items;
    const release = await json(`/api/v1/text/release-manifest/${selectedLane}/${pointer.sha256}.json`);
    if (release.schema !== 1 || release.lane !== selectedLane || !Array.isArray(release.catalog_pages)) {
      throw new Error("release_manifest_invalid");
    }
    const items = [];
    for (const ref of release.catalog_pages) {
      const match = new RegExp(`^published/indexes/${selectedLane}/([a-f0-9]{64})\\.json$`).exec(ref.key || "");
      if (!match || ref.sha256 !== match[1]) throw new Error("catalog_reference_invalid");
      const page = await json(`/api/v1/text/index/${selectedLane}/${match[1]}.json`);
      if (page.schema !== 1 || page.lane !== selectedLane || !Array.isArray(page.items)) {
        throw new Error("catalog_page_invalid");
      }
      items.push(...page.items);
    }
    catalogs.set(selectedLane, { sha256: pointer.sha256, items });
    if (selectedLane === "novel") details.clear();
    return items;
  }

  async function open(options = {}) {
    const activeRequest = ++requestId;
    flushPosition();
    const params = options instanceof URLSearchParams ? options : new URLSearchParams();
    const requestedLane = params.get("lane");
    lane = VIEWS.has(requestedLane) ? requestedLane : "novel";
    for (const button of document.querySelectorAll("[data-text-lane]")) {
      const active = button.dataset.textLane === lane;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    search.value = params.get("q") || "";
    work = null;
    chapterSource = [];
    chapters = [];
    folderBoard = lane === "arcalive" ? params.get("board") : null;
    folderWork = lane === "arcalive" ? params.get("series") : null;
    folderCategory = lane === "arcalive" ? params.get("category") : null;
    current = null;
    syncBackButton();
    setReader(false);
    catalog = [];
    visible = [];
    list.replaceChildren();
    status.textContent = "목록을 불러오는 중…";
    try {
      const loaded = lane === "saved"
        ? Object.entries(history.bookmarks).map(([key, saved]) => ({ ...saved, identity: key }))
          .filter((saved) => saved.entry && LANES.has(saved.lane) && HASH.test(saved.entry.sha256 || ""))
        : await loadCatalog(lane);
      if (activeRequest !== requestId) return;
      catalog = loaded;
      renderCatalog();
      onChange();
      const workId = params.get("work");
      if (workId && lane === "novel") {
        const found = catalog.find((item) => item.work_id === workId);
        if (found) await openWork(found, false, params.get("chapter"), activeRequest);
      } else if (params.has("item") && lane === "arcalive") {
        const found = catalog.find((item) => item.identity === params.get("item"));
        if (found) await openBody(found, false, lane, work, "", activeRequest);
      } else if (params.has("item") && lane === "saved") {
        const found = catalog.find((item) => item.identity === params.get("item"));
        if (found) await openBody(found.entry, false, found.lane, found.work, found.identity, activeRequest);
      }
    } catch (error) {
      if (activeRequest !== requestId) return;
      if (lane === "novel" && error.message === "novel_unpublished") {
        if (!params.has("lane")) {
          const fallback = new URLSearchParams(params);
          fallback.set("lane", "arcalive");
          await open(fallback);
          if (location.pathname === "/text" && lane === "arcalive") historyReplace();
          return;
        }
        catalog = [];
        renderCatalog();
        status.textContent = "소설은 아직 게시되지 않았습니다 · 아카라이브는 열람할 수 있습니다.";
        return;
      }
      status.textContent = `텍스트 목록을 불러오지 못했습니다 · ${error.message}`;
      list.replaceChildren();
    }
  }

  async function openWork(item, shouldNavigate = true, chapterId = null, activeRequest = ++requestId) {
    let detail = details.get(item.work_id);
    if (!detail) {
      const hash = item.detail_key?.match(/\/([a-f0-9]{64})\.json$/)?.[1];
      if (!hash) throw new Error("work_index_invalid");
      detail = await json(`/api/v1/text/index/novel/${hash}.json`);
      if (detail.schema !== 1 || detail.lane !== "novel" || !Array.isArray(detail.chapters)) {
        throw new Error("work_detail_invalid");
      }
      details.set(item.work_id, detail);
    }
    if (activeRequest !== requestId) return;
    work = item;
    syncBackButton();
    chapterSource = detail.chapters;
    current = null;
    onChange();
    renderCatalog();
    status.textContent = `${item.title || "작품"} · ${chapters.length}화`;
    setReader(false);
    if (shouldNavigate) navigate();
    if (chapterId) {
      const chapter = chapters.find((entry) => String(entry.chapter_id) === chapterId);
      if (chapter) await openBody(chapter, false, lane, work, "", activeRequest);
    }
  }

  async function openBody(entry, shouldNavigate = true, sourceLane = lane, sourceWork = work, savedIdentity = "", activeRequest = ++requestId) {
    flushPosition();
    const viewLane = lane;
    const currentLane = viewLane === "saved" ? sourceLane : viewLane;
    const itemWork = viewLane === "saved" ? sourceWork : work;
    const hash = entry.sha256;
    if (!HASH.test(hash || "")) throw new Error("object_hash_invalid");
    const response = await fetch(`/api/v1/text/object/${hash}`, { credentials: "same-origin", redirect: "error" });
    if (!response.ok) throw new Error(`request_${response.status}`);
    const text = await response.text();
    if (activeRequest !== requestId) return;
    const isNovel = currentLane === "novel";
    const entryIdentity = savedIdentity || identity(entry, currentLane, itemWork);
    current = { lane: currentLane, viewLane, entry, identity: entryIdentity, work: itemWork };
    document.querySelector("#text-reader-kicker").textContent = isNovel ? "소설" : "아카라이브";
    document.querySelector("#text-reader-title").textContent = isNovel ? (itemWork?.title || "소설") : (entry.title || "아카라이브 글");
    document.querySelector("#text-reader-meta").textContent = isNovel
      ? `${itemWork?.author || "작가 미상"} · ${entry.label || "회차"}`
      : `${entry.board || "아카라이브"} · ${entry.category || "미분류"} · ${entry.post_id || ""} · ${entry.content_lane || "text"}`;
    body.textContent = isNovel ? text : arcaliveBody(text);
    const record = history.history[entryIdentity] || {};
    history.history[entryIdentity] = { readAt: new Date().toISOString(), ...record };
    history.history[entryIdentity].readAt = new Date().toISOString();
    persist();
    const progress = document.querySelector("#text-reading-progress");
    progress.style.width = `${Math.round((record.progress || 0) * 100)}%`;
    progress.setAttribute("aria-valuenow", String(Math.round((record.progress || 0) * 100)));
    updateBookmark();
    const inSerial = isNovel || (currentLane === "arcalive" && folderWork && folderWork !== "단편·기타");
    const position = chapters.findIndex((chapter) => sameChapter(chapter, entry));
    for (const id of ["text-reader-previous", "text-reader-bottom-previous"]) {
      document.querySelector(`#${id}`).disabled = !inSerial || position <= 0;
    }
    for (const id of ["text-reader-next", "text-reader-bottom-next"]) {
      document.querySelector(`#${id}`).disabled = !inSerial || position < 0 || position >= chapters.length - 1;
    }
    setReader(true);
    readerPane.scrollTop = record.scroll || 0;
    requestAnimationFrame(() => document.querySelector("#text-reader-title").focus({ preventScroll: true }));
    if (shouldNavigate) navigate();
  }

  function arcaliveBody(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (!lines[0]?.startsWith("# ")) return text;
    const separator = lines.findIndex((line, index) => index > 0 && index < 16 && line === "---");
    return separator < 0 ? text : lines.slice(separator + 1).join("\n").replace(/^\n+/, "");
  }

  function updateBookmark() {
    const saved = Boolean(current && history.bookmarks[current.identity]);
    const button = document.querySelector("#text-reader-bookmark");
    button.setAttribute("aria-pressed", String(saved));
    button.textContent = saved ? "★" : "☆";
    button.title = saved ? "저장 취소" : "저장";
    const bottom = document.querySelector("#text-reader-bottom-bookmark");
    bottom.textContent = saved ? "저장됨" : "저장";
    bottom.setAttribute("aria-pressed", String(saved));
  }

  function back() {
    ++requestId;
    if (current) {
      flushPosition();
      current = null;
      setReader(false);
      renderCatalog();
      navigate();
    } else if (work) {
      work = null;
      chapterSource = [];
      chapters = [];
      syncBackButton();
      onChange();
      renderCatalog();
      status.textContent = `${catalog.length.toLocaleString("ko-KR")}개 작품`;
      navigate();
    } else if (folderWork) {
      folderWork = null;
      chapterSource = [];
      chapters = [];
      syncBackButton();
      onChange();
      renderCatalog();
      navigate();
    } else if (folderCategory) {
      folderCategory = null;
      syncBackButton();
      renderCatalog();
      navigate();
    } else if (folderBoard) {
      folderBoard = null;
      syncBackButton();
      renderCatalog();
      navigate();
    }
  }

  function activate(button) {
    const index = Number(button.dataset.index);
    if (Number.isInteger(index) && index >= 0 && index < visible.length) {
      const saved = visible[index];
      if (lane === "arcalive" && !folderBoard) {
        folderBoard = saved.folder_label;
        folderWork = null;
        syncBackButton();
        onChange();
        renderCatalog();
        navigate();
        return;
      }
      if (lane === "arcalive" && !folderWork && !folderCategory && saved.folder_label && saved.chapter_count) {
        folderWork = saved.folder_label;
        syncBackButton();
        onChange();
        renderCatalog();
        navigate();
        return;
      }
      if (lane === "arcalive" && !folderCategory && !folderWork) {
        folderCategory = saved.folder_label;
        syncBackButton();
        renderCatalog();
        navigate();
        return;
      }
      const action = lane === "saved"
        ? openBody(saved.entry, true, saved.lane, saved.work, saved.identity)
        : work ? openBody(saved) : lane === "novel" ? openWork(saved) : openBody(saved);
      void action.catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; });
    }
  }

  function searchChanged(query) {
    if (query !== search.value) search.value = query;
    if (!catalog.length) return;
    renderCatalog();
    navigate(true);
  }

  function changeLane(nextLane) {
    if (!VIEWS.has(nextLane) || nextLane === lane) return;
    flushPosition();
    lane = nextLane;
    work = null;
    chapterSource = [];
    chapters = [];
    folderBoard = null;
    folderWork = null;
    folderCategory = null;
    current = null;
    setReader(false);
    void open(new URLSearchParams({ lane, q: search.value }));
    navigate(true);
  }

  function savePosition() {
    if (!current) return;
    const max = Math.max(0, readerPane.scrollHeight - readerPane.clientHeight);
    const scroll = readerPane.scrollTop;
    const old = history.history[current.identity] || {};
    history.history[current.identity] = {
      readAt: old.readAt || new Date().toISOString(),
      scroll,
      progress: max ? Math.min(1, scroll / max) : 0,
    };
    const percent = Math.round(history.history[current.identity].progress * 100);
    const progress = document.querySelector("#text-reading-progress");
    progress.style.width = `${percent}%`;
    progress.setAttribute("aria-valuenow", String(percent));
    persist();
  }

  function flushPosition() {
    clearTimeout(saveTimer);
    if (current) savePosition();
  }

  document.querySelector("#text-lanes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-text-lane]");
    if (button) changeLane(button.dataset.textLane);
  });
  document.querySelector("#text-work-back").addEventListener("click", () => {
    if (!current && (work || folderBoard)) back();
  });
  document.querySelector("#text-reader-back").addEventListener("click", back);
  document.querySelector("#text-reader-bottom-list").addEventListener("click", back);
  document.querySelector("#text-reader-bookmark").addEventListener("click", toggleBookmark);
  document.querySelector("#text-reader-bottom-bookmark").addEventListener("click", toggleBookmark);
  document.querySelector("#text-reader-previous").addEventListener("click", () => moveChapter(-1));
  document.querySelector("#text-reader-bottom-previous").addEventListener("click", () => moveChapter(-1));
  document.querySelector("#text-reader-next").addEventListener("click", () => moveChapter(1));
  document.querySelector("#text-reader-bottom-next").addEventListener("click", () => moveChapter(1));
  for (const id of ["text-reader-settings", "text-reader-bottom-settings"]) {
    document.querySelector(`#${id}`).addEventListener("click", () => document.querySelector("#reader-settings").click());
  }
  readerPane.addEventListener("scroll", () => {
    if (!current) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 250);
  }, { passive: true });

  function toggleBookmark() {
    if (!current) return;
    if (history.bookmarks[current.identity]) delete history.bookmarks[current.identity];
    else history.bookmarks[current.identity] = {
      savedAt: new Date().toISOString(),
      lane: current.lane,
      entry: current.entry,
      work: current.lane === "novel" ? current.work : null,
      title: current.lane === "novel" ? current.work?.title : current.entry.title || current.entry.category,
    };
    persist();
    updateBookmark();
    renderCatalog();
  }

  function moveChapter(delta) {
    const inSerial = current && chapters.length && (
      current.lane === "novel" || (current.lane === "arcalive" && folderWork && folderWork !== "단편·기타")
    );
    if (!inSerial) return;
    const index = chapters.findIndex((chapter) => sameChapter(chapter, current.entry));
    if (index < 0) return;
    const target = chapters[index + delta];
    if (target) void openBody(target);
  }

  function sortContext() {
    if ((lane === "novel" && work) || (lane === "arcalive" && folderWork && folderWork !== "단편·기타")) return "chapters";
    if (lane === "novel" || (lane === "arcalive" && folderBoard && !folderCategory)) return "works";
    return "titles";
  }

  function setSort(value) {
    const allowed = new Set(["oldest", "latest", "title", "longest", "updated"]);
    const next = allowed.has(value) ? value : (sortContext() === "chapters" ? "oldest" : "title");
    if (next === sortMode) return;
    sortMode = next;
    renderCatalog();
  }

  function isReading() { return Boolean(current); }
  function inWork() { return Boolean(work); }
  function currentRoute() { return route(); }
  function leave() {
    ++requestId;
    flushPosition();
    current = null;
    work = null;
    chapterSource = [];
    chapters = [];
    folderBoard = null;
    folderWork = null;
    folderCategory = null;
    syncBackButton();
    reader.hidden = true;
    document.body.classList.remove("reader-open");
  }

  return {
    open, searchChanged, activate, isReading, inWork, sortContext, setSort, currentRoute, leave, changeLane,
  };
}
