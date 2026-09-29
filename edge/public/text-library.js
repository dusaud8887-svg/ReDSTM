import { captureListAnchor, loadListPosition, restoreListAnchor, saveListPosition } from "/list-anchor.js";
import { adjacentInSequence, labelGap } from "/sequence.js";
import {
  arcaliveBody, migrateNovelChapterState, migrateNovelState, novelBody, novelRecordWorkId, orderChapters,
} from "/text-work.js";

const STATE_KEY = "redstm.textState.v1";
const LANES = new Set(["novel", "arcalive"]);
const VIEWS = new Set([...LANES, "saved"]);
const HASH = /^[a-f0-9]{64}$/;
const FINISHED = 0.95;
const HISTORY_LIMIT = 10_000;
const ROW_SELECTOR = ".result-item[data-key]";
const LIST_PAGE = 10;
const SORT_LABELS = { oldest: "오래된순", latest: "최신순", title: "이름순", longest: "편수 많은순", updated: "최신 화순" };

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (saved?.schema_version === 1 && saved.history && saved.bookmarks) return saved;
  } catch { /* use an empty local state */ }
  return { schema_version: 1, history: {}, bookmarks: {} };
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function chapterKind(kind) {
  if (!kind || kind === "main") return "";
  return { side: "외전", extra: "외전", special: "특별편", prologue: "프롤로그", epilogue: "에필로그" }[kind] ?? kind;
}

export function createTextLibrary({ onChange = () => {}, readerPane, shell }) {
  const list = document.querySelector("#result-list");
  const status = document.querySelector("#result-status");
  const search = document.querySelector("#search-input");
  const history = readState();
  const catalogs = new Map();
  const details = new Map();
  let lane = "novel";
  let catalog = [];
  let arcaliveWorks = [];
  let arcaliveView = "files";
  let visible = [];
  let work = null;
  let chapterSource = [];
  let sortMode = "title";
  let folderBoard = null;
  let folderCategory = null;
  // current: the open body. sequence: its reading order, frozen when the body opened.
  let current = null;
  let sequence = null;
  let saveTimer;
  let requestId = 0;
  let moving = false;
  // Page of the list shown under the body; null follows the current chapter.
  let listPage = null;
  // True between open() and leave(): the library owns the shared result list.
  let active = false;

  // The whole state is rewritten every few hundred ms while reading, so opened chapters are
  // capped (oldest first) instead of growing until localStorage runs out.
  function pruneHistory() {
    const keys = Object.keys(history.history);
    if (keys.length <= HISTORY_LIMIT) return;
    keys.sort((left, right) => String(history.history[right].readAt || "").localeCompare(String(history.history[left].readAt || "")));
    for (const key of keys.slice(HISTORY_LIMIT)) delete history.history[key];
  }

  // Failures show in the shared archive state label, the same way TypeMoon reading state does.
  function persist() {
    const archiveState = document.querySelector("#archive-state");
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(history));
      if (archiveState) delete archiveState.dataset.storageFailed;
      if (archiveState?.textContent === "로컬 저장 실패") archiveState.textContent = "보존본";
    } catch (error) {
      if (archiveState) {
        archiveState.dataset.storageFailed = "true";
        archiveState.textContent = "로컬 저장 실패";
      }
      console.warn("Text reading state could not be saved", error);
    }
  }

  // Another tab saved text reading state: take it over (every save writes the whole object, so
  // keeping the old copy would erase that tab's records on this tab's next save).
  window.addEventListener("storage", (event) => {
    if (event.key !== STATE_KEY || !event.newValue) return;
    const incoming = readState();
    history.history = incoming.history;
    history.bookmarks = incoming.bookmarks;
    // The result list is shared with TypeMoon screens; redraw only while the library owns it.
    if (!active) return;
    if (current) {
      updateBookmark();
      publishList();
    } else if (catalog.length || lane === "saved") {
      if (lane === "saved") catalog = savedEntries();
      renderCatalog();
    }
  });

  function identity(entry, sourceLane = lane, sourceWork = work) {
    return sourceLane === "novel"
      ? `novel:${sourceWork?.work_id}:${entry.chapter_id}`
      : String(entry.identity || `arcalive:${entry.board}:${entry.post_id}:${entry.content_lane}`);
  }

  function listParams() {
    const params = new URLSearchParams();
    params.set("lane", lane);
    if (search.value.trim()) params.set("q", search.value.trim());
    if (work) params.set("work", work.work_id);
    if (lane === "arcalive" && arcaliveView === "works") params.set("view", "works");
    if (lane === "arcalive" && arcaliveView === "files" && folderBoard) params.set("board", folderBoard);
    if (lane === "arcalive" && arcaliveView === "files" && folderCategory) params.set("category", folderCategory);
    if (sortMode !== defaultSort()) params.set("sort", sortMode);
    return params;
  }

  function defaultSort() {
    return work ? "oldest" : "title";
  }

  function readSort(params) {
    const requested = params.get("sort");
    sortMode = SORT_LABELS[requested] ? requested : defaultSort();
  }

  function listRoute() {
    return `/text?${listParams()}`;
  }

  function route() {
    const params = listParams();
    if (current?.lane === "novel") params.set("chapter", current.entry.chapter_id);
    if (current) params.set("item", current.identity);
    return `/text?${params}`;
  }

  function pushRoute(extra = {}) {
    const parent = `${location.pathname}${location.search}`;
    window.history.pushState({ redstmText: true, redstmParent: parent, ...extra }, "", route());
  }

  function replaceRoute(extra = {}) {
    window.history.replaceState({ ...(window.history.state ?? {}), redstmText: true, ...extra }, "", route());
  }

  function rowKey(entry, { chaptersMode, folderMode }) {
    if (folderMode) return `folder:${entry.folder_label}`;
    // Arcalive work chapters have no chapter id; their identity is unique where titles repeat.
    if (chaptersMode) return `chapter:${entry.chapter_id ?? entry.source_chapter_id ?? entry.identity ?? entry.label}`;
    if (entry.work_id) return `work:${entry.work_id}`;
    return String(entry.identity ?? entry.post_id ?? entry.title);
  }

  // { finished, reading, lastReadAt } per novel work, from local reading records.
  function workProgress() {
    const knownWorkIds = new Set((catalogs.get("novel")?.items ?? []).map((item) => item.work_id));
    const progress = new Map();
    for (const [key, record] of Object.entries(history.history)) {
      const workId = record ? novelRecordWorkId(key, record, knownWorkIds) : null;
      if (!workId) continue;
      const item = progress.get(workId) ?? { finished: 0, reading: 0, lastReadAt: "", record: null };
      const value = record.progress ?? 0;
      if (value >= FINISHED) item.finished += 1;
      else if (value > 0) item.reading += 1;
      if (String(record.readAt || "") > item.lastReadAt) {
        item.lastReadAt = String(record.readAt || "");
        item.record = record;
      }
      progress.set(workId, item);
    }
    return progress;
  }

  function lastReadChapter() {
    if (!work) return null;
    let latest = null;
    for (const chapter of chapterSource) {
      const record = history.history[identity(chapter, lane, work)];
      if (record?.readAt && (!latest || record.readAt > latest.record.readAt)) latest = { chapter, record };
    }
    return latest;
  }

  function renderRows(rows, { chaptersMode = false, folderMode = null } = {}) {
    visible = rows;
    list.replaceChildren();
    const fragment = document.createDocumentFragment();
    const resume = chaptersMode ? lastReadChapter() : null;
    const works = !chaptersMode && !folderMode && lane === "novel" ? workProgress() : null;
    // A work not started yet offers its first chapter the same way (not while searching).
    const start = chaptersMode && !resume && !search.value.trim() ? canonicalChapters(chapterSource)[0] : null;
    if (resume || start) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item continue-row";
      button.dataset.continue = "true";
      const line = document.createElement("span");
      line.className = "result-title-line";
      const name = document.createElement("span");
      name.className = "result-title";
      const target = resume ? resumeTarget() : start;
      name.textContent = `${resume ? "이어 읽기" : "처음부터 읽기"} · ${target?.label || "회차"}`;
      line.append(name);
      const meta = document.createElement("span");
      meta.className = "result-meta";
      const percent = Math.round((resume?.record.progress ?? 0) * 100);
      meta.textContent = !resume ? `전체 ${canonicalChapters(chapterSource).length.toLocaleString("ko-KR")}화`
        : percent >= FINISHED * 100 ? `${resume.chapter.label || "이전 회차"} 다 읽음 · 다음 회차` : `${percent}% 읽음`;
      button.append(line, meta);
      const row = document.createElement("li");
      row.append(button);
      fragment.append(row);
    }
    rows.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      button.dataset.index = String(index);
      button.dataset.key = rowKey(entry, { chaptersMode, folderMode });
      const line = document.createElement("span");
      line.className = "result-title-line";
      const name = document.createElement("span");
      name.className = "result-title";
      name.textContent = folderMode ? entry.folder_label
        : chaptersMode ? (entry.label || "회차")
        : entry.work_id ? (entry.title || entry.work_id)
          : lane === "saved" ? (entry.title || entry.entry?.label || entry.identity)
            : (entry.title || entry.category || entry.identity);
      line.append(name);
      const meta = document.createElement("span");
      meta.className = "result-meta";
      if (chaptersMode) {
        const key = identity(entry, lane, work);
        const saved = history.history[key];
        const progress = saved?.progress ?? 0;
        const parts = [
          chapterKind(entry.kind),
          progress >= FINISHED ? "다 읽음" : progress > 0 ? `${Math.round(progress * 100)}%` : saved ? "열어 봄" : "",
          history.bookmarks[key] ? "저장됨" : "",
        ].filter(Boolean);
        meta.textContent = parts.join(" · ");
        button.classList.toggle("read", progress >= FINISHED);
        if (resume?.chapter === entry) {
          button.classList.add("current");
          button.setAttribute("aria-current", "true");
        }
      } else {
        meta.textContent = folderMode
          ? `${folderMode === "board" ? "게시판" : entry.board} · ${entry.folder_count.toLocaleString("ko-KR")}개 글`
          : entry.work_id
          ? workRowMeta(entry, works?.get(entry.work_id))
          : lane === "saved"
            ? [entry.lane === "novel" ? `${entry.entry?.label || "회차"}` : entry.entry?.board || "아카라이브",
              ...(entry.tags ?? []).map((tag) => `#${tag}`), entry.note || ""].filter(Boolean).join(" · ")
            : [entry.author, entry.category, entry.board].filter(Boolean).join(" · ") || "아카라이브";
      }
      if (meta.textContent) button.append(line, meta);
      else button.append(line);
      const row = document.createElement("li");
      row.append(button);
      fragment.append(row);
    });
    list.append(fragment);
    document.querySelector("#result-more").hidden = true;
    document.querySelector("#search-empty").hidden = true;
    status.textContent = chaptersMode
      ? chapterStatus(rows.length)
      : `${rows.length.toLocaleString("ko-KR")}개 ${folderMode === "board" ? "게시판" : folderMode === "category" ? "분류" : arcaliveView === "works" && lane === "arcalive" && !work ? "작품" : lane === "arcalive" ? "글" : "자료"}`;
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = catalog.length ? "검색 결과가 없습니다." : "아직 게시된 자료가 없습니다.";
      list.append(empty);
    }
  }

  function chapterStatus(shown) {
    const total = chapterSource.length;
    let finished = 0;
    for (const chapter of chapterSource) {
      if ((history.history[identity(chapter, lane, work)]?.progress ?? 0) >= FINISHED) finished += 1;
    }
    return [
      work?.title || "작품",
      work?.author || "",
      shown === total ? `${total.toLocaleString("ko-KR")}화` : `${shown.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}화`,
      `읽음 ${finished.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}`,
    ].filter(Boolean).join(" · ");
  }

  function workRowMeta(entry, progress) {
    const total = entry.chapter_count ?? 0;
    const parts = [entry.author || "작가 미상", `${total}화`];
    if (progress) {
      parts.push(`읽음 ${progress.finished}/${total}`);
      if (progress.record?.title) parts.push(`최근 ${progress.record.title}`);
    }
    return parts.join(" · ");
  }

  function sameChapter(chapter, entry) {
    if (chapter.chapter_id && entry.chapter_id) {
      return String(chapter.chapter_id) === String(entry.chapter_id)
        || chapter.legacy_chapter_ids?.includes(String(entry.chapter_id))
        || entry.legacy_chapter_ids?.includes(String(chapter.chapter_id));
    }
    if (chapter.identity && entry.identity) return chapter.identity === entry.identity;
    return chapter.post_id != null && entry.post_id != null
      && String(chapter.post_id) === String(entry.post_id);
  }

  // The published detail is in reading order; list sorting never changes navigation.
  function canonicalChapters(rows) {
    return orderChapters(rows, "oldest");
  }

  function orderedWorks(rows) {
    const title = (left, right) => String(left.title || left.work_id || "")
      .localeCompare(String(right.title || right.work_id || ""), "ko-KR", { numeric: true })
      || String(left.work_id || "").localeCompare(String(right.work_id || ""));
    const copy = [...rows];
    if (sortMode === "longest") {
      copy.sort((left, right) => (right.chapter_count || 0) - (left.chapter_count || 0) || title(left, right));
    } else if (sortMode === "updated") {
      copy.sort((left, right) => String(right.last_imported_at || "").localeCompare(String(left.last_imported_at || ""))
        || title(left, right));
    } else copy.sort(title);
    return copy;
  }

  function renderCatalog() {
    const query = normalize(search.value.trim());
    if (work) {
      const displayed = orderChapters(chapterSource, sortMode);
      renderRows(displayed.filter((chapter) => normalize(`${chapter.label || ""} ${chapterKind(chapter.kind)}`).includes(query)),
        { chaptersMode: true });
      return;
    }
    if (lane === "arcalive" && arcaliveView === "works") {
      return renderRows(orderedWorks(arcaliveWorks.filter((item) =>
        normalize(`${item.title} ${item.author} ${item.board} ${item.category}`).includes(query))));
    }
    const matching = orderedWorks(catalog.filter((item) =>
      normalize(`${item.title || item.category || ""} ${item.author || ""} ${item.board || ""} ${item.note || ""} ${(item.tags ?? []).join(" ")}`).includes(query)));
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
      const boardItems = catalog.filter((item) => String(item.board || "미분류") === folderBoard);
      const visibleBoard = query
        ? boardItems.filter((item) => normalize(`${item.title || ""} ${item.author || ""} ${item.category || ""}`).includes(query))
        : boardItems;
      if (!folderCategory) return renderRows(group(visibleBoard, "category"), { folderMode: "category" });
      return renderRows(visibleBoard.filter((item) => String(item.category || "미분류") === folderCategory));
    }
    renderRows(matching);
  }

  function rememberListPosition() {
    saveListPosition(listRoute(), captureListAnchor(list, ROW_SELECTOR));
  }

  function restoreListPosition() {
    const snapshot = loadListPosition(listRoute());
    requestAnimationFrame(() => {
      if (snapshot) restoreListAnchor(list, snapshot, ROW_SELECTOR);
      else list.scrollTop = 0;
    });
  }

  function syncBackButton() {
    const button = document.querySelector("#text-work-back");
    const shown = Boolean(work || folderBoard);
    button.hidden = !shown;
    button.textContent = work ? "← 작품 목록"
      : folderCategory ? `← ${folderBoard}` : "← 아카라이브";
  }

  async function json(path) {
    const response = await fetch(path, { credentials: "same-origin", redirect: "error" });
    if (!response.ok) throw new Error(`request_${response.status}`);
    return response.json();
  }

  async function loadCatalog(selectedLane, onFirstPage) {
    const pointer = await json(`/api/v1/text/release/${selectedLane}`).catch((error) => {
      if (selectedLane === "novel" && error.message === "request_404") throw new Error("novel_unpublished");
      throw error;
    });
    if (pointer.schema !== 1 || pointer.lane !== selectedLane || !HASH.test(pointer.sha256)) {
      throw new Error("release_pointer_invalid");
    }
    if (catalogs.get(selectedLane)?.sha256 === pointer.sha256) {
      if (selectedLane === "arcalive") arcaliveWorks = catalogs.get(selectedLane).works;
      return catalogs.get(selectedLane).items;
    }
    const release = await json(`/api/v1/text/release-manifest/${selectedLane}/${pointer.sha256}.json`);
    if (release.schema !== 1 || release.lane !== selectedLane || !Array.isArray(release.catalog_pages)) {
      throw new Error("release_manifest_invalid");
    }
    const catalogPage = async (ref) => {
      const match = new RegExp(`^published/indexes/${selectedLane}/([a-f0-9]{64})\\.json$`).exec(ref.key || "");
      if (!match || ref.sha256 !== match[1]) throw new Error("catalog_reference_invalid");
      const page = await json(`/api/v1/text/index/${selectedLane}/${match[1]}.json`);
      if (page.schema !== 1 || page.lane !== selectedLane || !Array.isArray(page.items)) {
        throw new Error("catalog_page_invalid");
      }
      return page.items;
    };
    const workPage = async (ref) => {
      const match = /^published\/indexes\/arcalive\/([a-f0-9]{64})\.json$/.exec(ref.key || "");
      if (!match || ref.sha256 !== match[1]) throw new Error("work_catalog_reference_invalid");
      const page = await json(`/api/v1/text/index/arcalive/${match[1]}.json`);
      if (page.schema !== 1 || page.lane !== "arcalive" || page.view !== "works" || !Array.isArray(page.items)) {
        throw new Error("work_catalog_page_invalid");
      }
      return page.items;
    };
    // The first page shows as soon as it arrives; the rest load together, kept in page order.
    const [firstRef, ...restRefs] = release.catalog_pages;
    const items = firstRef ? [...await catalogPage(firstRef)] : [];
    if (firstRef && onFirstPage) onFirstPage(items.slice());
    const [rest, workPages] = await Promise.all([
      Promise.all(restRefs.map(catalogPage)),
      selectedLane === "arcalive" ? Promise.all((release.work_catalog_pages ?? []).map(workPage)) : [],
    ]);
    for (const page of rest) items.push(...page);
    const works = workPages.flat();
    if (selectedLane === "arcalive") arcaliveWorks = works;
    catalogs.set(selectedLane, { sha256: pointer.sha256, items, works });
    details.clear();
    return items;
  }

  async function workDetail(item) {
    const cached = details.get(item.work_id);
    if (cached) return cached;
    const hash = item.detail_key?.match(/\/([a-f0-9]{64})\.json$/)?.[1];
    if (!hash) throw new Error("work_index_invalid");
    const detailLane = item.work_id.startsWith("arcalive:") ? "arcalive" : "novel";
    const detail = await json(`/api/v1/text/index/${detailLane}/${hash}.json`);
    if (detail.schema !== 1 || detail.lane !== detailLane || !Array.isArray(detail.chapters)) {
      throw new Error("work_detail_invalid");
    }
    if (detailLane === "novel" && migrateNovelChapterState(history, item, detail.chapters)) persist();
    details.set(item.work_id, detail);
    return detail;
  }

  // A saved chapter may point at a work index from an older release; fall back to the current
  // catalog so saved entries still get a previous/next order.
  async function savedWorkChapters(savedWork) {
    try {
      return (await workDetail(savedWork)).chapters;
    } catch {
      const workLane = savedWork.work_id.startsWith("arcalive:") ? "arcalive" : "novel";
      let items = workLane === "arcalive" ? catalogs.get("arcalive")?.works : catalogs.get("novel")?.items;
      if (!items) {
        await loadCatalog(workLane).catch(() => []);
        items = workLane === "arcalive" ? arcaliveWorks : catalogs.get("novel")?.items;
      }
      items ||= [];
      const found = items.find((item) => item.work_id === savedWork.work_id
        || item.legacy_work_ids?.includes(savedWork.work_id));
      return found ? (await workDetail(found)).chapters : [];
    }
  }

  function setLaneButtons() {
    for (const button of document.querySelectorAll("[data-text-lane]")) {
      const active = button.dataset.textLane === lane;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const views = document.querySelector("#arcalive-views");
    views.hidden = lane !== "arcalive";
    for (const button of views.querySelectorAll("[data-arcalive-view]")) {
      const active = button.dataset.arcaliveView === arcaliveView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  async function open(options = {}) {
    active = true;
    const activeRequest = ++requestId;
    flushPosition();
    const params = options instanceof URLSearchParams ? options : new URLSearchParams();
    const requestedLane = params.get("lane");
    lane = VIEWS.has(requestedLane) ? requestedLane : "novel";
    arcaliveView = params.get("view") === "works" ? "works" : "files";
    setLaneButtons();
    search.value = params.get("q") || "";
    work = null;
    chapterSource = [];
    folderBoard = lane === "arcalive" && arcaliveView === "files" ? params.get("board") : null;
    folderCategory = lane === "arcalive" && arcaliveView === "files" ? params.get("category") : null;
    readSort(params);
    closeReader();
    syncBackButton();
    catalog = [];
    visible = [];
    list.replaceChildren();
    status.textContent = "목록을 불러오는 중…";
    try {
      const loaded = lane === "saved"
        ? savedEntries()
        : await loadCatalog(lane, (first) => {
          if (activeRequest !== requestId) return;
          catalog = first;
          renderCatalog();
          status.textContent = "목록 첫 화면 · 나머지를 불러오는 중…";
        });
      if (activeRequest !== requestId) return;
      catalog = loaded;
      if (lane === "novel" && migrateNovelState(history, catalog)) persist();
      renderCatalog();
      onChange();
      const opened = await openFromParams(params, activeRequest);
      if (!opened && activeRequest === requestId) restoreListPosition();
    } catch (error) {
      if (activeRequest !== requestId) return;
      if (lane === "novel" && error.message === "novel_unpublished") {
        if (!params.has("lane")) {
          const fallback = new URLSearchParams(params);
          fallback.set("lane", "arcalive");
          await open(fallback);
          if (location.pathname === "/text" && lane === "arcalive") replaceRoute();
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

  function savedEntries() {
    return Object.entries(history.bookmarks).map(([key, saved]) => ({ ...saved, identity: key }))
      .filter((saved) => saved.entry && LANES.has(saved.lane) && HASH.test(saved.entry.sha256 || ""));
  }

  // Opens the work, folder, or body a URL names. Returns true when a body was opened.
  async function openFromParams(params, activeRequest) {
    const workId = params.get("work");
    if (workId && (lane === "novel" || arcaliveView === "works")) {
      const found = (lane === "arcalive" ? arcaliveWorks : catalog)
        .find((item) => item.work_id === workId || item.legacy_work_ids?.includes(workId));
      if (!found) return false;
      await openWork(found, false, activeRequest);
      // A newer navigation took over while the work detail loaded.
      if (activeRequest !== requestId) return false;
      readSort(params);
      renderCatalog();
      if (found.work_id !== workId) replaceRoute();
      const chapterId = params.get("chapter");
      const chapter = chapterId && chapterSource.find((entry) =>
        String(entry.chapter_id) === chapterId || entry.legacy_chapter_ids?.includes(chapterId));
      const item = params.get("item");
      const selected = chapter || (item && chapterSource.find((entry) => entry.identity === item));
      if (selected && activeRequest === requestId) {
        await openBody(selected, { navigation: "route", activeRequest });
        return true;
      }
      // Home's 이어서 읽기 on a finished chapter: continue with the one after it.
      if (params.get("resume") === "next" && activeRequest === requestId) {
        window.history.replaceState(window.history.state, "", listRoute());
        const target = resumeTarget();
        if (target) {
          await openBody(target, { navigation: "push", activeRequest });
          return true;
        }
      }
      return false;
    }
    if (params.has("item") && lane === "arcalive") {
      const found = catalog.find((item) => item.identity === params.get("item"));
      if (found) await openBody(found, { navigation: "route", activeRequest });
      return Boolean(found);
    }
    if (params.has("item") && lane === "saved") {
      const found = catalog.find((item) => item.identity === params.get("item"));
      if (found) {
        await openBody(found.entry, {
          navigation: "route", sourceLane: found.lane, sourceWork: found.work, savedIdentity: found.identity, activeRequest,
        });
      }
      return Boolean(found);
    }
    return false;
  }

  // History moved while the text library is showing (Back/Forward). Reuse the loaded catalog so
  // returning to a list does not refetch it and lands on the same rows.
  async function routeTo(params) {
    const nextLane = VIEWS.has(params.get("lane")) ? params.get("lane") : "novel";
    if (nextLane !== lane || nextLane === "saved" || !catalogs.has(lane) || !catalog.length) return open(params);
    const activeRequest = ++requestId;
    flushPosition();
    closeReader();
    search.value = params.get("q") || "";
    arcaliveView = params.get("view") === "works" ? "works" : "files";
    setLaneButtons();
    folderBoard = lane === "arcalive" && arcaliveView === "files" ? params.get("board") : null;
    folderCategory = lane === "arcalive" && arcaliveView === "files" ? params.get("category") : null;
    const workId = lane === "novel" || arcaliveView === "works" ? params.get("work") : null;
    if (!workId) {
      work = null;
      chapterSource = [];
    } else if (work?.work_id !== workId) {
      const found = (lane === "arcalive" ? arcaliveWorks : catalog)
        .find((item) => item.work_id === workId || item.legacy_work_ids?.includes(workId));
      if (!found) return open(params);
      try {
        chapterSource = (await workDetail(found)).chapters;
      } catch (error) {
        status.textContent = `작품 목차를 불러오지 못했습니다 · ${error.message}`;
        return undefined;
      }
      if (activeRequest !== requestId) return undefined;
      work = found;
    }
    readSort(params);
    syncBackButton();
    onChange();
    renderCatalog();
    const opened = await openFromParams(params, activeRequest).catch(() => false);
    if (!opened && activeRequest === requestId) restoreListPosition();
    return undefined;
  }

  async function openWork(item, shouldNavigate = true, activeRequest = ++requestId) {
    const detail = await workDetail(item);
    if (activeRequest !== requestId) return;
    work = item;
    if (shouldNavigate) sortMode = defaultSort();
    syncBackButton();
    chapterSource = detail.chapters;
    closeReader();
    onChange();
    renderCatalog();
    if (shouldNavigate) {
      pushRoute();
      list.scrollTop = 0;
    }
  }

  function sequenceFor(entry, sourceLane, chapters) {
    if (sourceLane === "novel" || (sourceLane === "arcalive" && chapters?.length)) {
      const entries = canonicalChapters(chapters);
      return { unit: "화", entries, index: entries.findIndex((chapter) => sameChapter(chapter, entry)), toc: true };
    }
    if (lane === "arcalive" && folderCategory) {
      return { unit: "글", entries: visible.slice(), index: visible.findIndex((item) => sameChapter(item, entry)), toc: false };
    }
    return null;
  }

  function navigation() {
    const unit = sequence?.unit ?? (current?.lane === "novel" ? "화" : "글");
    const step = (direction) => {
      if (!sequence) return null;
      const result = adjacentInSequence(sequence.entries, sequence.index, direction);
      return result.target ? {
        title: result.target.label || result.target.title || "",
        entry: result.target,
        prefetch: HASH.test(result.target.sha256 || "") ? `/api/v1/text/object/${result.target.sha256}` : "",
      } : null;
    };
    const previous = step(-1);
    const next = step(1);
    const gap = next && current ? labelGap(current.entry.label, next.entry.label) : 0;
    const position = sequence && sequence.index >= 0 ? ` · ${sequence.index + 1}/${sequence.entries.length}` : "";
    const context = current?.work
      ? `${current.work.title}${position}`
      : [current?.entry.board, current?.entry.category].filter(Boolean).join(" · ") || "아카라이브";
    return {
      unit,
      qualifier: unit === "글" && sequence ? "현재 목록" : "",
      previous,
      next,
      note: gap ? `다음 회차 사이에 ${gap}개 회차가 목록에 없습니다. 아직 수집되지 않았거나 접근 대기일 수 있습니다.`
        : current && !sequence ? "저장한 글이라 이어지는 글 순서가 없습니다." : "",
      endFallback: next || !sequence?.toc ? null
        : { kicker: "현재 보존된 마지막 회차", label: "회차 목록으로", action: "toc" },
      hasToc: Boolean(sequence?.toc),
      context,
    };
  }

  // navigation: "push" opens from a list, "replace" moves within the session, "route" follows
  // history (no history write).
  async function openBody(entry, {
    navigation: mode = "push", sourceLane = lane, sourceWork = work, savedIdentity = "", activeRequest = ++requestId,
  } = {}) {
    flushPosition();
    const viewLane = lane;
    const currentLane = viewLane === "saved" ? sourceLane : viewLane;
    const itemWork = viewLane === "saved" ? sourceWork : work;
    const hash = entry.sha256;
    if (!HASH.test(hash || "")) throw new Error("object_hash_invalid");
    const [response, chapters] = await Promise.all([
      fetch(`/api/v1/text/object/${hash}`, { credentials: "same-origin", redirect: "error" }),
      viewLane === "saved" && itemWork ? savedWorkChapters(itemWork).catch(() => []) : chapterSource,
    ]);
    if (activeRequest !== requestId) return;
    if (!response.ok) throw new Error(`request_${response.status}`);
    const text = await response.text();
    if (activeRequest !== requestId) return;
    const isNovel = currentLane === "novel";
    const entryIdentity = savedIdentity || identity(entry, currentLane, itemWork);
    const parsed = isNovel ? novelBody(text) : arcaliveBody(text);
    current = { lane: currentLane, viewLane, entry, identity: entryIdentity, work: itemWork };
    sequence = sequenceFor(entry, currentLane, chapters);
    if (sequence && sequence.index < 0) sequence = null;
    const record = history.history[entryIdentity] || {};
    history.history[entryIdentity] = {
      ...record,
      readAt: new Date().toISOString(),
      title: isNovel ? (entry.label || "") : (entry.title || ""),
      work: itemWork?.title || "",
      ...(isNovel && itemWork?.work_id ? { workId: itemWork.work_id } : {}),
      total: itemWork?.chapter_count ?? 0,
      route: route(),
      listRoute: itemWork
        ? `/text?${new URLSearchParams({ lane: currentLane, ...(isNovel ? {} : { view: "works" }), work: itemWork.work_id })}` : listRoute(),
    };
    pruneHistory();
    persist();
    shell.open({
      kicker: isNovel ? (itemWork?.title || "소설") : ["아카라이브", entry.board].filter(Boolean).join(" · "),
      title: isNovel ? (entry.label || itemWork?.title || "회차") : (entry.title || "아카라이브 글"),
      meta: isNovel
        ? [itemWork?.author || "작가 미상", chapterKind(entry.kind)].filter(Boolean).join(" · ")
        : [entry.author, entry.category || "미분류", entry.post_id ? `#${entry.post_id}` : ""].filter(Boolean).join(" · "),
      text: parsed.text,
      sourceUrl: parsed.sourceUrl || (isNovel ? entry.source_url : "") || "",
    });
    shell.setNavigation(navigation());
    listPage = null;
    publishList();
    updateBookmark();
    onChange();
    restorePosition(record, hash);
    if (mode === "push") pushRoute({ redstmReader: true });
    else if (mode === "replace") replaceRoute({ redstmReader: true });
  }

  function restorePosition(record, hash) {
    readerPane.scrollTop = record.scroll || 0;
    shell.syncScroll();
    const anchor = record.anchor ? { offset: record.offset, quote: record.anchor, viewportOffset: record.anchorTop ?? 0 } : null;
    // Offset-based anchors are exact; legacy quote-only anchors are used only for a new revision.
    if (anchor && (Number.isInteger(record.offset) || (record.revision && record.revision !== hash))) {
      requestAnimationFrame(() => shell.restoreAnchor(anchor));
    }
  }

  function listHeading() {
    const sorted = sortMode !== defaultSort() ? ` · ${SORT_LABELS[sortMode]}` : "";
    const query = search.value.trim() ? ` · “${search.value.trim()}”` : "";
    if (current?.viewLane === "saved") return { kicker: "텍스트 저장함", title: `저장한 자료${query}` };
    if (current?.work) return { kicker: "회차 목록", title: `${current.work.title}${sorted}${query}` };
    return { kicker: "아카라이브", title: `${[folderBoard, folderCategory].filter(Boolean).join(" · ") || "글 목록"}${sorted}${query}` };
  }

  function isCurrentRow(item) {
    if (!current) return false;
    if (current.viewLane === "saved") return item.identity === current.identity;
    return sameChapter(item, current.entry);
  }

  // The same rows, order, and filter as the list the body was opened from.
  function publishList() {
    if (!current) return shell.setList(null);
    const rows = visible;
    const found = rows.findIndex(isCurrentRow);
    const lastPage = Math.max(0, Math.ceil(rows.length / LIST_PAGE) - 1);
    const page = Number.isInteger(listPage) ? Math.min(Math.max(0, listPage), lastPage)
      : found >= 0 ? Math.floor(found / LIST_PAGE) : 0;
    const offset = page * LIST_PAGE;
    const chapters = current.viewLane !== "saved" && Boolean(current.work);
    return shell.setList({
      ...listHeading(),
      total: rows.length,
      offset,
      hint: found < 0 ? "지금 읽는 글은 이 목록에 없습니다." : "",
      rows: rows.slice(offset, offset + LIST_PAGE).map((item) => {
        const key = current.viewLane === "saved" ? item.identity : identity(item, current.lane, current.work);
        const progress = history.history[key]?.progress ?? 0;
        return {
          key,
          item,
          current: isCurrentRow(item),
          read: progress >= FINISHED,
          title: current.viewLane === "saved" ? (item.title || item.entry?.label || "저장한 자료")
            : chapters ? (item.label || "회차") : (item.title || item.category || "글"),
          meta: [
            chapters ? chapterKind(item.kind) : current.viewLane === "saved" ? (item.entry?.label || "") : (item.category || ""),
            isCurrentRow(item) ? "" : progress >= FINISHED ? "다 읽음" : progress > 0 ? `${Math.round(progress * 100)}%` : history.history[key] ? "열어 봄" : "",
          ].filter(Boolean).join(" · "),
        };
      }),
      onOpen: (row) => {
        listPage = null;
        const action = current?.viewLane === "saved"
          ? openBody(row.item.entry, { navigation: "replace", sourceLane: row.item.lane, sourceWork: row.item.work, savedIdentity: row.item.identity })
          : openBody(row.item, { navigation: "replace" });
        void action.catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; });
      },
      onPage: (delta) => {
        listPage = page + delta;
        publishList();
      },
    });
  }

  function updateBookmark() {
    shell.setBookmarked(Boolean(current && history.bookmarks[current.identity]), { notes: Boolean(current) });
  }

  function closeReader() {
    if (!current) return;
    flushPosition();
    current = null;
    sequence = null;
    shell.close();
    onChange();
  }

  // 목록 / system Back from a body.
  function back() {
    ++requestId;
    if (!current) return;
    if (window.history.state?.redstmParent) {
      window.history.back();
      return;
    }
    closeReader();
    renderCatalog();
    replaceRoute({ redstmReader: false });
    restoreListPosition();
  }

  function parentLevelParams() {
    const params = listParams();
    if (work) params.delete("work");
    else if (folderCategory) params.delete("category");
    else if (folderBoard) params.delete("board");
    return params;
  }

  // "← 작품 목록" style button: one level up the list hierarchy.
  function up() {
    ++requestId;
    const parent = `/text?${parentLevelParams()}`;
    if (window.history.state?.redstmParent === parent) {
      window.history.back();
      return;
    }
    if (work) {
      work = null;
      chapterSource = [];
    } else if (folderCategory) folderCategory = null;
    else if (folderBoard) folderBoard = null;
    sortMode = defaultSort();
    syncBackButton();
    onChange();
    renderCatalog();
    window.history.replaceState({ redstmText: true }, "", listRoute());
    restoreListPosition();
  }

  function toToc() {
    if (!current?.work) return;
    const tocParams = new URLSearchParams({ lane: current.lane, ...(current.lane === "arcalive" ? { view: "works" } : {}), work: current.work.work_id });
    const tocRoute = `/text?${tocParams}`;
    if (window.history.state?.redstmParent === tocRoute) {
      window.history.back();
      return;
    }
    const parent = window.history.state?.redstmParent ?? null;
    const opening = open(tocParams);
    // open() takes its request id synchronously; a later navigation must keep its own URL.
    const tocRequest = requestId;
    void opening.then(() => {
      if (requestId !== tocRequest) return;
      window.history.replaceState({ redstmText: true, redstmParent: parent }, "", tocRoute);
    });
  }

  // The chapter to resume a work at: the last one read, or the next one when it was finished.
  function resumeTarget() {
    const resume = lastReadChapter();
    if (!resume) return null;
    if ((resume.record.progress ?? 0) < FINISHED) return resume.chapter;
    const entries = canonicalChapters(chapterSource);
    const index = entries.findIndex((chapter) => sameChapter(chapter, resume.chapter));
    return adjacentInSequence(entries, index, 1).target ?? resume.chapter;
  }

  function activate(button) {
    if (button.dataset.continue) {
      const target = resumeTarget() ?? canonicalChapters(chapterSource)[0];
      if (!target) return;
      rememberListPosition();
      void openBody(target, { navigation: current ? "replace" : "push" }).catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; });
      return;
    }
    const index = Number(button.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= visible.length) return;
    const selected = visible[index];
    rememberListPosition();
    if (lane === "arcalive" && arcaliveView === "files" && !folderBoard) {
      folderBoard = selected.folder_label;
      syncBackButton();
      onChange();
      renderCatalog();
      pushRoute();
      list.scrollTop = 0;
      return;
    }
    if (lane === "arcalive" && arcaliveView === "files" && !folderCategory) {
      folderCategory = selected.folder_label;
      syncBackButton();
      renderCatalog();
      pushRoute();
      list.scrollTop = 0;
      return;
    }
    // Picking another row from the side list while a body is open stays in the same session.
    const navigation = current ? "replace" : "push";
    const action = lane === "saved"
      ? openBody(selected.entry, { navigation, sourceLane: selected.lane, sourceWork: selected.work, savedIdentity: selected.identity })
      : work || (lane === "arcalive" && arcaliveView === "files") ? openBody(selected, { navigation }) : openWork(selected);
    void action.catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; });
  }

  function searchChanged(query) {
    if (query !== search.value) search.value = query;
    if (!catalog.length) return;
    renderCatalog();
    window.history.replaceState(window.history.state, "", current ? route() : listRoute());
  }

  function changeLane(nextLane) {
    if (!VIEWS.has(nextLane) || nextLane === lane) return;
    flushPosition();
    void open(new URLSearchParams({ lane: nextLane, q: search.value }));
    window.history.replaceState({ redstmText: true }, "", `/text?${new URLSearchParams({ lane: nextLane, ...(search.value ? { q: search.value } : {}) })}`);
  }

  function savePosition() {
    if (!current) return;
    const old = history.history[current.identity] || {};
    const measured = shell.progress();
    const anchor = shell.captureAnchor();
    history.history[current.identity] = {
      ...old,
      readAt: old.readAt || new Date().toISOString(),
      scroll: readerPane.scrollTop,
      progress: (old.progress ?? 0) >= FINISHED ? Math.max(old.progress, measured) : measured,
      chapterId: current.entry.chapter_id || current.entry.source_chapter_id || "",
      revision: current.entry.sha256 || "",
      ...(anchor ? { anchor: anchor.quote, offset: anchor.offset, anchorTop: Math.round(anchor.viewportOffset) } : {}),
    };
    persist();
  }

  function flushPosition() {
    clearTimeout(saveTimer);
    if (current) savePosition();
  }

  function move(delta, { finished = false } = {}) {
    if (!current || !sequence || moving) return;
    const target = adjacentInSequence(sequence.entries, sequence.index, delta).target;
    if (!target) return;
    if (finished) {
      flushPosition();
      const record = history.history[current.identity];
      if (record) record.progress = 1;
      persist();
    }
    moving = true;
    const sourceLane = current.lane;
    const sourceWork = current.work;
    const savedIdentity = current.viewLane === "saved" && sourceLane === "novel" ? `novel:${sourceWork?.work_id}:${target.chapter_id}` : "";
    const frozen = sequence;
    void openBody(target, { navigation: "replace", sourceLane, sourceWork, savedIdentity })
      .then(() => {
        // Keep the order the reader started with, even if the list behind it was re-sorted —
        // unless another body (a side-list tap) replaced this move before it arrived.
        if (current && frozen && sameChapter(current.entry, target)) {
          sequence = { ...frozen, index: frozen.entries.findIndex((entry) => sameChapter(entry, target)) };
          shell.setNavigation(navigation());
          publishList();
        }
      })
      .catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; })
      .finally(() => { moving = false; });
  }

  function bookmarkDetails() {
    if (!current) return null;
    const saved = history.bookmarks[current.identity];
    return {
      title: current.lane === "novel" ? `${current.work?.title || "소설"} · ${current.entry.label || "회차"}` : (current.entry.title || "글"),
      saved: Boolean(saved),
      note: saved?.note ?? "",
      tags: saved?.tags ?? [],
    };
  }

  function saveBookmarkDetails({ note, tags }) {
    if (!current) return;
    if (!history.bookmarks[current.identity]) toggleBookmark();
    const saved = history.bookmarks[current.identity];
    if (note) saved.note = note; else delete saved.note;
    if (tags.length) saved.tags = tags; else delete saved.tags;
    persist();
    updateBookmark();
  }

  function removeBookmark() {
    if (current && history.bookmarks[current.identity]) toggleBookmark();
  }

  function toggleBookmark() {
    if (!current) return;
    if (history.bookmarks[current.identity]) delete history.bookmarks[current.identity];
    else history.bookmarks[current.identity] = {
      savedAt: new Date().toISOString(),
      lane: current.lane,
      entry: current.entry,
      work: current.work,
      title: current.lane === "novel" ? current.work?.title : current.entry.title || current.entry.category,
    };
    persist();
    updateBookmark();
    renderCatalog();
  }

  function command(name) {
    if (name === "previous") return move(-1);
    if (name === "next") return move(1);
    if (name === "end-next") {
      const action = document.querySelector("#end-next").dataset.action;
      if (action === "next") return move(1, { finished: true });
      if (action === "toc") return toToc();
      return undefined;
    }
    if (name === "list") return back();
    if (name === "toc") return toToc();
    if (name === "bookmark") return toggleBookmark();
    return undefined;
  }

  document.querySelector("#text-lanes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-text-lane]");
    if (button) changeLane(button.dataset.textLane);
  });
  document.querySelector("#arcalive-views").addEventListener("click", (event) => {
    const button = event.target.closest("[data-arcalive-view]");
    if (!button || button.dataset.arcaliveView === arcaliveView) return;
    const next = new URLSearchParams({ lane: "arcalive", ...(button.dataset.arcaliveView === "works" ? { view: "works" } : {}) });
    void open(next);
    window.history.pushState({ redstmText: true }, "", `/text?${next}`);
  });
  document.querySelector("#text-work-back").addEventListener("click", () => {
    if (!current && (work || folderBoard)) up();
  });
  readerPane.addEventListener("scroll", () => {
    if (!current) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
  }, { passive: true });

  function sortContext() {
    if (work) return "chapters";
    if (lane === "novel" || lane === "arcalive" && arcaliveView === "works") return "works";
    return "titles";
  }

  function setSort(value) {
    const allowed = new Set(["oldest", "latest", "title", "longest", "updated"]);
    const next = allowed.has(value) ? value : (sortContext() === "chapters" ? "oldest" : "title");
    if (next === sortMode) return;
    sortMode = next;
    renderCatalog();
    if (!current) window.history.replaceState(window.history.state, "", listRoute());
  }

  function currentSort() { return sortMode; }

  // The list a deep-linked body belongs to, used to build a Back target under it.
  function parentRoute(params) {
    if (!params.has("chapter") && !params.has("item")) return null;
    const parent = new URLSearchParams(params);
    parent.delete("chapter");
    parent.delete("item");
    return `/text?${parent}`;
  }

  // Most recent text reading that Home can resume (records written before routes were stored are skipped).
  function latestReading() {
    let latest = null;
    for (const [key, record] of Object.entries(history.history)) {
      if (!record?.route || !record.readAt) continue;
      if (!latest || record.readAt > latest.readAt) latest = { identity: key, ...record };
    }
    return latest;
  }

  function searchPlaceholder() {
    if (work) return "회차 찾기 (예: 120화, 외전)";
    if (lane === "novel" || lane === "arcalive" && arcaliveView === "works") return "작품 제목·작가 검색";
    if (lane === "saved") return "저장한 자료·메모·태그 검색";
    if (folderCategory) return "글 제목 검색";
    return "게시판·분류 검색";
  }

  function sortOptions() {
    const context = sortContext();
    return context === "chapters"
      ? [["오래된순", "oldest"], ["최신순", "latest"], ["이름순", "title"]]
      : context === "works"
        ? [["가나다순", "title"], ["편수 많은순", "longest"], ["최신 화순", "updated"]]
        : [];
  }

  // Works being read (some chapter read, not all finished), newest first, for Home.
  function readingWorks() {
    const works = catalogs.get("novel")?.items ?? [];
    const byId = new Map(works.map((item) => [item.work_id, item]));
    return [...workProgress()].map(([workId, progress]) => {
      const item = byId.get(workId);
      const total = item?.chapter_count ?? progress.record?.total ?? 0;
      if (!progress.record?.listRoute || (total && progress.finished >= total)) return null;
      return {
        title: item?.title || progress.record.work || "소설",
        meta: [total ? `읽음 ${progress.finished}/${total}` : "", progress.record.title ? `최근 ${progress.record.title}` : ""].filter(Boolean).join(" · "),
        listRoute: progress.record.listRoute,
        readAt: progress.lastReadAt,
      };
    }).filter(Boolean).sort((left, right) => right.readAt.localeCompare(left.readAt));
  }

  function isReading() { return Boolean(current); }
  function inWork() { return Boolean(work); }
  function currentRoute() { return route(); }
  function leave() {
    active = false;
    ++requestId;
    flushPosition();
    current = null;
    sequence = null;
    work = null;
    chapterSource = [];
    folderBoard = null;
    folderCategory = null;
    syncBackButton();
    shell.close();
  }

  return {
    open, route: routeTo, searchChanged, activate, isReading, inWork, sortContext, setSort, currentRoute,
    leave, changeLane, command, parentRoute, flush: flushPosition, latestReading, currentSort,
    searchPlaceholder, sortOptions, readingWorks, bookmarkDetails, saveBookmarkDetails, removeBookmark,
  };
}
