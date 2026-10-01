import { captureListAnchor, loadListPosition, restoreListAnchor, saveListPosition } from "/list-anchor.js";
import { adjacentInSequence, labelGap } from "/sequence.js";
import { fillWorkCover, showWorkBarcode } from "/work-header.js";
import { workKey } from "/type-cover.js";
import {
  arcaliveBody, compactTextHistory, migrateNovelChapterState, migrateNovelState, novelBody, novelRecordWorkId,
  orderChapters, trimTextState,
} from "/text-work.js";
import {
  UNSORTED, addShelf, ensureShelves, hiddenShelfIds, migrateShelfAliases, moveShelf, removeShelf, renameShelf,
  setShelfHidden, setWorkShelf, shelfCounts, shelfName, shelfOf,
} from "/text-shelves.js";

const STATE_KEY = "redstm.textState.v1";
const LANES = new Set(["novel", "arcalive"]);
const VIEWS = new Set([...LANES, "saved"]);
const HASH = /^[a-f0-9]{64}$/;
const FINISHED = 0.95;
const HISTORY_LIMIT = 10_000;
// About 3 MB of UTF-16: the TypeMoon state (≤ ~1 MB) shares the origin's ~5 MB localStorage.
const TEXT_STATE_CHARS = 1_500_000;
const ROW_SELECTOR = ".result-item[data-key]";
const LIST_PAGE = 10;
// Long lists (thousands of chapters or posts) render this many rows at a time: the first batch at
// once, the next when the end of the rendered rows scrolls near.
const RENDER_CHUNK = 400;
const SORT_LABELS = {
  oldest: "오래된순", latest: "최신순", title: "이름순", longest: "편수 많은순", updated: "최근 갱신순", recent: "최근 읽은순",
};
// Novel work list filter by this browser's reading records.
const READ_FILTERS = [["all", "전체"], ["reading", "읽는 중"], ["new", "새 회차"], ["unread", "안 읽음"], ["finished", "다 읽음"]];
const READ_FILTER_VALUES = new Set(READ_FILTERS.map(([value]) => value));
const SOURCE_LABELS = {
  toki: "북토끼", newtoki: "뉴토끼", blacktoon: "블랙툰", marumaru: "마루마루", ondobook: "온도북", bookkor: "북코",
  sbxh: "SBXH",
};
const dateLabel = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
const yearDateLabel = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "numeric", day: "numeric" });

function sourceLabel(site) {
  return SOURCE_LABELS[site] ?? (site ? String(site) : "");
}

// "9. 1." this year, "25. 9. 1." before it.
function shortDate(value) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return (date.getFullYear() === new Date().getFullYear() ? dateLabel : yearDateLabel).format(date);
}

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
  const shelvesAdded = ensureShelves(history) | compactTextHistory(history.history);
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
  let readFilter = "all";
  // Novel list: every work ("all") or personal shelves as folders ("shelves", text-shelves.js).
  let novelView = "all";
  let shelfFilter = "";
  let sourceFilter = "";
  let listKind = "works";
  let hiddenWorks = 0;
  let renderedQuery = null;
  // Incremental rendering of the shared result list (renderMore).
  let rowWindow = null;
  let rendered = 0;
  let rowObserver = null;
  const rowSentinel = document.createElement("li");
  rowSentinel.className = "list-sentinel";
  rowSentinel.setAttribute("aria-hidden", "true");
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
    compactTextHistory(history.history);
    const keys = Object.keys(history.history);
    if (keys.length <= HISTORY_LIMIT) return;
    keys.sort((left, right) => String(history.history[right].readAt || "").localeCompare(String(history.history[left].readAt || "")));
    for (const key of keys.slice(HISTORY_LIMIT)) delete history.history[key];
  }

  // Failures show in the shared archive state label, the same way TypeMoon reading state does.
  function persist() {
    const archiveState = document.querySelector("#archive-state");
    try {
      trimTextState(history, TEXT_STATE_CHARS);
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
    ensureShelves(incoming);
    history.shelves = incoming.shelves;
    history.workShelves = incoming.workShelves;
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
    if (lane === "novel" && novelView === "shelves") params.set("view", "shelves");
    if (lane === "novel" && shelfFilter) params.set("shelf", shelfFilter);
    if (sortMode !== defaultSort()) params.set("sort", sortMode);
    if (worksView() && readFilter !== "all") params.set("read", readFilter);
    if (worksView() && lane === "novel" && sourceFilter) params.set("source", sourceFilter);
    return params;
  }

  function defaultSort() {
    if (work) return "oldest";
    // Posts in an Arcalive category read like a board: newest first. Works, like TypeMoon's
    // collections, start with the ones updated most recently.
    if (postsView()) return "latest";
    return worksView() ? "updated" : "title";
  }

  // Search text typed above an Arcalive category: the matching posts are listed directly.
  function flatSearch() {
    return lane === "arcalive" && arcaliveView === "files" && !folderCategory && !work && Boolean(search.value.trim());
  }

  function postsView() {
    return lane === "arcalive" && arcaliveView === "files" && Boolean(folderCategory);
  }

  function readSort(params) {
    const requested = params.get("sort");
    sortMode = SORT_LABELS[requested] ? requested : defaultSort();
    readFilter = READ_FILTER_VALUES.has(params.get("read")) ? params.get("read") : "all";
    sourceFilter = /^[a-z0-9_-]{1,32}$/.test(params.get("source") || "") ? params.get("source") : "";
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

  function addProgress(progress, workId, record) {
    const item = progress.get(workId) ?? { finished: 0, reading: 0, lastReadAt: "", record: null, seenTotal: 0 };
    const value = record.progress ?? 0;
    // chapter_count when a chapter of the work was last opened: later chapters are new.
    if (Number.isInteger(record.total) && record.total > item.seenTotal) item.seenTotal = record.total;
    if (value >= FINISHED) item.finished += 1;
    else if (value > 0) item.reading += 1;
    if (String(record.readAt || "") > item.lastReadAt) {
      item.lastReadAt = String(record.readAt || "");
      item.record = record;
    }
    progress.set(workId, item);
  }

  // { finished, reading, lastReadAt, record, seenTotal } per novel work, from local reading records.
  function workProgress() {
    const knownWorkIds = new Set((catalogs.get("novel")?.items ?? []).map((item) => item.work_id));
    const progress = new Map();
    for (const [key, record] of Object.entries(history.history)) {
      const workId = record ? novelRecordWorkId(key, record, knownWorkIds) : null;
      if (workId) addProgress(progress, workId, record);
    }
    return progress;
  }

  // The same per Arcalive work. Works list their posts (post_ids), so posts read from the board
  // folders count too; releases before post_ids fall back to records opened inside the work.
  function arcaliveWorkProgress() {
    const progress = new Map();
    const withPosts = arcaliveWorks.filter((item) => Array.isArray(item.post_ids));
    for (const item of withPosts) {
      for (const postId of item.post_ids) {
        const record = history.history[`arcalive:${item.board}:${postId}:text`];
        if (record) addProgress(progress, item.work_id, record);
      }
    }
    if (!withPosts.length) {
      for (const record of Object.values(history.history)) {
        if (typeof record?.workId === "string" && record.workId.startsWith("arcalive:")) addProgress(progress, record.workId, record);
      }
    }
    return progress;
  }

  // Work lists (novel works, Arcalive 작품별) share read-state chips, sorts, and row copy.
  function worksView() {
    if (work) return false;
    if (lane === "novel") return !shelfFolders();
    return lane === "arcalive" && arcaliveView === "works";
  }

  // 분류별 above any shelf: the shelves themselves are listed.
  function shelfFolders() {
    return lane === "novel" && novelView === "shelves" && !shelfFilter && !work;
  }

  function readNovelView(params) {
    novelView = lane === "novel" && params.get("view") === "shelves" ? "shelves" : "all";
    const requested = params.get("shelf") || "";
    shelfFilter = lane === "novel" && novelView === "shelves"
      && (requested === UNSORTED || history.shelves.some((shelf) => shelf.id === requested)) ? requested : "";
  }

  // Which works a novel list shows: one shelf, or everything outside hidden shelves.
  function shelfVisible(item, hidden) {
    if (lane !== "novel") return true;
    const shelf = shelfOf(history, item.work_id);
    return shelfFilter ? shelf === shelfFilter : !hidden.has(shelf);
  }

  function currentWorks() {
    return lane === "novel" ? catalog : arcaliveWorks;
  }

  function progressForLane() {
    return lane === "novel" ? workProgress() : arcaliveWorkProgress();
  }

  // Reading state of one work: new chapters since it was last read, and where it stands.
  function workState(entry, progress) {
    const total = entry.chapter_count ?? 0;
    const newCount = progress?.seenTotal ? Math.max(0, total - progress.seenTotal) : 0;
    const state = !progress ? "unread" : total && progress.finished >= total ? "finished" : "reading";
    return { newCount, state };
  }

  function matchesReadFilter(state) {
    if (readFilter === "all") return true;
    if (readFilter === "new") return state.newCount > 0;
    return state.state === readFilter;
  }

  function sourcesOf(works) {
    return [...new Set(works.map((item) => item.source_site).filter(Boolean))].sort();
  }

  function renderReadChips(progress) {
    const chips = document.querySelector("#text-read-chips");
    if (!chips) return;
    chips.hidden = !active || !progress;
    if (chips.hidden) return;
    const works = currentWorks();
    const counts = { all: works.length, reading: 0, new: 0, unread: 0, finished: 0 };
    for (const item of works) {
      const state = workState(item, progress.get(item.work_id));
      counts[state.state] += 1;
      if (state.newCount) counts.new += 1;
    }
    const nodes = READ_FILTERS.map(([value, label]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.textRead = value;
      chip.textContent = value === "all" ? label : `${label} ${counts[value].toLocaleString("ko-KR")}`;
      chip.setAttribute("aria-pressed", String(value === readFilter));
      chip.disabled = value !== "all" && value !== readFilter && counts[value] === 0;
      return chip;
    });
    // 출처: the novel counterpart of TypeMoon's board filter, when more than one site is present.
    const sources = lane === "novel" ? sourcesOf(works) : [];
    if (sources.length > 1) {
      const label = document.createElement("label");
      label.className = "text-source-field";
      const caption = document.createElement("span");
      caption.className = "sr-only";
      caption.textContent = "출처";
      const select = document.createElement("select");
      select.id = "text-source-filter";
      select.append(new Option("모든 출처", ""), ...sources.map((site) => new Option(sourceLabel(site), site)));
      select.value = sources.includes(sourceFilter) ? sourceFilter : "";
      label.append(caption, select);
      nodes.push(label);
    }
    chips.replaceChildren(...nodes);
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

  // Title text with the searched words marked, like TypeMoon search results.
  function highlighted(text, query) {
    const node = document.createElement("span");
    node.className = "result-title";
    const words = query.trim().split(/\s+/).filter(Boolean).map((word) => word.toLocaleLowerCase("ko-KR"));
    const lower = text.toLocaleLowerCase("ko-KR");
    const ranges = [];
    for (const word of words) {
      for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
    }
    ranges.sort((left, right) => left[0] - right[0]);
    let cursor = 0;
    for (const [from, to] of ranges) {
      if (from < cursor) continue;
      node.append(text.slice(cursor, from));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(from, to);
      node.append(mark);
      cursor = to;
    }
    node.append(text.slice(cursor));
    return node;
  }

  function metaElement(parts) {
    const meta = document.createElement("span");
    meta.className = "result-meta";
    for (const part of parts) {
      if (!part) continue;
      const [text, className] = Array.isArray(part) ? part : [part, ""];
      if (!text) continue;
      const span = document.createElement("span");
      if (className) span.className = className;
      span.textContent = text;
      meta.append(span);
    }
    return meta;
  }

  function badgeElement(labels) {
    const shown = labels.filter(Boolean);
    if (!shown.length) return null;
    const badges = document.createElement("span");
    badges.className = "result-badges";
    for (const label of shown) {
      const badge = document.createElement("span");
      badge.textContent = label;
      badges.append(badge);
    }
    return badges;
  }

  // Row copy for a work, in the shape TypeMoon uses for its collections.
  function workRowParts(entry, progress) {
    const total = entry.chapter_count ?? 0;
    const { state } = workState(entry, progress);
    const unit = lane === "novel" ? "화" : "편";
    const count = state === "unread" ? `${total.toLocaleString("ko-KR")}${unit}`
      : `${(progress?.finished ?? 0).toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}${unit}`;
    const action = state === "unread" ? "시작하기" : state === "finished" ? "다시 보기" : "이어 읽기";
    const latest = entry.latest_label && entry.latest_label !== `${total}화` ? `최신 ${entry.latest_label}` : "";
    const updated = shortDate(entry.last_imported_at);
    return [
      [lane === "novel" ? sourceLabel(entry.source_site) : entry.board, "result-board"],
      entry.author || "작가 미상",
      count,
      [action, "result-action"],
      latest,
      updated ? `${updated} 갱신` : "",
      progress?.record?.title && state === "reading" ? `최근 ${progress.record.title}` : "",
    ];
  }

  const workBarcodeHost = document.createElement("div");
  workBarcodeHost.className = "work-barcode";

  function workSummary(rows) {
    const item = document.createElement("div");
    item.className = "text-work-summary";
    const head = document.createElement("div");
    head.className = "work-head";
    const cover = document.createElement("span");
    cover.className = "work-cover";
    cover.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "work-head-copy";
    const heading = document.createElement("h2");
    heading.textContent = work.title || "작품";
    const total = chapterSource.length;
    let finished = 0;
    for (const chapter of chapterSource) {
      if ((history.history[identity(chapter, lane, work)]?.progress ?? 0) >= FINISHED) finished += 1;
    }
    const meta = metaElement([
      [lane === "novel" ? sourceLabel(work.source_site) : [work.board, work.category].filter(Boolean).join(" · "), "result-board"],
      work.author || "작가 미상",
      `${total.toLocaleString("ko-KR")}${lane === "novel" ? "화" : "편"}`,
      work.latest_label && work.latest_label !== `${total}화` ? `최신 ${work.latest_label}` : "",
      shortDate(work.last_imported_at) ? `${shortDate(work.last_imported_at)} 갱신` : "",
      [`읽음 ${finished.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}`, finished ? "result-action" : ""],
    ]);
    copy.append(heading, meta);
    head.append(cover, copy);
    item.append(head);
    fillWorkCover(cover, {
      title: work.title || "작품", source: lane === "novel" ? sourceLabel(work.source_site) : "아카라이브",
      hueKey: lane === "novel" ? workKey({ source: "novel", id: work.work_id }) : workKey({ source: "arcalive", board: work.board ?? "", id: work.work_id }),
      progress: total ? finished / total : null, size: "s",
    });
    // Shelf and 몇 화? share one row under the title.
    const actions = document.createElement("div");
    actions.className = "text-work-actions";
    if (lane === "novel") {
      const shelf = document.createElement("button");
      shelf.type = "button";
      shelf.className = "shelf-summary";
      shelf.dataset.workId = work.work_id;
      shelf.textContent = `분류: ${shelfName(history, shelfOf(history, work.work_id))}`;
      actions.append(shelf);
    }
    if (total > LIST_PAGE) {
      const form = document.createElement("form");
      form.className = "toc-jump text-toc-jump";
      form.setAttribute("role", "search");
      form.ariaLabel = "회차로 이동";
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "numeric";
      input.min = "1";
      input.placeholder = "몇 화?";
      input.enterKeyHint = "go";
      input.ariaLabel = "이동할 회차 번호";
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "찾기";
      form.append(input, button);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        jumpToChapter(Number(input.value), rows);
        input.blur();
      });
      actions.append(form);
    }
    if (actions.childElementCount) item.append(actions);
    // The barcode host outlives redraws of the summary so its observer is made once.
    const ordered = canonicalChapters(chapterSource);
    const current = lastReadChapter();
    showWorkBarcode(workBarcodeHost, ordered.map((chapter, index) => ({
      position: index + 1, label: chapter.label || `${index + 1}화`, chapter,
      current: chapter === current,
      finished: (history.history[identity(chapter, lane, work)]?.progress ?? 0) >= FINISHED,
    })), ({ chapter }) => {
      const key = rowKey(chapter, { chaptersMode: true });
      renderThroughKey(key);
      list.querySelector(`${ROW_SELECTOR}[data-key="${CSS.escape(key)}"]`)?.click();
    });
    item.append(workBarcodeHost);
    return item;
  }

  // Appends the next rows of `visible` (see RENDER_CHUNK). The sentinel after the last rendered
  // row asks for more as it nears the viewport; observing it again reports whether it still is.
  function renderMore(count = RENDER_CHUNK) {
    // The result list is shared with TypeMoon screens: never append once they own it.
    if (!rowWindow || !active) return;
    rowObserver?.unobserve(rowSentinel);
    const end = Math.min(visible.length, rendered + count);
    const fragment = document.createDocumentFragment();
    for (let index = rendered; index < end; index += 1) fragment.append(rowWindow.build(visible[index], index));
    rendered = end;
    if (rowSentinel.parentNode === list) rowSentinel.before(fragment);
    else list.append(fragment);
    if (rendered >= visible.length) {
      rowSentinel.remove();
      return;
    }
    list.append(rowSentinel);
    rowObserver ??= "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) renderMore();
      }, { rootMargin: "1200px 0px" })
      : null;
    if (rowObserver) rowObserver.observe(rowSentinel);
    else renderMore(visible.length);
  }

  // Makes sure the row with this data-key is in the DOM (anchors, jumps, the current row).
  function renderThroughKey(key) {
    if (!rowWindow || key == null) return;
    const index = visible.findIndex((entry) => rowWindow.key(entry) === String(key));
    if (index >= rendered) renderMore(index - rendered + 1 + LIST_PAGE);
  }

  // "몇 화?": the chapter whose label carries that number, else the Nth in reading order.
  function jumpToChapter(number, rows) {
    if (!Number.isInteger(number) || number < 1) return;
    const byLabel = rows.find((chapter) => Number(/(\d+)\s*(?:화|편|장)?/.exec(String(chapter.label || ""))?.[1]) === number);
    const target = byLabel ?? canonicalChapters(chapterSource)[number - 1];
    if (!target) {
      status.textContent = `${number}화를 찾지 못했습니다`;
      return;
    }
    const key = rowKey(target, { chaptersMode: true });
    renderThroughKey(key);
    const button = list.querySelector(`${ROW_SELECTOR}[data-key="${CSS.escape(key)}"]`);
    if (!button) return;
    list.scrollTop += button.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 3;
    button.focus({ preventScroll: true });
  }

  // listKind: "works", "chapters", "boards", "categories", "posts", "saved".
  function renderRows(rows, { kind }) {
    // A redraw (a late search update, another tab's save) keeps focus on the same row.
    const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    listKind = kind;
    visible = rows;
    list.replaceChildren();
    const fragment = document.createDocumentFragment();
    const chaptersMode = kind === "chapters";
    const query = search.value.trim();
    const resume = chaptersMode ? lastReadChapter() : null;
    const progress = kind === "works" ? progressForLane() : null;
    // A work not started yet offers its first chapter the same way (not while searching).
    const start = chaptersMode && !resume && !query ? canonicalChapters(chapterSource)[0] : null;
    // The work's header sits above the search box (#text-work-summary), not among the rows.
    const summaryHost = document.querySelector("#text-work-summary");
    if (chaptersMode) summaryHost.replaceChildren(workSummary(rows));
    else summaryHost.replaceChildren();
    summaryHost.hidden = !chaptersMode;
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
    const buildRow = (entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-item";
      button.dataset.index = String(index);
      const folder = kind === "boards" || kind === "categories" || kind === "shelves";
      button.dataset.key = rowKey(entry, { chaptersMode, folderMode: folder });
      const line = document.createElement("span");
      line.className = "result-title-line";
      const titleText = folder ? entry.folder_label
        : chaptersMode ? (entry.label || "회차")
        : entry.work_id ? (entry.title || entry.work_id)
          : kind === "saved" ? (entry.title || entry.entry?.label || entry.identity)
            : (entry.title || entry.category || entry.identity);
      line.append(query && kind !== "chapters" ? highlighted(titleText, query) : highlighted(titleText, ""));
      let parts;
      let badges = [];
      if (chaptersMode) {
        const key = identity(entry, lane, work);
        const saved = history.history[key];
        const value = saved?.progress ?? 0;
        parts = [
          chapterKind(entry.kind),
          value >= FINISHED ? "다 읽음" : value > 0 ? `${Math.round(value * 100)}%` : saved ? "열어 봄" : "",
          history.bookmarks[key] ? "저장됨" : "",
        ];
        button.classList.toggle("read", value >= FINISHED);
        if (resume?.chapter === entry) {
          button.classList.add("current");
          button.setAttribute("aria-current", "true");
        }
      } else if (kind === "shelves") {
        parts = [`${entry.folder_count.toLocaleString("ko-KR")}개 작품`, entry.hidden ? "전체 목록에서 숨김" : ""];
      } else if (kind === "boards" || kind === "categories") {
        parts = [kind === "boards" ? "게시판" : entry.board, `${entry.folder_count.toLocaleString("ko-KR")}개 글`];
      } else if (kind === "works") {
        const workProgressEntry = progress.get(entry.work_id);
        const { newCount } = workState(entry, workProgressEntry);
        parts = workRowParts(entry, workProgressEntry);
        badges = [newCount ? `새 ${newCount}화` : ""];
      } else if (kind === "saved") {
        parts = [entry.lane === "novel" ? `${entry.entry?.label || "회차"}` : entry.entry?.board || "아카라이브",
          ...(entry.tags ?? []).map((tag) => `#${tag}`), entry.note || ""];
      } else {
        const record = history.history[identity(entry, "arcalive", null)];
        const value = record?.progress ?? 0;
        parts = [
          flatSearch() ? [[entry.board, entry.category].filter(Boolean).join(" · "), "result-board"] : "",
          entry.author, flatSearch() ? "" : entry.category,
          value >= FINISHED ? "다 읽음" : value > 0 ? `${Math.round(value * 100)}%` : record ? "열어 봄" : "",
        ];
        badges = [history.bookmarks[identity(entry, "arcalive", null)] ? "저장" : ""];
        button.classList.toggle("read", value >= FINISHED);
      }
      const badgeNode = badgeElement(badges);
      if (badgeNode) line.append(badgeNode);
      const meta = metaElement(parts);
      if (meta.childElementCount) button.append(line, meta);
      else button.append(line);
      const row = document.createElement("li");
      row.append(button);
      if (kind === "works" && lane === "novel") {
        // 분류: move the work to a shelf without opening it.
        const shelf = shelfOf(history, entry.work_id);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "shelf-edit";
        edit.dataset.workId = entry.work_id;
        edit.dataset.assigned = String(shelf !== UNSORTED);
        edit.textContent = shelf === UNSORTED ? "분류" : shelfName(history, shelf);
        edit.ariaLabel = `${entry.title || "작품"} 분류: ${shelfName(history, shelf)}`;
        row.classList.add("shelf-row");
        row.append(edit);
      }
      return row;
    };
    rowWindow = { build: buildRow, key: (entry) => rowKey(entry, { chaptersMode, folderMode: kind === "boards" || kind === "categories" }) };
    rendered = 0;
    list.append(fragment);
    renderMore(RENDER_CHUNK);
    if (focusedKey) {
      renderThroughKey(focusedKey);
      list.querySelector(`${ROW_SELECTOR}[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
    }
    document.querySelector("#result-more").hidden = true;
    document.querySelector("#search-empty").hidden = true;
    const noun = { works: "작품", boards: "게시판", categories: "분류", posts: "글", saved: "자료", shelves: "분류" }[kind] ?? "자료";
    status.textContent = chaptersMode ? chapterStatus(rows.length) : `${rows.length.toLocaleString("ko-KR")}개 ${noun}`;
    if (kind === "works" && lane === "novel") {
      if (shelfFilter) status.textContent = `${shelfName(history, shelfFilter)} · ${status.textContent}`;
      else if (hiddenWorks) status.textContent += ` · 숨긴 분류 ${hiddenWorks.toLocaleString("ko-KR")}개 제외`;
    }
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = !(kind === "works" ? currentWorks() : catalog).length ? "아직 게시된 자료가 없습니다."
        : kind === "works" && (readFilter !== "all" || sourceFilter) && !query ? "이 조건의 작품이 없습니다."
          : "검색 결과가 없습니다.";
      list.append(empty);
    }
  }

  // The work header above the rows carries title, author, and reading progress.
  function chapterStatus(shown) {
    const total = chapterSource.length;
    return shown === total ? `${total.toLocaleString("ko-KR")}화` : `${shown.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}화 표시`;
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

  function orderedWorks(rows, progress = null) {
    const title = (left, right) => String(left.title || left.work_id || "")
      .localeCompare(String(right.title || right.work_id || ""), "ko-KR", { numeric: true })
      || String(left.work_id || "").localeCompare(String(right.work_id || ""));
    const copy = [...rows];
    if (postsView() && (sortMode === "latest" || sortMode === "oldest")) {
      const direction = sortMode === "latest" ? -1 : 1;
      copy.sort((left, right) => direction * ((Number(left.post_id) || 0) - (Number(right.post_id) || 0)) || title(left, right));
    } else if (sortMode === "recent" && progress) {
      const readAt = (item) => progress.get(item.work_id)?.lastReadAt ?? "";
      copy.sort((left, right) => readAt(right).localeCompare(readAt(left)) || title(left, right));
    } else if (sortMode === "longest") {
      copy.sort((left, right) => (right.chapter_count || 0) - (left.chapter_count || 0) || title(left, right));
    } else if (sortMode === "updated") {
      copy.sort((left, right) => String(right.last_imported_at || "").localeCompare(String(left.last_imported_at || ""))
        || title(left, right));
    } else copy.sort(title);
    return copy;
  }

  function renderCatalog() {
    renderedQuery = search.value;
    const query = normalize(search.value.trim());
    const progress = worksView() ? progressForLane() : null;
    renderReadChips(progress);
    if (work) {
      const displayed = orderChapters(chapterSource, sortMode);
      renderRows(displayed.filter((chapter) => normalize(`${chapter.label || ""} ${chapterKind(chapter.kind)}`).includes(query)),
        { kind: "chapters" });
      return;
    }
    if (shelfFolders()) {
      const counts = shelfCounts(history, catalog);
      const folders = [
        { folder_label: "미분류", shelf_id: UNSORTED, folder_count: counts.get(UNSORTED) ?? 0, hidden: false },
        ...history.shelves.map((shelf) => ({
          folder_label: shelf.name, shelf_id: shelf.id, folder_count: counts.get(shelf.id) ?? 0, hidden: shelf.hidden,
        })),
      ].filter((folder) => normalize(folder.folder_label).includes(query));
      renderRows(folders, { kind: "shelves" });
      return;
    }
    if (progress) {
      const hidden = hiddenShelfIds(history);
      hiddenWorks = 0;
      const matchesWork = (item) => {
        if (!shelfVisible(item, hidden)) {
          hiddenWorks += 1;
          return false;
        }
        return normalize(`${item.title || ""} ${item.author || ""} ${item.board || ""} ${item.category || ""}`).includes(query)
          && (!sourceFilter || lane !== "novel" || item.source_site === sourceFilter)
          && matchesReadFilter(workState(item, progress.get(item.work_id)));
      };
      renderRows(orderedWorks(currentWorks().filter(matchesWork), progress), { kind: "works" });
      return;
    }
    if (lane === "saved") {
      renderRows(orderedWorks(catalog.filter((item) =>
        normalize(`${item.title || ""} ${item.entry?.label || ""} ${item.note || ""} ${(item.tags ?? []).join(" ")}`).includes(query))), { kind: "saved" });
      return;
    }
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
    const scope = folderBoard ? catalog.filter((item) => String(item.board || "미분류") === folderBoard) : catalog;
    const matching = query
      ? scope.filter((item) => normalize(`${item.title || ""} ${item.author || ""} ${item.board || ""} ${item.category || ""}`).includes(query))
      : scope;
    // Searching above a category lists the matching posts themselves, newest first.
    if (flatSearch()) {
      return renderRows(matching.slice().sort((left, right) => (Number(right.post_id) || 0) - (Number(left.post_id) || 0)), { kind: "posts" });
    }
    if (!folderBoard) return renderRows(group(matching, "board"), { kind: "boards" });
    if (!folderCategory) return renderRows(group(matching, "category"), { kind: "categories" });
    return renderRows(orderedWorks(matching.filter((item) => String(item.category || "미분류") === folderCategory)), { kind: "posts" });
  }

  function rememberListPosition() {
    saveListPosition(listRoute(), captureListAnchor(list, ROW_SELECTOR));
  }

  function restoreListPosition() {
    const snapshot = loadListPosition(listRoute());
    requestAnimationFrame(() => {
      if (snapshot) {
        renderThroughKey(snapshot.key);
        restoreListAnchor(list, snapshot, ROW_SELECTOR);
      } else list.scrollTop = 0;
    });
  }

  function syncBackButton() {
    const button = document.querySelector("#text-work-back");
    const shown = Boolean(work || folderBoard || (lane === "novel" && shelfFilter));
    // Inside a work the list-level views (전체 목록/분류별/분류 관리) do not apply.
    document.querySelector("#novel-views").hidden = !active || lane !== "novel" || Boolean(work);
    if (!work) {
      const summaryHost = document.querySelector("#text-work-summary");
      summaryHost.hidden = true;
      summaryHost.replaceChildren();
    }
    button.hidden = !shown;
    button.textContent = work ? "← 작품 목록"
      : lane === "novel" ? "← 분류 목록"
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
    // Browse's source switch names the two text lanes next to TypeMoon.
    for (const button of document.querySelectorAll("#source-switch [data-source]")) {
      button.setAttribute("aria-pressed", String(button.dataset.source === lane));
    }
    const novelViews = document.querySelector("#novel-views");
    novelViews.hidden = lane !== "novel";
    for (const button of novelViews.querySelectorAll("[data-novel-view]")) {
      const pressed = button.dataset.novelView === novelView;
      button.classList.toggle("active", pressed);
      button.setAttribute("aria-pressed", String(pressed));
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
    readNovelView(params);
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
      if (lane === "novel" && (migrateNovelState(history, catalog) | migrateShelfAliases(history, catalog))) persist();
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
    readNovelView(params);
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
    if (lane === "arcalive" && listKind === "posts") {
      // The posts shown, in posting order: the list sort never changes 이전/다음 글.
      const entries = visible.slice().sort((left, right) => (Number(left.post_id) || 0) - (Number(right.post_id) || 0));
      return { unit: "글", entries, index: entries.findIndex((item) => sameChapter(item, entry)), toc: false };
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
      run: sequence?.toc && sequence.index >= 0 ? {
        position: sequence.index + 1, total: sequence.entries.length, unit,
        entries: sequence.entries.map((entry, at) => ({
          position: at + 1,
          state: at === sequence.index ? "reading" : (history.history[identity(entry, current.lane, current.work)]?.progress ?? 0) >= FINISHED ? "read" : "unread",
        })),
      } : null,
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
    shell.cancelPendingWork();
    const bodyController = new AbortController();
    shell.trackPendingWork(() => bodyController.abort());
    const [response, chapters] = await Promise.all([
      fetch(`/api/v1/text/object/${hash}`, { credentials: "same-origin", redirect: "error", signal: bodyController.signal }),
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
      ...(itemWork?.work_id ? { workId: itemWork.work_id } : {}),
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
      documentId: isNovel ? `novel:${entry.source_site || ""}:${entry.chapter_id}` : identity(entry, currentLane),
      workId: itemWork?.work_id || "",
      revision: hash,
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
    readerPane.scrollTop = record.loc ? 0 : record.scroll || 0;
    shell.syncScroll();
    const anchor = record.anchor || record.loc ? { offset: record.offset, quote: record.anchor, viewportOffset: record.anchorTop ?? 0, atStart: record.scroll === 0, ...(record.loc ? { loc: record.loc } : {}) } : null;
    // Offset-based anchors are exact; legacy quote-only anchors are used only for a new revision.
    shell.scheduleFrame(() => {
      if (anchor && (anchor.loc || Number.isInteger(record.offset) || (record.revision && record.revision !== hash))) shell.restoreAnchor(anchor);
      shell.captureAnchor();
    });
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
    else if (lane === "novel" && shelfFilter) params.delete("shelf");
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
    } else if (lane === "novel" && shelfFilter) shelfFilter = "";
    else if (folderCategory) folderCategory = null;
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
    if (listKind === "shelves") {
      shelfFilter = selected.shelf_id;
      sortMode = defaultSort();
      syncBackButton();
      onChange();
      renderCatalog();
      pushRoute();
      list.scrollTop = 0;
      return;
    }
    if (listKind === "boards") {
      folderBoard = selected.folder_label;
      syncBackButton();
      onChange();
      renderCatalog();
      pushRoute();
      list.scrollTop = 0;
      return;
    }
    if (listKind === "categories") {
      folderCategory = selected.folder_label;
      sortMode = defaultSort();
      syncBackButton();
      onChange();
      renderCatalog();
      pushRoute();
      list.scrollTop = 0;
      return;
    }
    // Picking another row from the side list while a body is open stays in the same session.
    const navigation = current ? "replace" : "push";
    const action = lane === "saved"
      ? openBody(selected.entry, { navigation, sourceLane: selected.lane, sourceWork: selected.work, savedIdentity: selected.identity })
      : listKind === "works" ? openWork(selected) : openBody(selected, { navigation });
    void action.catch((error) => { status.textContent = `본문을 열지 못했습니다 · ${error.message}`; });
  }

  function searchChanged(query) {
    if (query !== search.value) search.value = query;
    // A late (debounced) notice for the text already shown must not rebuild the list or the
    // work header someone is typing in.
    if (!catalog.length || search.value === renderedQuery) return;
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
    if (!current || !shell.canSavePosition()) return;
    const old = history.history[current.identity] || {};
    const measured = shell.progress();
    const anchor = shell.captureAnchor();
    history.history[current.identity] = {
      ...old,
      readAt: old.readAt || new Date().toISOString(),
      scroll: shell.readingPosition(),
      progress: (old.progress ?? 0) >= FINISHED ? Math.max(old.progress, measured) : measured,
      chapterId: current.entry.chapter_id || current.entry.source_chapter_id || "",
      revision: current.entry.sha256 || "",
      ...(anchor ? { anchor: anchor.quote, offset: anchor.offset, anchorTop: Math.round(anchor.viewportOffset), loc: anchor.loc } : {}),
      documentId: current.lane === "novel" ? `novel:${current.entry.source_site || ""}:${current.entry.chapter_id}` : identity(current.entry, current.lane),
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

  // 더보기 → 이전 회차 모두 읽음: for chapters read elsewhere before this archive, so the work's
  // progress and 이어 읽기 start from here. Returns how many chapters changed.
  function previousUnreadCount() {
    if (current?.lane !== "novel" || !sequence || sequence.index <= 0) return 0;
    return sequence.entries.slice(0, sequence.index)
      .filter((chapter) => (history.history[identity(chapter, "novel", current.work)]?.progress ?? 0) < FINISHED).length;
  }

  function markPreviousRead() {
    const count = previousUnreadCount();
    if (!count) return 0;
    flushPosition();
    // Older than the open chapter, so it stays the one 이어 읽기 resumes.
    const readAt = new Date(Date.parse(history.history[current.identity]?.readAt || "") - 1000 || Date.now() - 1000).toISOString();
    for (const chapter of sequence.entries.slice(0, sequence.index)) {
      const key = identity(chapter, "novel", current.work);
      const record = history.history[key];
      if ((record?.progress ?? 0) >= FINISHED) continue;
      history.history[key] = {
        ...(record ?? {
          readAt, title: chapter.label || "", work: current.work?.title || "",
          ...(current.work?.work_id ? { workId: current.work.work_id } : {}), total: current.work?.chapter_count ?? 0,
        }),
        progress: 1,
      };
    }
    pruneHistory();
    persist();
    publishList();
    return count;
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

  document.querySelector("#arcalive-views").addEventListener("click", (event) => {
    const button = event.target.closest("[data-arcalive-view]");
    if (!button || button.dataset.arcaliveView === arcaliveView) return;
    const next = new URLSearchParams({ lane: "arcalive", ...(button.dataset.arcaliveView === "works" ? { view: "works" } : {}) });
    void open(next);
    window.history.pushState({ redstmText: true }, "", `/text?${next}`);
  });
  document.querySelector("#text-read-chips")?.addEventListener("change", (event) => {
    if (event.target.id !== "text-source-filter" || !worksView()) return;
    sourceFilter = event.target.value;
    renderCatalog();
    list.scrollTop = 0;
    if (!current) window.history.replaceState(window.history.state, "", listRoute());
  });
  document.querySelector("#text-read-chips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-text-read]");
    if (chip) setReadFilter(chip.dataset.textRead);
  });
  document.querySelector("#text-work-back").addEventListener("click", () => {
    if (!current && (work || folderBoard || (lane === "novel" && shelfFilter))) up();
  });
  // 작품 분류 dialog: pick this work's shelf, and add/rename/hide/reorder/remove shelves.
  const shelfDialog = document.querySelector("#shelf-dialog");
  let shelfWorkId = "";
  const SHELF_ERRORS = {
    name_empty: "분류 이름을 입력하세요.", name_taken: "같은 이름의 분류가 이미 있습니다.", too_many: "분류는 50개까지 만들 수 있습니다.",
  };

  function shelvesChanged(message = "") {
    persist();
    if (message) document.querySelector("#shelf-message").textContent = message;
    renderShelfDialog();
    if (!active) return;
    if (current) publishList();
    else renderCatalog();
  }

  function renderShelfDialog() {
    const work = (catalogs.get("novel")?.items ?? []).find((item) => item.work_id === shelfWorkId);
    document.querySelector("#shelf-dialog-work").textContent = shelfWorkId ? (work?.title || "작품") : "이 브라우저에 저장됩니다";
    document.querySelector("#shelf-dialog-title").textContent = shelfWorkId ? "작품 분류" : "분류 관리";
    const choice = document.querySelector("#shelf-choice");
    choice.hidden = !shelfWorkId;
    if (shelfWorkId) {
      const assigned = shelfOf(history, shelfWorkId);
      document.querySelector("#shelf-options").replaceChildren(...[
        { id: UNSORTED, name: "미분류", hidden: false }, ...history.shelves,
      ].map((shelf) => {
        const option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "radio");
        option.dataset.shelfChoice = shelf.id;
        option.setAttribute("aria-checked", String(shelf.id === assigned));
        option.textContent = shelf.hidden ? `${shelf.name} (숨김)` : shelf.name;
        return option;
      }));
    }
    const counts = shelfCounts(history, catalogs.get("novel")?.items ?? []);
    document.querySelector("#shelf-manage-list").replaceChildren(...history.shelves.map((shelf, index) => {
      const row = document.createElement("li");
      row.dataset.shelfId = shelf.id;
      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 30;
      name.value = shelf.name;
      name.ariaLabel = `${shelf.name} 이름 (${counts.get(shelf.id) ?? 0}개 작품)`;
      name.dataset.shelfRename = "true";
      const actions = document.createElement("span");
      actions.className = "shelf-row-actions";
      for (const [label, action, disabled] of [
        ["↑", "up", index === 0], ["↓", "down", index === history.shelves.length - 1], ["삭제", "remove", false],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.shelfAction = action;
        button.textContent = label;
        button.disabled = disabled;
        button.ariaLabel = action === "remove" ? `${shelf.name} 삭제` : `${shelf.name} ${action === "up" ? "위로" : "아래로"}`;
        if (action === "remove") button.className = "shelf-remove";
        actions.append(button);
      }
      const hidden = document.createElement("label");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = shelf.hidden;
      toggle.dataset.shelfHidden = "true";
      hidden.append(toggle, `전체 목록에서 숨기기 · ${(counts.get(shelf.id) ?? 0).toLocaleString("ko-KR")}개 작품`);
      row.append(name, actions, hidden);
      return row;
    }));
  }

  function openShelfDialog(workId = "") {
    shelfWorkId = workId;
    document.querySelector("#shelf-message").textContent = "숨긴 분류의 작품은 전체 목록에 나오지 않고 분류별 보기에서만 보입니다.";
    document.querySelector("#shelf-new-name").value = "";
    document.querySelector("#shelf-new-hidden").checked = false;
    renderShelfDialog();
    if (!shelfDialog.open) shelfDialog.showModal();
  }

  shelfDialog.addEventListener("click", (event) => {
    const option = event.target.closest("[data-shelf-choice]");
    if (option && shelfWorkId) {
      if (setWorkShelf(history, shelfWorkId, option.dataset.shelfChoice)) {
        shelvesChanged(`${shelfName(history, option.dataset.shelfChoice)}(으)로 옮겼습니다.`);
      }
      return;
    }
    const button = event.target.closest("[data-shelf-action]");
    const shelfId = button?.closest("[data-shelf-id]")?.dataset.shelfId;
    if (!button || !shelfId) return;
    if (button.dataset.shelfAction === "remove") {
      // Two presses: the first asks, the second removes (its works go back to 미분류).
      if (button.dataset.confirm !== "true") {
        button.dataset.confirm = "true";
        button.textContent = "정말 삭제";
        return;
      }
      const removedName = shelfName(history, shelfId);
      removeShelf(history, shelfId);
      if (shelfFilter === shelfId) shelfFilter = "";
      shelvesChanged(`${removedName} 분류를 지웠습니다. 그 작품은 미분류로 돌아갑니다.`);
      return;
    }
    if (moveShelf(history, shelfId, button.dataset.shelfAction === "up" ? -1 : 1)) shelvesChanged();
  });
  shelfDialog.addEventListener("change", (event) => {
    const shelfId = event.target.closest("[data-shelf-id]")?.dataset.shelfId;
    if (!shelfId) return;
    if (event.target.dataset.shelfHidden) {
      setShelfHidden(history, shelfId, event.target.checked);
      shelvesChanged();
    } else if (event.target.dataset.shelfRename) {
      const result = renameShelf(history, shelfId, event.target.value);
      shelvesChanged(result.error ? SHELF_ERRORS[result.error] : "");
    }
  });
  function addShelfFromDialog() {
    const input = document.querySelector("#shelf-new-name");
    const result = addShelf(history, input.value, { hidden: document.querySelector("#shelf-new-hidden").checked });
    if (result.error) {
      document.querySelector("#shelf-message").textContent = SHELF_ERRORS[result.error];
      return;
    }
    input.value = "";
    document.querySelector("#shelf-new-hidden").checked = false;
    // Made while sorting a work: the work goes there too.
    if (shelfWorkId) setWorkShelf(history, shelfWorkId, result.id);
    shelvesChanged(`${shelfName(history, result.id)} 분류를 만들었습니다.`);
  }
  document.querySelector("#shelf-add").addEventListener("click", addShelfFromDialog);
  document.querySelector("#shelf-new-name").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    addShelfFromDialog();
  });
  for (const host of [list, document.querySelector("#text-work-summary")]) host.addEventListener("click", (event) => {
    const button = event.target.closest(".shelf-edit, .shelf-summary");
    if (button && active) openShelfDialog(button.dataset.workId);
  });
  document.querySelector("#novel-shelf-manage").addEventListener("click", () => openShelfDialog(""));
  document.querySelector("#novel-views").addEventListener("click", (event) => {
    const button = event.target.closest("[data-novel-view]");
    if (!button || (button.dataset.novelView === novelView && !shelfFilter && !work)) return;
    const next = new URLSearchParams({ lane: "novel", ...(button.dataset.novelView === "shelves" ? { view: "shelves" } : {}) });
    void open(next);
    window.history.pushState({ redstmText: true }, "", `/text?${next}`);
  });
  if (shelvesAdded) persist();

  readerPane.addEventListener("scroll", () => {
    if (!current || !shell.canSavePosition()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
  }, { passive: true });

  function sortContext() {
    if (work) return "chapters";
    if (postsView()) return "posts";
    if (shelfFolders()) return "titles";
    if (lane === "novel" || lane === "arcalive" && arcaliveView === "works") return "works";
    return "titles";
  }

  function setSort(value) {
    const allowed = new Set(sortOptions().map(([, option]) => option));
    const next = allowed.has(value) ? value : defaultSort();
    if (next === sortMode) return;
    sortMode = next;
    renderCatalog();
    if (!current) window.history.replaceState(window.history.state, "", listRoute());
  }

  function currentSort() { return sortMode; }

  function setReadFilter(value) {
    const next = READ_FILTER_VALUES.has(value) ? value : "all";
    if (next === readFilter || !worksView()) return;
    readFilter = next;
    renderCatalog();
    list.scrollTop = 0;
    if (!current) window.history.replaceState(window.history.state, "", listRoute());
  }

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
    if (shelfFolders()) return "분류 이름 검색";
    if (lane === "novel" || lane === "arcalive" && arcaliveView === "works") return "작품 제목·작가 검색";
    if (lane === "saved") return "저장한 자료·메모·태그 검색";
    if (folderCategory) return "글 제목 검색";
    return "게시판·분류 검색";
  }

  function sortOptions() {
    const context = sortContext();
    if (context === "posts") return [["최신순", "latest"], ["오래된순", "oldest"], ["제목순", "title"]];
    return context === "chapters"
      ? [["오래된순", "oldest"], ["최신순", "latest"], ["이름순", "title"]]
      : context === "works"
        ? [["최근 갱신순", "updated"], ["가나다순", "title"], ["편수 많은순", "longest"], ["최근 읽은순", "recent"]]
        : [];
  }

  // Works being read (some chapter read, not all finished), newest first, for Home. The novel
  // catalog is fetched when it is not loaded yet, so chapters published since the last visit
  // show as new; without it the reading records alone are used.
  async function readingWorks() {
    const progressByWork = workProgress();
    if (progressByWork.size && !catalogs.has("novel")) await loadCatalog("novel").catch(() => null);
    const works = catalogs.get("novel")?.items ?? [];
    const byId = new Map(works.map((item) => [item.work_id, item]));
    return [...progressByWork].map(([workId, progress]) => {
      const item = byId.get(workId);
      const total = item?.chapter_count ?? progress.record?.total ?? 0;
      if (!progress.record?.listRoute || (total && progress.finished >= total)) return null;
      const { newCount } = item ? workState(item, progress) : { newCount: 0 };
      return {
        title: item?.title || progress.record.work || "소설",
        meta: [total ? `읽음 ${progress.finished}/${total}` : "", progress.record.title ? `최근 ${progress.record.title}` : ""].filter(Boolean).join(" · "),
        workId,
        progress: total ? progress.finished / total : null,
        listRoute: progress.record.listRoute,
        readAt: progress.lastReadAt,
        newCount,
      };
    }).filter(Boolean).sort((left, right) => right.readAt.localeCompare(left.readAt));
  }

  // Saved novel chapters and Arcalive posts for the TypeMoon 보관함's 저장한 글, newest first.
  function savedItems(query = "") {
    const wanted = normalize(query.trim());
    return savedEntries().map((saved) => ({
      identity: saved.identity,
      title: saved.lane === "novel" ? `${saved.work?.title || saved.title || "소설"} · ${saved.entry?.label || "회차"}`
        : (saved.entry?.title || saved.title || "아카라이브 글"),
      meta: [saved.lane === "novel" ? "소설" : ["아카라이브", saved.entry?.board].filter(Boolean).join(" · "),
        ...(saved.tags ?? []).map((tag) => `#${tag}`)].join(" · "),
      note: saved.note || "",
      savedAt: saved.savedAt || "",
      listRoute: "/text?lane=saved",
      route: `/text?${new URLSearchParams({ lane: "saved", item: saved.identity })}`,
    })).filter((item) => !wanted || normalize(`${item.title} ${item.meta} ${item.note}`).includes(wanted))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  // Backup (settings → 기록 내보내기/가져오기). Import replaces this browser's text records.
  function exportState() {
    flushPosition();
    return {
      schema_version: 1, history: history.history, bookmarks: history.bookmarks,
      shelves: history.shelves, workShelves: history.workShelves,
    };
  }

  function importState(state) {
    history.history = { ...state.history };
    history.bookmarks = { ...state.bookmarks };
    if (Array.isArray(state.shelves)) {
      history.shelves = state.shelves.map((shelf) => ({ ...shelf }));
      history.workShelves = { ...(state.workShelves ?? {}) };
      ensureShelves(history);
    }
    pruneHistory();
    persist();
    if (!active) return;
    if (current) {
      updateBookmark();
      publishList();
    } else {
      if (lane === "saved") catalog = savedEntries();
      renderCatalog();
    }
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
    renderReadChips(null);
    document.querySelector("#novel-views").hidden = true;
    rowObserver?.unobserve(rowSentinel);
    rowSentinel.remove();
    rowWindow = null;
    shell.close();
  }

  return {
    cancelPendingPosition: () => clearTimeout(saveTimer),
    open, route: routeTo, searchChanged, activate, isReading, inWork, sortContext, setSort, currentRoute,
    leave, changeLane, command, parentRoute, flush: flushPosition, latestReading, currentSort,
    searchPlaceholder, sortOptions, readingWorks, bookmarkDetails, saveBookmarkDetails, removeBookmark,
    exportState, importState, previousUnreadCount, markPreviousRead, savedItems,
  };
}
