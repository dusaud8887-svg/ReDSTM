import {
  STATE_KEY,
  defaultUserState,
  exportUserState,
  migrateLegacyState,
  planImport,
  postIdentity,
  sanitizeBookmarkMetadata,
  samePost,
} from "/user-state.js";
import {
  boardDisplayName,
  boardGroupLabel,
  collectionAvailableCount,
  collectionContinueTarget,
  collectionOccupancy,
  collectionRowCopy,
  formatSourceDate,
  postReadingLabel,
  postReadingState,
} from "/reading-model.js";
import { createBoardNavigator } from "/board-navigator.js";
import {
  applyArchivedMedia, arcaPaths, decorateImages, enhanceHtmlMedia, renderPlainTextWithMedia,
} from "/media.js";
import { captureListAnchor, loadListPosition, restoreListAnchor, saveListPosition } from "/list-anchor.js";
import { adjacentInSequence } from "/sequence.js";
import { captureTextAnchor, restoreTextAnchor } from "/text-anchor.js";
import { createTextLibrary } from "/text-library.js";

const postObjectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const collectionObjectKeyPattern = /^collections\/[a-z0-9_/-]+-[a-f0-9]{64}\.json\.zst$/;
const titleCollator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
const collectionDateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });
const storageKeys = {
  settings: "redstm.settings.v1",
  history: "redstm.history.v1",
  bookmarks: "redstm.bookmarks.v1",
};
const defaultSettings = {
  theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, proseMargin: 20, proseFont: "serif",
  aaSize: 16, aaZoom: 1, aaCanvasWidth: null, aaBackground: "#f5f5f0", aaPreserveStyles: true,
  viewModes: {},
};
const settingLabels = {
  theme: "테마", proseSize: "본문 크기", lineHeight: "줄 간격", proseWidth: "본문 너비", proseMargin: "좌우 여백",
  proseFont: "본문 서체", aaSize: "AA 크기", aaZoom: "AA 확대", aaCanvasWidth: "AA 폭",
  aaBackground: "AA 배경", aaPreserveStyles: "AA 원본색",
};
const elements = Object.fromEntries(
  [
    "archive-count", "archive-state", "search-input", "search-target", "search-match", "board-filter", "mode-filter", "sort-filter", "collection-kind-filter", "collection-read-filter", "result-status", "result-list", "result-more",
    "reader-pane", "empty-reader", "empty-count", "reader", "reader-kicker", "reader-title", "reader-meta", "collection-context",
    "scope-tabs", "text-lanes", "collection-view", "collection-back", "collection-title", "collection-meta", "collection-continue", "collection-entry-list",
    "archive-body", "comments", "comment-count", "comment-list", "previous-post", "next-post", "previous-post-label", "next-post-label", "bookmark-post", "source-link",
    "reader-topbar-title", "reader-top-bookmark", "chapter-end-note", "end-next-kicker", "end-previous-kicker", "end-list", "end-toc",
    "theme-toggle", "reader-settings", "settings-dialog", "prose-size", "line-height", "prose-width", "prose-margin", "aa-size",
    "prose-size-output", "line-height-output", "prose-width-output", "prose-margin-output", "aa-size-output", "reset-settings",
    "export-state", "import-state", "import-state-file", "continue-reading", "continue-title", "continue-work",
    "continue-meta", "continue-block", "continue-toc", "catalog-back", "prose-font", "aa-controls", "aa-inline-size",
    "catalog-search-row", "catalog-toolbar", "catalog-controls", "filter-toggle", "active-filters", "search-clear",
    "mode-chips", "kind-chips",
    "search-empty", "search-empty-copy", "search-widen", "recent-queries", "reading-works", "reading-works-list", "reading-works-all",
    "recent-all", "filter-dialog", "filter-dialog-fields", "filter-reset", "filter-apply",
    "board-dock", "board-dock-button", "board-dock-group", "board-dock-name", "board-dock-clear", "board-dialog", "board-panel", "board-search",
    "image-viewer", "image-viewer-image", "image-viewer-source",
    "collection-jump", "collection-jump-input",
    "reader-topbar-progress", "more-position", "more-position-output",
    "text-sort-chips",
    "reader-list", "reader-list-kicker", "reader-list-title", "reader-list-all", "reader-list-hint",
    "reader-list-items", "reader-list-previous", "reader-list-next", "reader-list-range",
    "aa-source-styles", "aa-background", "aa-zoom-output", "aa-zoom-reset", "aa-zoom-indicator",
    "reading-progress", "reader-status", "immersive-toggle", "end-previous", "end-next",
    "end-previous-title", "end-next-title", "mode-toggle", "mode-reset", "theme-choices",
    "home-title", "home-freshness", "latest-list", "recent-list", "browse-all",
    "reader-bottom-list", "reader-bottom-previous", "reader-bottom-next", "reader-bottom-settings", "reader-bottom-more", "reader-toolbar-more",
    "reader-bottom-previous-label", "reader-bottom-next-label",
    "reader-more", "reader-more-context", "more-toc", "more-bookmark", "more-bookmark-label", "more-note", "more-source",
    "more-mode", "more-mode-label", "more-mode-reset", "more-immersive", "more-immersive-label",
    "catalog-toggle", "catalog-title", "catalog-subtitle", "home-action", "immersive-exit", "import-review", "import-review-summary", "import-apply", "import-cancel",
    "bookmark-dialog", "bookmark-form", "bookmark-dialog-post", "bookmark-note", "bookmark-tags", "bookmark-remove",
  ].map((id) => [id, document.getElementById(id)]),
);
elements["result-list"].classList.add("loading");

const RESULT_PAGE_SIZE = 100;

let userState = loadUserState();
let settings;
let historyEntries;
let bookmarks;
applyUserState(userState);
let renderedResults = [];
let currentSummary = null;
let currentPayload = null;
let currentMode = "prose";
let currentCollection = null;
let activeCollectionId = null;
let collectionIndexPromise;
const collectionDetailPromises = new Map();
const collectionMembershipPromises = new Map();
let renderedCollections = [];
let collectionProgressById = new Map();
let currentScope = "posts";
let collectionSearchId = 0;
let readerViewId = 0;
let collectionProgressFailedBoards = new Set();
let currentView = "all";
let currentDestination = "library";
// A TypeMoon archive failure that arrived while the text library was on screen.
let deferredArchiveError = null;
let messageId = 0;
let searchRequestId = 0;
let resultTotal = 0;
let searchAppend = false;
let scrollTimer;
let searchTimer;
let postController;
let pinchDistance = 0;
let zoomFeedbackTimer;
let zoomPersistTimer;
let aaHintShown = false;
let pendingImportPlan = null;
let lastReaderScroll = 0;
let readerScrollDelta = 0;
let latestPosts = [];
let publishedAt = null;
let archiveReady = false;
let pendingCatalogRestore = userState.lastCatalogState;
let searchSupportsAa = true;
let boardById = new Map();
let collectionBoardIds = null;
let recentQueries = Array.isArray(userState.lastCatalogState?.recentQueries)
  ? userState.lastCatalogState.recentQueries.filter((query) => typeof query === "string").slice(0, 5)
  : [];
let filterOpener = null;
let continueCollectionId = null;
let continueTargetPost = null;
// A text chapter Home can resume ({ route, listRoute, … } from the text library) or null.
let continueText = null;
const prefetched = new Set();
const READER_LIST_PAGE = 10;
// The list shown under a Reader body: { onOpen(key), onPage(delta) } from the owning source.
let readerListModel = null;
// TypeMoon: the list a reading session came from, derived from its parent route.
let listContext = null;
let listRequestId = 0;
let textRenderId = 0;
let immersiveOpener = null;
let editingBookmarkSummary = null;
// True while the bookmark editor edits the open text chapter instead of a TypeMoon post.
let editingTextBookmark = false;
// Which source owns the shared Reader shell: "typemoon", "text", or null when it is closed.
let readerSource = null;
let readerNavigation = null;
let routeHandled = false;
let pointerStart = null;
let moreOpener = null;
// Filter sheet edits are a draft until 적용; closing any other way restores this snapshot.
let filterDraft = null;
let catalogNote = "";
const workerRequests = new Map();
const textLibrary = createTextLibrary({
  readerPane: elements["reader-pane"],
  shell: {
    open: openTextReader,
    close: closeTextReader,
    setNavigation: renderReaderNavigation,
    setBookmarked: renderBookmarkState,
    progress: bodyProgress,
    syncScroll: syncScrollBaseline,
    setList: renderReaderList,
    captureAnchor: () => captureTextAnchor(elements["archive-body"], elements["reader-pane"], readerTopInset()),
    restoreAnchor: (anchor) => {
      restoreTextAnchor(elements["archive-body"], elements["reader-pane"], anchor, readerTopInset());
      syncScrollBaseline();
    },
  },
  onChange: () => {
    updateShellMode();
    if (currentDestination === "text") applyTextSortOptions();
  },
});

const boardNavigator = createBoardNavigator({
  dialog: elements["board-dialog"],
  panel: elements["board-panel"],
  search: elements["board-search"],
  boards: navigatorBoards,
  selected: () => elements["board-filter"].value,
  onSelect: selectBoard,
});

const searchWorker = new Worker("/search-worker.js", { type: "module" });
searchWorker.addEventListener("message", handleWorkerMessage);
searchWorker.postMessage({ type: "init", id: ++messageId });

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadUserState() {
  const stored = readJson(STATE_KEY, null);
  try {
    if (stored) return planImport(JSON.stringify(stored), defaultSettings).state;
    return migrateLegacyState({
      settings: readJson(storageKeys.settings, defaultSettings),
      history: readJson(storageKeys.history, []),
      bookmarks: readJson(storageKeys.bookmarks, []),
    }, defaultSettings);
  } catch {
    return defaultUserState(defaultSettings);
  }
}

function entriesFromState(map, timestampKey) {
  return Object.entries(map)
    .map(([identity, value]) => {
      const [boardId, externalId] = identity.split(":");
      return {
        summary: { board_id: boardId, external_post_id: Number(externalId) },
        [timestampKey]: value[timestampKey],
        ...(timestampKey === "readAt" ? { scroll: userState.scroll[identity] ?? 0, progress: value.progress ?? 0 } : {}),
        ...(timestampKey === "savedAt" ? { note: value.note ?? "", tags: value.tags ?? [] } : {}),
      };
    })
    .sort((left, right) => Date.parse(right[timestampKey]) - Date.parse(left[timestampKey]));
}

function applyUserState(state) {
  userState = state;
  settings = {
    ...defaultSettings,
    ...state.settings,
    viewModes: { ...defaultSettings.viewModes, ...state.viewModes },
  };
  historyEntries = entriesFromState(state.history, "readAt");
  bookmarks = entriesFromState(state.bookmarks, "savedAt");
}

function persistUserState() {
  const { viewModes, ...savedSettings } = settings;
  userState = {
    schema_version: 2,
    settings: savedSettings,
    history: Object.fromEntries(historyEntries.map((entry) => [
      postIdentity(entry.summary), { readAt: entry.readAt, progress: entry.progress ?? 0 },
    ]).filter(([identity]) => identity)),
    bookmarks: Object.fromEntries(bookmarks.map((entry) => [
      postIdentity(entry.summary), {
        savedAt: entry.savedAt,
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.tags?.length ? { tags: entry.tags } : {}),
      },
    ]).filter(([identity]) => identity)),
    scroll: Object.fromEntries(historyEntries.map((entry) => [
      postIdentity(entry.summary), entry.scroll ?? 0,
    ]).filter(([identity]) => identity)),
    viewModes,
    lastCatalogState: userState.lastCatalogState,
  };
  try {
    localStorage.setItem(STATE_KEY, exportUserState(userState));
    for (const key of Object.values(storageKeys)) localStorage.removeItem(key);
  } catch (error) {
    elements["archive-state"].textContent = "로컬 저장 실패";
    console.warn("Reader state could not be saved", error);
  }
}

function saveSettings() {
  persistUserState();
  applySettings();
}

function normalized(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function boardLabel(boardId) {
  return boardDisplayName(boardById.get(boardId), boardId || "");
}

function historyByIdentityMap() {
  return new Map(historyEntries.map((entry) => [postIdentity(entry.summary), entry]));
}

function updateShellMode() {
  const collectionOpen = !elements["collection-view"].hidden;
  const reading = Boolean(currentSummary) || collectionOpen || (currentDestination === "text" && textLibrary.isReading());
  const home = currentDestination === "library" && !reading;
  document.body.classList.toggle("home-open", home);
  document.body.classList.toggle("discovery", !home && !reading);
  document.body.classList.toggle("reading", reading);
  document.body.classList.toggle("reading-context", reading && ["browse", "search", "bookmarks", "text"].includes(currentDestination));
  document.body.classList.toggle("browse-open", currentDestination === "browse");
  document.body.classList.toggle("search-open", currentDestination === "search");
  document.body.classList.toggle("saved-open", currentDestination === "bookmarks");
}

function rememberQuery(query) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return;
  // Search runs while typing, so "세", "세이", "세이버" are one search: keep only the longest.
  const sameSearch = (item) => item === trimmed || trimmed.startsWith(item) || item.startsWith(trimmed);
  const latest = recentQueries[0];
  const extendsLatest = latest && sameSearch(latest) && latest.length > trimmed.length;
  recentQueries = extendsLatest ? recentQueries
    : [trimmed, ...recentQueries.filter((item) => item !== trimmed && !(item === latest && sameSearch(item)))].slice(0, 5);
}

function appendHighlightedText(target, text, query) {
  const raw = String(text ?? "");
  const tokens = String(query ?? "").trim().split(/\s+/).filter(Boolean)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) {
    target.textContent = raw;
    return;
  }
  const pattern = new RegExp(`(${tokens.join("|")})`, "gi");
  let lastIndex = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match.index > lastIndex) target.append(raw.slice(lastIndex, match.index));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    target.append(mark);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < raw.length) target.append(raw.slice(lastIndex));
  if (!target.childNodes.length) target.textContent = raw;
}

function boardAllowedInFilter(board) {
  if (currentScope === "collections") {
    return collectionBoardIds ? collectionBoardIds.has(board.board_id) : true;
  }
  const mode = elements["mode-filter"].value;
  if (mode === "all" || !searchSupportsAa || board.is_aa == null) return true;
  return mode === "aa" ? board.is_aa === true : board.is_aa === false;
}

function populateBoardFilter() {
  const select = elements["board-filter"];
  const selected = select.value;
  select.replaceChildren(new Option("전체 게시판", ""));
  const groups = new Map();
  for (const board of boardById.values()) {
    if (!boardAllowedInFilter(board)) continue;
    const group = boardGroupLabel(board.group_name);
    const list = groups.get(group) ?? [];
    list.push(board);
    groups.set(group, list);
  }
  for (const [groupName, boards] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;
    for (const board of boards) {
      optgroup.append(new Option(boardDisplayName(board, board.board_id), board.board_id));
    }
    select.append(optgroup);
  }
  const kept = !selected || [...select.options].some((option) => option.value === selected);
  select.value = kept ? selected : "";
  return Boolean(selected) && !kept;
}

function applyBoardFilterOptions() {
  if (populateBoardFilter()) syncSearchRoute();
}

function applySettings() {
  const root = document.documentElement;
  const dark = settings.theme === "dark" ||
    (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--prose-size", `${settings.proseSize}px`);
  root.style.setProperty("--prose-line", settings.lineHeight);
  root.style.setProperty("--prose-width", `${settings.proseWidth}px`);
  root.style.setProperty("--prose-margin", `${settings.proseMargin}px`);
  root.style.setProperty("--prose-font", settings.proseFont === "sans" ? "var(--font-ui)" : "var(--font-reading)");
  root.style.setProperty("--aa-effective-size", `${settings.aaSize * settings.aaZoom}px`);
  root.style.setProperty("--aa-effective-line", `${settings.aaSize * 1.125 * settings.aaZoom}px`);
  root.style.setProperty("--aa-background", settings.aaBackground);
  root.style.setProperty("--aa-ink", readableAaInk(settings.aaBackground));
  elements["theme-toggle"].ariaLabel = dark ? "밝은 테마로 전환" : "어두운 테마로 전환";
  elements["theme-toggle"].title = elements["theme-toggle"].ariaLabel;
  for (const choice of elements["theme-choices"].querySelectorAll("[data-theme-choice]")) {
    choice.setAttribute("aria-checked", String(choice.dataset.themeChoice === settings.theme));
  }
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0b0d12" : "#ffffff";
  for (const [id, value, suffix] of [
    ["prose-size", settings.proseSize, "px"],
    ["line-height", settings.lineHeight, ""],
    ["prose-width", settings.proseWidth, "px"],
    ["prose-margin", settings.proseMargin, "px"],
    ["aa-size", settings.aaSize, "px"],
  ]) {
    elements[id].value = value;
    elements[`${id}-output`].value = `${value}${suffix}`;
  }
  elements["prose-font"].value = settings.proseFont;
  elements["aa-inline-size"].value = `${settings.aaSize}px`;
  elements["aa-zoom-output"].value = `${Math.round(settings.aaZoom * 100)}%`;
  elements["aa-background"].value = settings.aaBackground;
  elements["aa-source-styles"].textContent = settings.aaPreserveStyles ? "원본색" : "단색";
  elements["aa-source-styles"].setAttribute("aria-pressed", settings.aaPreserveStyles);
  for (const surface of document.querySelectorAll("#archive-body, .aa-comment")) {
    surface.classList.toggle("normalize-source-styles", !settings.aaPreserveStyles);
  }
  const canvas = elements["archive-body"].querySelector(".aa-canvas");
  if (canvas) canvas.dataset.width = settings.aaCanvasWidth ?? "auto";
  for (const button of document.querySelectorAll("[data-aa-preset]")) {
    const [size, width] = button.dataset.aaPreset.split(":");
    button.classList.toggle("active", settings.aaSize === Number(size) &&
      settings.aaCanvasWidth === (width === "auto" ? null : Number(width)) && settings.aaZoom === 1);
  }
  let backgroundPresetSelected = false;
  for (const button of document.querySelectorAll("[data-aa-background]")) {
    const selected = button.dataset.aaBackground === settings.aaBackground;
    button.classList.toggle("active", selected);
    backgroundPresetSelected ||= selected;
  }
  elements["aa-background"].closest(".aa-color-picker").classList.toggle("active", !backgroundPresetSelected);
  requestAnimationFrame(() => updateAaOverflowCue());
}

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [1, 1, 1];
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left, right) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function readableAaInk(background) {
  const darkContrast = contrastRatio(background, "#24252a");
  const greenContrast = contrastRatio(background, "#7be0a2");
  if (Math.max(darkContrast, greenContrast) >= 4.5) {
    return darkContrast >= greenContrast ? "#24252a" : "#7be0a2";
  }
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff") ? "#000000" : "#ffffff";
}

function showReaderFeedback(text, duration = 1200) {
  clearTimeout(zoomFeedbackTimer);
  elements["aa-zoom-indicator"].textContent = text;
  elements["aa-zoom-indicator"].hidden = false;
  zoomFeedbackTimer = setTimeout(() => { elements["aa-zoom-indicator"].hidden = true; }, duration);
}

function showZoomFeedback() {
  showReaderFeedback(`${Math.round(settings.aaZoom * 100)}%`);
}

function updateAaOverflowCue(showHint = false) {
  const body = elements["archive-body"];
  const overflow = currentMode === "aa" && body.scrollWidth > body.clientWidth + 1;
  const canScrollRight = overflow && body.scrollLeft < body.scrollWidth - body.clientWidth - 2;
  body.classList.toggle("aa-can-scroll", canScrollRight);
  if (showHint && overflow && !aaHintShown) {
    aaHintShown = true;
    showReaderFeedback("↔ 가로로 이동", 2200);
  }
}

function setAaZoom(value, debounce = false) {
  settings.aaZoom = Math.max(0.1, Math.min(3, value));
  applySettings();
  showZoomFeedback();
  clearTimeout(zoomPersistTimer);
  if (debounce) zoomPersistTimer = setTimeout(persistUserState, 250);
  else persistUserState();
}

function renderHomeList(element, posts, emptyText, limit = 6, listHint = "") {
  element.replaceChildren();
  if (!posts.length) {
    const empty = document.createElement("li");
    empty.className = "home-empty";
    empty.textContent = emptyText;
    element.append(empty);
    return;
  }
  for (const post of posts.slice(0, limit)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    button.type = "button";
    button.className = "home-item";
    title.textContent = post.title || "제목 없음";
    meta.textContent = [boardLabel(post.board_id), post.author, formatSourceDate(post.created_at_raw)].filter(Boolean).join(" · ");
    button.append(title, meta);
    button.addEventListener("click", () => loadPost(post, "push", { listHint }));
    item.append(button);
    element.append(item);
  }
}

function renderCover(
  title = "내 장서",
  description = "최근 게시된 글과 최근 기록을 확인하세요.",
  showContinue = true,
  actionLabel = "",
) {
  document.body.classList.remove("collection-detail-open");
  setReaderSource(null);
  elements["collection-view"].hidden = true;
  elements["empty-reader"].hidden = false;
  elements["home-title"].textContent = title;
  elements["empty-reader"].querySelector(".cover-copy").textContent = description;
  const published = publishedAt && !Number.isNaN(Date.parse(publishedAt))
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(publishedAt))
    : null;
  const newest = formatSourceDate(latestPosts[0]?.created_at_raw);
  elements["home-freshness"].textContent = published
    ? `마지막 보존 ${published}${newest ? ` · 최신 기록 ${newest}` : ""}`
    : "마지막 갱신 확인 중";
  elements["home-action"].hidden = !actionLabel;
  elements["home-action"].textContent = actionLabel;
  continueCollectionId = null;
  continueTargetPost = null;
  elements["continue-toc"].hidden = true;
  elements["continue-work"].hidden = true;
  elements["continue-block"].hidden = !showContinue;
  if (showContinue) void renderContinueCard();
  else elements["continue-block"].hidden = true;
  renderHomeList(elements["latest-list"], latestPosts, "최근 게시된 글이 없습니다.", 6);
  renderHomeList(elements["recent-list"], historyEntries.map((entry) => entry.summary), "아직 읽은 기록이 없습니다.", 4, "recent");
  void renderReadingWorks();
  updateShellMode();
}

function renderTextContinue(text) {
  continueText = text;
  continueTargetPost = null;
  continueCollectionId = null;
  elements["continue-block"].hidden = false;
  elements["continue-work"].hidden = !text.work;
  elements["continue-work"].textContent = text.work;
  elements["continue-title"].textContent = text.title || "텍스트 장서";
  const finished = postReadingState(text.progress) === "finished";
  elements["continue-meta"].textContent = [
    text.identity.startsWith("novel:") ? "소설" : "아카라이브",
    finished ? (text.identity.startsWith("novel:") ? "다 읽음 · 다음 화로 이어서" : "다 읽음") : postReadingLabel(text.progress, { seen: true }),
  ].filter(Boolean).join(" · ");
  elements["continue-toc"].hidden = !text.identity.startsWith("novel:");
}

async function renderContinueCard() {
  const latestEntry = historyEntries.find((entry) => entry.summary?.object_key);
  const text = textLibrary.latestReading();
  continueText = null;
  if (text && (!latestEntry || Date.parse(text.readAt) > Date.parse(latestEntry.readAt))) {
    if (currentDestination === "library") renderTextContinue(text);
    return;
  }
  if (!latestEntry) {
    elements["continue-block"].hidden = true;
    continueTargetPost = null;
    return;
  }
  let summary = latestEntry.summary;
  let progress = latestEntry.progress;
  let membership = null;
  try {
    membership = await findCollection(summary);
  } catch {
    membership = null;
  }
  if (postReadingState(progress) === "finished" && membership) {
    const target = collectionContinueTarget(membership.collection.entries, historyByIdentityMap());
    if (target.kind === "next" || target.kind === "resume") {
      summary = target.entry;
      progress = target.kind === "resume"
        ? historyByIdentityMap().get(postIdentity(target.entry))?.progress ?? 0
        : 0;
    } else {
      const fallback = historyEntries.find((entry) =>
        entry.summary?.object_key && postReadingState(entry.progress) !== "finished");
      if (!fallback) {
        elements["continue-block"].hidden = true;
        continueTargetPost = null;
        return;
      }
      summary = fallback.summary;
      progress = fallback.progress;
      try {
        membership = await findCollection(summary);
      } catch {
        membership = null;
      }
    }
  } else if (postReadingState(progress) === "finished") {
    const fallback = historyEntries.find((entry) =>
      entry.summary?.object_key && postReadingState(entry.progress) !== "finished");
    if (!fallback) {
      elements["continue-block"].hidden = true;
      continueTargetPost = null;
      return;
    }
    summary = fallback.summary;
    progress = fallback.progress;
  }
  if (currentDestination !== "library") return;
  continueTargetPost = summary;
  continueCollectionId = membership?.collection.id ?? null;
  elements["continue-block"].hidden = false;
  elements["continue-title"].textContent = summary.title || "제목 없음";
  elements["continue-meta"].textContent = [
    boardLabel(summary.board_id),
    summary.author,
    postReadingLabel(progress, { seen: true }) || "다음 편",
  ].filter(Boolean).join(" · ");
  if (membership) {
    const index = membership.collection.entries.findIndex((entry) => postIdentity(entry) === postIdentity(summary));
    elements["continue-work"].hidden = false;
    elements["continue-work"].textContent =
      `${membership.collection.title} · ${index >= 0 ? index + 1 : membership.index + 1}/${membership.collection.entries.length}편`;
    elements["continue-toc"].hidden = false;
  } else {
    elements["continue-work"].hidden = true;
    elements["continue-toc"].hidden = true;
  }
}

async function renderReadingWorks() {
  const section = elements["reading-works"];
  const list = elements["reading-works-list"];
  if (!section || !list || currentDestination !== "library") return;
  const items = [];
  let failedBoards = new Set();
  let typeMoonFailed = false;
  try {
    const index = await collectionIndex();
    const reading = await collectionReadingProgress(index);
    failedBoards = reading.failedBoards;
    collectionProgressFailedBoards = failedBoards;
    for (const collection of index.summaries) {
      if (failedBoards.has(collection.board_id)) continue;
      const state = reading.progress.get(collection.id);
      const occupancy = collectionOccupancy({
        availableCount: collectionAvailableCount(collection),
        finishedCount: state?.finished ?? 0,
        readingCount: state?.reading ?? 0,
      });
      if (occupancy !== "reading") continue;
      const copy = collectionRowCopy({
        entryCount: collection.entry_count,
        unavailableCount: collection.unavailable_count ?? 0,
        finishedCount: state?.finished ?? 0,
        readingCount: state?.reading ?? 0,
        continueTarget: null,
      });
      items.push({
        title: collection.title,
        meta: [boardLabel(collection.board_id), copy.progress, copy.action].filter(Boolean).join(" · "),
        readAt: state?.lastReadAt ?? "",
        open: () => void openCollectionDetail(collection.id),
      });
    }
  } catch {
    typeMoonFailed = true;
  }
  if (currentDestination !== "library") return;
  for (const work of textLibrary.readingWorks()) {
    items.push({
      title: work.title,
      meta: ["소설", work.meta].filter(Boolean).join(" · "),
      readAt: work.readAt,
      open: () => openTextFromHome({ identity: "novel:", listRoute: work.listRoute, progress: 0 }, { listOnly: true }),
    });
  }
  items.sort((left, right) => (Date.parse(right.readAt) || 0) - (Date.parse(left.readAt) || 0));
  const shown = items.slice(0, 3);
  section.hidden = shown.length === 0 && failedBoards.size === 0;
  list.replaceChildren();
  if ((failedBoards.size || typeMoonFailed) && shown.length === 0) {
    section.hidden = !failedBoards.size;
    const empty = document.createElement("li");
    empty.className = "home-empty";
    empty.textContent = "읽기 상태를 확인하지 못했습니다.";
    list.append(empty);
  }
  for (const item of shown) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "home-item";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.textContent = item.meta;
    button.append(title, meta);
    button.addEventListener("click", item.open);
    row.append(button);
    list.append(row);
  }
  if (failedBoards.size && shown.length) {
    const note = document.createElement("li");
    note.className = "home-empty";
    note.textContent = "일부 읽기 상태 미확인";
    list.append(note);
  }
}

function requireArchiveResponse(response, message) {
  if (
    response.status === 401 || response.status === 403 || response.redirected ||
    String(response.url ?? "").includes("/cdn-cgi/access/")
  ) {
    const error = new Error("Cloudflare Access session expired");
    error.code = "access_expired";
    throw error;
  }
  if (!response.ok) throw new Error(message);
}

async function responseJsonWithProgress(response, label) {
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (total <= 1_048_576 || !response.body) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    elements["archive-state"].textContent = `${label} ${Math.min(99, Math.floor(received / total * 100))}%`;
  }
  return JSON.parse(await new Blob(chunks, { type: "application/json" }).text());
}

function renderArchiveError(error, fallbackTitle = "아카이브를 열 수 없음") {
  const offline = error?.code === "offline" || !navigator.onLine;
  const expired = error?.code === "access_expired";
  const title = offline ? "오프라인입니다" : expired ? "로그인이 만료되었습니다" : fallbackTitle;
  const message = offline
    ? "네트워크 연결을 확인한 뒤 다시 시도하세요."
    : expired ? "보호된 장서를 계속 보려면 다시 로그인하세요." : error?.message ?? "알 수 없는 오류";
  elements["archive-state"].textContent = offline ? "오프라인" : expired ? "로그인 필요" : "연결 오류";
  elements["result-status"].textContent = message;
  elements["result-more"].hidden = true;
  renderCover(title, message, false, expired ? "다시 로그인" : "다시 시도");
}

function openMobileReader() {
  document.body.classList.add("reader-open");
  updateShellMode();
}

function closeMobileReader(focusSearch = false) {
  document.body.classList.remove("reader-open");
  document.body.classList.remove("collection-detail-open");
  document.body.classList.remove("reader-controls-hidden");
  updateShellMode();
  if (focusSearch && currentDestination === "search") elements["search-input"].focus({ preventScroll: true });
}

// ---- Shared Reader shell -------------------------------------------------------------------
// TypeMoon posts and text-archive chapters render into the same Reader DOM. The shell owns
// visibility, navigation labels, the chapter-end card, and bookmark state; each source owns
// its data and decides what "previous", "next", "list", and "toc" mean.

function setReaderSource(source) {
  readerSource = source;
  elements.reader.hidden = !source;
  elements.reader.dataset.source = source ?? "";
  document.body.classList.toggle("reader-active", Boolean(source));
  if (!source) {
    readerNavigation = null;
    listContext = null;
    renderReaderList(null);
    elements["reader-more"].open && elements["reader-more"].close();
    return;
  }
  elements["empty-reader"].hidden = true;
  elements["collection-view"].hidden = true;
  document.body.classList.remove("collection-detail-open");
  const text = source === "text";
  elements.comments.hidden = text;
  elements["mode-toggle"].hidden = text;
  if (text) {
    elements["mode-reset"].hidden = true;
    elements["aa-controls"].hidden = true;
  }
}

function openTextReader({ kicker, title, meta, text, sourceUrl }) {
  cancelReaderSelection();
  if (currentSummary) persistReadingPosition();
  currentSummary = null;
  currentPayload = null;
  currentCollection = null;
  currentMode = "prose";
  const continuing = readerSource === "text";
  setReaderSource("text");
  resetReaderChrome();
  if (!continuing) collapseCatalogForReading();
  elements["reader-kicker"].textContent = kicker;
  elements["reader-title"].textContent = title;
  elements["reader-meta"].textContent = meta;
  elements["collection-context"].hidden = true;
  setSourceLink(sourceUrl);
  document.title = `${title} — ReDSTM`;
  const body = elements["archive-body"];
  body.classList.remove("aa", "normalize-source-styles");
  body.classList.add("plain-text");
  body.ariaLabel = "텍스트 본문";
  renderPlainTextWithMedia(body, text, { sourceUrl });
  const renderId = String(++textRenderId);
  body.dataset.renderId = renderId;
  void archiveTextMedia(body, renderId);
  openMobileReader();
  updateShellMode();
  requestAnimationFrame(() => elements["reader-title"].focus({ preventScroll: true }));
}

// Arcalive images: show the copies Newtomi archived (docs/20). A failed lookup leaves the body
// as rendered (live signed links load; expired ones point at the source post).
async function archiveTextMedia(body, renderId) {
  const paths = arcaPaths(body);
  // The Worker checks each path with one R2 call, so a request carries at most 40.
  for (let start = 0; start < paths.length; start += 40) {
    let media;
    try {
      const response = await fetch("/api/v1/text/media/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: paths.slice(start, start + 40) }),
      });
      if (!response.ok) return;
      media = (await response.json()).media ?? {};
    } catch {
      return;
    }
    if (body.dataset.renderId !== renderId) return;
    applyArchivedMedia(body, media);
  }
}

function closeTextReader() {
  if (readerSource !== "text") return;
  setReaderSource(null);
  // Back at the list: the collapsed side list opens again, as it does for TypeMoon.
  document.body.classList.remove("reader-open", "reader-controls-hidden", "catalog-collapsed");
  elements["catalog-toggle"].setAttribute("aria-expanded", "true");
  setImmersive(false, false);
  updateShellMode();
}

// App-driven scrolls (restoring a position) are not reading gestures; keep them from hiding tools.
function syncScrollBaseline() {
  lastReaderScroll = elements["reader-pane"].scrollTop;
  readerScrollDelta = 0;
}

// Mid-width screens give the Reader the whole width when reading starts; the side list stays one
// tap away. Moving to another chapter keeps whatever the reader chose (an opened side list stays).
function collapseCatalogForReading() {
  const collapse = matchMedia("(min-width: 760px) and (max-width: 899px)").matches;
  document.body.classList.toggle("catalog-collapsed", collapse);
  elements["catalog-toggle"].setAttribute("aria-expanded", String(!collapse));
}

function resetReaderChrome() {
  elements["reading-progress"].style.width = "0%";
  lastReaderScroll = 0;
  readerScrollDelta = 0;
  document.body.classList.remove("reader-controls-hidden");
}

function setSourceLink(url) {
  const safe = typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
  for (const link of [elements["source-link"], elements["more-source"]]) {
    link.hidden = !safe;
    if (safe) link.href = safe;
    else link.removeAttribute("href");
  }
}

// Sticky chrome (mobile context bar, desktop toolbar) covering the top of the scrollport.
function readerTopInset() {
  const paneTop = elements["reader-pane"].getBoundingClientRect().top;
  let inset = 0;
  for (const chrome of [document.getElementById("reader-topbar"), document.querySelector(".reader-toolbar")]) {
    const rect = chrome.getBoundingClientRect();
    if (rect.height && rect.top <= paneTop + 1 && rect.bottom > paneTop) inset = Math.max(inset, rect.bottom - paneTop);
  }
  return inset;
}

// Progress through the body itself, so long comment threads below do not hold "finished" back.
function bodyProgress() {
  const pane = elements["reader-pane"];
  const body = elements["archive-body"];
  const span = body.offsetTop + body.offsetHeight - pane.clientHeight;
  if (span > 0) return Math.min(1, Math.max(0, pane.scrollTop / span));
  const maximum = pane.scrollHeight - pane.clientHeight;
  return maximum > 0 ? Math.min(1, pane.scrollTop / maximum) : 0;
}

function subjectParticle(word) {
  const code = String(word).trim().at(-1)?.charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 === 0 ? "가" : "이";
}

// nav: { unit, qualifier, previous, next, note, endFallback, hasToc, context, pending }
function renderReaderNavigation(nav) {
  readerNavigation = nav;
  const unit = nav.unit ?? "글";
  const qualifier = nav.qualifier ? ` · ${nav.qualifier}` : "";
  const previousLabel = `이전 ${unit}`;
  const nextLabel = `다음 ${unit}`;
  for (const [button, label, target] of [
    [elements["previous-post"], previousLabel, nav.previous],
    [elements["reader-bottom-previous"], previousLabel, nav.previous],
    [elements["next-post"], nextLabel, nav.next],
    [elements["reader-bottom-next"], nextLabel, nav.next],
  ]) {
    button.disabled = Boolean(nav.pending) || !target;
    button.title = `${label}${qualifier}`;
    button.ariaLabel = target?.title ? `${label}${qualifier}: ${target.title}` : `${label}${qualifier}`;
  }
  elements["previous-post-label"].textContent = previousLabel;
  elements["next-post-label"].textContent = nextLabel;
  elements["reader-bottom-previous-label"].textContent = previousLabel;
  elements["reader-bottom-next-label"].textContent = nextLabel;

  const endNext = elements["end-next"];
  endNext.hidden = false;
  if (nav.next) {
    elements["end-next-kicker"].textContent = `${nextLabel}${qualifier}`;
    elements["end-next-title"].textContent = nav.next.title || `${nextLabel} 열기`;
    endNext.disabled = Boolean(nav.pending);
    endNext.dataset.action = "next";
  } else if (nav.endFallback) {
    elements["end-next-kicker"].textContent = nav.endFallback.kicker;
    elements["end-next-title"].textContent = nav.endFallback.label;
    endNext.disabled = false;
    endNext.dataset.action = nav.endFallback.action;
  } else {
    elements["end-next-kicker"].textContent = `${nextLabel}${qualifier}`;
    elements["end-next-title"].textContent = nav.pending ? "순서 확인 중…" : `${nextLabel}${subjectParticle(nextLabel)} 없습니다`;
    endNext.disabled = true;
    endNext.dataset.action = "";
    endNext.hidden = !nav.pending;
  }
  elements["end-previous"].hidden = !nav.previous;
  elements["end-previous-kicker"].textContent = `${previousLabel}${qualifier}`;
  elements["end-previous-title"].textContent = nav.previous?.title || "";
  elements["end-toc"].hidden = !nav.hasToc;
  elements["more-toc"].hidden = !nav.hasToc;
  elements["chapter-end-note"].textContent = nav.note ?? "";
  elements["chapter-end-note"].hidden = !nav.note;
  elements["reader-topbar-title"].textContent = nav.context ?? "";
  schedulePrefetch(nav.next?.prefetch);
  elements["reader-more-context"].textContent = nav.context ?? "";
}

// Warm the browser cache for the next episode (archive objects are immutable). Skipped on
// data saver; one request per target per session, after the current page has settled.
function schedulePrefetch(url) {
  if (!url || prefetched.has(url) || navigator.connection?.saveData) return;
  const run = () => {
    if (prefetched.has(url) || !readerSource) return;
    prefetched.add(url);
    // Same request shape as the Reader's own fetch, so the browser cache can answer it.
    fetch(url, { priority: "low" }).catch(() => prefetched.delete(url));
  };
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

function renderBookmarkState(active, { notes = false } = {}) {
  const label = active ? "저장 취소" : "저장";
  for (const button of [elements["bookmark-post"], elements["reader-top-bookmark"], elements["more-bookmark"]]) {
    button.setAttribute("aria-pressed", String(active));
    button.ariaLabel = label;
    button.title = label;
  }
  elements["more-bookmark-label"].textContent = active ? "저장됨 · 취소" : "저장";
  elements["more-note"].hidden = !notes;
}

function readerCommand(name) {
  if (!readerSource) return;
  if (name === "settings") return openSettings();
  if (name === "more") return openReaderMore();
  if (readerSource === "text") return textLibrary.command(name);
  if (name === "previous") return typeMoonStep(-1);
  if (name === "next") return typeMoonStep(1);
  if (name === "end-next") {
    const action = elements["end-next"].dataset.action;
    if (action === "next") return typeMoonStep(1, { finished: true });
    if (action === "toc") return openCurrentToc();
    if (action === "list") return returnToList();
    return;
  }
  if (name === "list") return returnToList();
  if (name === "toc") return openCurrentToc();
  if (name === "bookmark") return toggleTypeMoonBookmark();
}

function openReaderMore() {
  const typeMoon = readerSource === "typemoon";
  elements["more-mode"].hidden = !typeMoon;
  elements["more-mode-reset"].hidden = !typeMoon || elements["mode-reset"].hidden;
  elements["more-mode-label"].textContent = elements["mode-toggle"].textContent;
  elements["more-immersive-label"].textContent = document.body.classList.contains("immersive") ? "집중 종료" : "집중 모드";
  const percent = Math.round(bodyProgress() * 100);
  elements["more-position"].value = String(percent);
  elements["more-position-output"].value = `${percent}%`;
  if (!elements["reader-more"].open) {
    moreOpener = document.activeElement;
    elements["reader-more"].showModal();
  }
}

function closeReaderMore() {
  if (elements["reader-more"].open) elements["reader-more"].close();
}

function updateDestinationButtons() {
  for (const button of document.querySelectorAll("[data-destination]")) {
    const active = button.dataset.destination === currentDestination;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
  }
}

function setScope(scope) {
  currentScope = scope === "collections" ? "collections" : "posts";
  document.body.classList.toggle("collection-scope", currentScope === "collections");
  for (const button of document.querySelectorAll("[data-scope]")) {
    const active = button.dataset.scope === currentScope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
  }
  const collectionScope = currentScope === "collections";
  const previousSort = elements["sort-filter"].value;
  const options = collectionScope
    ? [["최근 글순", "updated"], ["가나다순", "title"], ["편수 많은순", "longest"]]
    : [["최신순", "latest"], ["오래된순", "oldest"]];
  elements["sort-filter"].replaceChildren(...options.map(([label, value]) => new Option(label, value)));
  elements["sort-filter"].value = collectionScope
    ? (["title", "updated", "longest"].includes(previousSort) ? previousSort : "updated")
    : (["latest", "oldest"].includes(previousSort) ? previousSort : "latest");
  document.querySelector(".search-target-field").hidden = collectionScope;
  document.querySelector(".search-match-field").hidden = collectionScope;
  document.querySelector(".collection-read-field").hidden = !collectionScope;
  elements["search-input"].placeholder = collectionScope ? "작품 제목 검색" : "제목, 작성자, 분류 검색";
}

function currentSearchState() {
  return {
    query: elements["search-input"].value,
    boardId: elements["board-filter"].value,
    mode: elements["mode-filter"].value,
    sort: elements["sort-filter"].value,
    target: elements["search-target"].value,
    match: elements["search-match"].value,
    collectionKind: elements["collection-kind-filter"].value,
    collectionRead: elements["collection-read-filter"].value,
  };
}

function searchUrl(state = currentSearchState(), destination = currentDestination) {
  const params = new URLSearchParams();
  if (currentScope === "collections") params.set("scope", "collections");
  if (state.query) params.set("q", state.query);
  if (state.boardId) params.set("board", state.boardId);
  if (currentScope === "posts" && state.mode !== "all") params.set("mode", state.mode);
  if (currentScope === "posts" && state.target !== "all") params.set("target", state.target);
  if (currentScope === "posts" && state.match !== "and") params.set("match", state.match);
  if (currentScope === "collections" && state.collectionKind !== "all") params.set("kind", state.collectionKind);
  if (currentScope === "collections" && state.collectionRead !== "all") params.set("read", state.collectionRead);
  const defaultSort = currentScope === "collections" ? "updated" : "latest";
  if (state.sort !== defaultSort) params.set("sort", state.sort);
  const query = params.toString();
  const path = destination === "browse" ? "/browse" : "/search";
  return query ? `${path}?${query}` : path;
}

function savedUrl(state = currentSearchState(), view = currentView) {
  const params = new URLSearchParams();
  if (view === "history") params.set("view", "recent");
  if (view === "reading") params.set("view", "reading");
  if (state.query) params.set("q", state.query);
  const query = params.toString();
  return query ? `/saved?${query}` : "/saved";
}

function applyCatalogRoute(destination) {
  const params = new URLSearchParams(location.search);
  setScope(params.get("scope") === "collections" || location.pathname.startsWith("/collections")
    ? "collections" : "posts");
  elements["search-input"].value = params.get("q") ?? "";
  elements["board-filter"].value = params.get("board") ?? "";
  const mode = params.get("mode");
  elements["mode-filter"].value = searchSupportsAa && (mode === "aa" || mode === "prose") ? mode : "all";
  elements["search-target"].value = ["title", "author"].includes(params.get("target")) ? params.get("target") : "all";
  elements["search-match"].value = params.get("match") === "or" ? "or" : "and";
  const sort = params.get("sort");
  elements["sort-filter"].value = currentScope === "collections"
    ? (["title", "longest"].includes(sort) ? sort : "updated")
    : (sort === "oldest" ? "oldest" : "latest");
  elements["collection-kind-filter"].value = ["series", "oneshot"].includes(params.get("kind")) ? params.get("kind") : "all";
  elements["collection-read-filter"].value = ["unread", "reading", "finished"].includes(params.get("read")) ? params.get("read") : "all";
  if (destination === "bookmarks") {
    elements["board-filter"].value = "";
    elements["mode-filter"].value = "all";
    elements["search-target"].value = "all";
    elements["search-match"].value = "and";
    elements["collection-kind-filter"].value = "all";
    elements["collection-read-filter"].value = "all";
  }
  currentView = destination === "bookmarks" && params.get("view") === "recent" ? "history" :
    destination === "bookmarks" && params.get("view") === "reading" ? "reading" :
    destination === "bookmarks" ? "bookmarks" : "all";
}

function syncSearchRoute() {
  const state = currentSearchState();
  if (["/browse", "/search", "/collections"].includes(location.pathname)) {
    history.replaceState({ redstmSearch: state }, "", searchUrl(state));
  } else if (location.pathname === "/saved") {
    history.replaceState({ redstmSaved: { ...state, view: currentView } }, "", savedUrl(state));
  }
}

function applyTextSortOptions() {
  if (currentDestination !== "text") return;
  const sortOptions = textLibrary.sortOptions();
  const options = sortOptions.length ? sortOptions : [["가나다순", "title"]];
  const select = elements["sort-filter"];
  const wanted = textLibrary.currentSort();
  const allowed = new Set(options.map(([, value]) => value));
  select.replaceChildren(...options.map(([label, value]) => new Option(label, value)));
  // The text library owns its sort (it travels in the URL); the select only mirrors it.
  select.value = allowed.has(wanted) ? wanted : options[0][1];
  textLibrary.setSort(select.value);
  // The select is hidden in the text library; these chips are its visible control.
  const chips = elements["text-sort-chips"];
  chips.hidden = sortOptions.length < 2;
  chips.replaceChildren(...sortOptions.map(([label, value]) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.textSort = value;
    chip.textContent = label;
    chip.setAttribute("aria-pressed", String(value === select.value));
    return chip;
  }));
  elements["search-input"].placeholder = textLibrary.searchPlaceholder();
}

function updateDestinationLayout() {
  const browsing = currentDestination === "browse";
  const searching = currentDestination === "search";
  const saved = currentDestination === "bookmarks";
  const text = currentDestination === "text";
  const collections = currentScope === "collections";
  updateShellMode();
  elements["scope-tabs"].hidden = !browsing && !searching;
  elements["text-lanes"].hidden = !text;
  document.querySelector(".saved-tabs").hidden = !saved;
  elements["catalog-search-row"].hidden = !searching && !saved && !text;
  elements["catalog-toolbar"].hidden = saved && currentView !== "all";
  elements["mode-chips"].hidden = saved || collections || searching || text;
  elements["kind-chips"].hidden = saved || !collections || searching;
  document.querySelector(".sort-field").hidden = saved;
  elements["mode-filter"].closest("label").hidden = !searching || collections;
  document.querySelector(".search-target-field").hidden = !searching || collections;
  document.querySelector(".search-match-field").hidden = !searching || collections;
  document.querySelector(".collection-kind-field").hidden = !searching || !collections;
  document.querySelector(".collection-read-field").hidden = saved || !collections;
  // The board lives in its own picker (board dock); the select only carries the value.
  document.querySelector(".board-field").hidden = true;
  elements["board-dock"].hidden = !browsing && !searching;
  elements["search-input"].placeholder = saved ? "제목, 메모, 태그 검색"
    : text ? textLibrary.searchPlaceholder()
    : collections ? "작품 제목 검색" : "제목, 작성자, 분류 검색";
  elements["catalog-title"].textContent = saved ? "내 보관함"
    : text ? "텍스트 장서"
    : collections ? (browsing ? "작품 둘러보기" : "작품 검색")
    : browsing ? "게시판 둘러보기" : "글 검색";
  elements["catalog-subtitle"].textContent = saved
    ? (currentView === "history" ? "최근 읽음" : currentView === "reading" ? "읽는 중" : "저장한 글")
    : text ? "소설 · 아카라이브"
    : collections ? "연재·번역·AA 목차"
    : browsing ? "게시판별 보존 글" : "제목·작성자·분류로 찾기";
  applyBoardFilterOptions();
  renderBoardDock();
  syncFilterChips();
  renderActiveFilters();
  elements["search-clear"].hidden = !elements["search-input"].value;
  elements["filter-toggle"].hidden = saved || text || (browsing && !isNarrowScreen());
  if (text) applyTextSortOptions();
}

function syncFilterChips() {
  for (const button of elements["mode-chips"].querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", button.dataset.mode === elements["mode-filter"].value);
    button.disabled = button.dataset.mode !== "all" && !searchSupportsAa;
  }
  for (const button of elements["kind-chips"].querySelectorAll("[data-kind]")) {
    button.setAttribute("aria-pressed", button.dataset.kind === elements["collection-kind-filter"].value);
  }
}

function activeFilterItems() {
  const items = [];
  const state = currentSearchState();
  if (state.boardId) items.push({ key: "board", label: boardLabel(state.boardId) });
  if (currentScope === "posts" && state.mode !== "all") {
    items.push({ key: "mode", label: state.mode === "aa" ? "AA" : "소설·일반" });
  }
  if (currentDestination === "search" && currentScope === "posts" && state.target !== "all") {
    items.push({ key: "target", label: state.target === "title" ? "제목만" : "작성자만" });
  }
  if (currentDestination === "search" && currentScope === "posts" && state.match !== "and") {
    items.push({ key: "match", label: "하나라도" });
  }
  if (currentScope === "collections" && state.collectionKind !== "all") {
    items.push({ key: "kind", label: state.collectionKind === "oneshot" ? "단편 묶음" : "연재" });
  }
  if (currentScope === "collections" && state.collectionRead !== "all") {
    items.push({
      key: "read",
      label: state.collectionRead === "unread" ? "안 읽음" : state.collectionRead === "reading" ? "읽는 중" : "다 읽음",
    });
  }
  return items;
}

function sheetFilterItems() {
  const items = activeFilterItems().filter((item) => item.key !== "board");
  if (currentDestination !== "browse") return items;
  return items.filter((item) => item.key !== "mode" && item.key !== "kind");
}

function navigatorBoards() {
  return [...boardById.values()]
    .filter((board) => currentScope !== "collections" || !collectionBoardIds || collectionBoardIds.has(board.board_id))
    .map((board) => ({
      id: board.board_id,
      name: boardDisplayName(board, board.board_id),
      group: boardGroupLabel(board.group_name),
      count: currentScope === "collections" ? undefined : board.post_count,
    }));
}

function renderBoardDock() {
  const boardId = elements["board-filter"].value;
  const board = boardById.get(boardId);
  elements["board-dock-group"].textContent = board ? boardGroupLabel(board.group_name) : "게시판";
  elements["board-dock-name"].textContent = board ? boardLabel(boardId) : "전체 게시판";
  elements["board-dock-button"].ariaLabel = `게시판 선택, 현재 ${board ? boardLabel(boardId) : "전체 게시판"}`;
  elements["board-dock-clear"].hidden = !boardId;
  elements["board-dock"].classList.toggle("selected", Boolean(boardId));
}

// Choosing a board shows that whole board: a format filter that would hide it is cleared.
function selectBoard(boardId) {
  const board = boardById.get(boardId);
  const mode = elements["mode-filter"].value;
  if (board && currentScope === "posts" && mode !== "all" && searchSupportsAa && board.is_aa != null &&
      (mode === "aa") !== board.is_aa) {
    elements["mode-filter"].value = "all";
    catalogNote = "형식 조건을 전체로 바꿨습니다";
    populateBoardFilter();
  }
  elements["board-filter"].value = boardId;
  syncSearchRoute();
  updateDestinationLayout();
  renderCurrentView();
  elements["result-list"].scrollTop = 0;
  elements["board-dock-button"].focus({ preventScroll: true });
}

function renderActiveFilters() {
  const sheetItems = sheetFilterItems();
  elements["filter-toggle"].textContent = sheetItems.length ? `필터 ${sheetItems.length}` : "필터";
  const shown = currentDestination === "browse" && !isNarrowScreen() ? [] : sheetItems;
  elements["active-filters"].hidden = !shown.length;
  elements["active-filters"].replaceChildren();
  for (const item of shown) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.clear = item.key;
    button.textContent = `${item.label} ×`;
    elements["active-filters"].append(button);
  }
}

function clearFilter(key) {
  if (key === "board") elements["board-filter"].value = "";
  if (key === "mode") elements["mode-filter"].value = "all";
  if (key === "target") elements["search-target"].value = "all";
  if (key === "match") elements["search-match"].value = "and";
  if (key === "kind") elements["collection-kind-filter"].value = "all";
  if (key === "read") elements["collection-read-filter"].value = "all";
  syncSearchRoute();
  updateDestinationLayout();
  renderCurrentView();
}

function resetFilters() {
  elements["board-filter"].value = "";
  resetSheetFilterValues();
  syncSearchRoute();
  updateDestinationLayout();
  renderCurrentView();
}

function restoreCatalogControls() {
  const host = document.querySelector(".catalog-inner") || document.querySelector(".catalog");
  if (elements["catalog-controls"].parentElement !== host) {
    elements["result-status"].before(elements["catalog-controls"]);
  }
}

const sheetFilterIds = ["mode-filter", "search-target", "search-match", "collection-kind-filter", "collection-read-filter", "sort-filter"];

function resetSheetFilterValues() {
  elements["mode-filter"].value = "all";
  elements["search-target"].value = "all";
  elements["search-match"].value = "and";
  elements["collection-kind-filter"].value = "all";
  elements["collection-read-filter"].value = "all";
  elements["sort-filter"].value = currentScope === "collections" ? "updated" : "latest";
}

function openFilterSheet() {
  const dialog = elements["filter-dialog"];
  if (isNarrowScreen()) {
    filterOpener = document.activeElement;
    filterDraft = Object.fromEntries(sheetFilterIds.map((id) => [id, elements[id].value]));
    elements["filter-dialog-fields"].append(elements["catalog-controls"]);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => dialog.querySelector("h2")?.focus());
  } else {
    document.body.classList.toggle("filters-expanded");
    elements["filter-toggle"].setAttribute("aria-pressed", document.body.classList.contains("filters-expanded"));
  }
}

function applyFilterSheet() {
  filterDraft = null;
  closeFilterSheet();
  syncSearchRoute();
  updateDestinationLayout();
  renderCurrentView();
}

function closeFilterSheet() {
  restoreCatalogControls();
  if (elements["filter-dialog"].open) elements["filter-dialog"].close();
  const opener = filterOpener;
  filterOpener = null;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

function openSettings() {
  if (!elements["settings-dialog"].open) elements["settings-dialog"].showModal();
  elements["settings-dialog"].querySelector("form").scrollTop = 0;
}

function persistCatalogState() {
  if (!elements["collection-view"].hidden) return;
  const search = currentSearchState();
  if (currentDestination === "bookmarks") search.sort = "latest";
  const focused = document.activeElement?.closest?.(".result-item");
  const anchor = captureListAnchor(elements["result-list"], ".result-item[data-key]");
  userState.lastCatalogState = {
    destination: currentDestination,
    view: currentView,
    scope: currentScope,
    ...search,
    scrollTop: elements["result-list"].scrollTop,
    anchorKey: anchor?.key ?? null,
    anchorOffset: anchor?.offset ?? 0,
    loadedCount: currentScope === "collections" ? renderedCollections.length : renderedResults.length,
    focusedPost: focused?.dataset.index ? postIdentity(renderedResults[Number(focused.dataset.index)]) : "",
    focusedCollectionId: Number(focused?.dataset.collectionId) || null,
    recentQueries,
  };
  pendingCatalogRestore = userState.lastCatalogState;
  persistUserState();
}

function restoreCatalogPosition() {
  const state = pendingCatalogRestore;
  if (currentSummary || !state || state.destination !== currentDestination || state.view !== currentView ||
      (state.scope ?? "posts") !== currentScope) return;
  const current = currentSearchState();
  if (state.query !== current.query || state.boardId !== current.boardId ||
      (state.mode ?? "all") !== current.mode ||
      (state.target ?? "all") !== current.target ||
      (state.match ?? "and") !== current.match ||
      (state.collectionKind ?? "all") !== current.collectionKind ||
      (state.collectionRead ?? "all") !== current.collectionRead ||
      (currentDestination !== "bookmarks" && state.sort !== current.sort)) return;
  requestAnimationFrame(() => {
    const list = elements["result-list"];
    list.scrollTop = Math.max(0, state.scrollTop ?? 0);
    const collections = currentScope === "collections";
    const rendered = collections ? renderedCollections : renderedResults;
    const index = collections
      ? renderedCollections.findIndex((collection) => collection.id === state.focusedCollectionId)
      : renderedResults.findIndex((post) => postIdentity(post) === state.focusedPost);
    const targetLoaded = Math.min(Number(state.loadedCount) || 0, resultTotal);
    if (currentView === "all" && rendered.length < targetLoaded) {
      if (collections) void renderCollectionCatalog(rendered.length);
      else requestSearch(rendered.length);
      return;
    }
    pendingCatalogRestore = null;
    // Rows above the anchor can change height after reading (new badges), so align the row
    // that was at the top instead of trusting the old pixel offset.
    if (state.anchorKey) {
      restoreListAnchor(list, { key: state.anchorKey, offset: state.anchorOffset, scrollTop: state.scrollTop },
        ".result-item[data-key]");
    }
    if (index >= 0) {
      const selector = collections ? `[data-collection-id="${state.focusedCollectionId}"]` : `[data-index="${index}"]`;
      list.querySelector(selector)?.focus({ preventScroll: true });
    }
  });
}

function cancelReaderSelection() {
  readerViewId += 1;
  postController?.abort();
}

function showDestination(destination, navigate = true, view = destination === "bookmarks" ? "bookmarks" : "all") {
  if (destination === "settings") {
    openSettings();
    document.title = "읽기 설정 — ReDSTM";
    if (navigate && location.pathname !== "/settings") {
      history.pushState({ redstmSettings: true }, "", "/settings");
    }
    return;
  }
  const wasText = currentDestination === "text";
  if (wasText && destination !== "text") textLibrary.leave();
  cancelReaderSelection();
  if (currentSummary) persistReadingPosition();
  else if (currentDestination !== "library") persistCatalogState();
  setImmersive(false, false);
  const leavingCatalog = ["browse", "search"].includes(currentDestination);
  if (!["browse", "search"].includes(destination)) setScope("posts");
  if (destination === "bookmarks" && leavingCatalog) {
    elements["board-filter"].value = "";
    elements["mode-filter"].value = "all";
    elements["search-target"].value = "all";
    elements["search-match"].value = "and";
    elements["collection-kind-filter"].value = "all";
    elements["collection-read-filter"].value = "all";
    elements["search-input"].value = "";
  }
  currentDestination = destination;
  currentView = view;
  const catalogLabel = currentScope === "collections" ? "작품" : "글";
  document.title = `${destination === "library" ? "홈" : destination === "browse" ? `${catalogLabel} 둘러보기` : destination === "search" ? `${catalogLabel} 검색` : destination === "text" ? "텍스트 장서" : "내 보관함"} — ReDSTM`;
  currentSummary = null;
  currentPayload = null;
  document.body.classList.remove("catalog-collapsed", "reader-controls-hidden");
  elements["catalog-toggle"].setAttribute("aria-expanded", "true");
  document.body.classList.toggle("text-library-open", destination === "text");
  if (destination !== "text") elements["text-sort-chips"].hidden = true;
  updateDestinationLayout();
  if (destination === "library") renderCover();
  else {
    setReaderSource(null);
    elements["collection-view"].hidden = true;
    elements["empty-reader"].hidden = true;
    document.body.classList.remove("collection-detail-open");
  }
  // Only an explicit trip to Search raises the keyboard; Back into search results must not.
  closeMobileReader(destination === "search" && navigate);
  if (destination === "text") {
    const params = navigate && !wasText ? new URLSearchParams() : new URLSearchParams(location.search);
    void textLibrary.open(params);
  } else if (destination === "bookmarks") {
    updateTabs();
    renderCurrentView();
  } else {
    currentView = "all";
    updateTabs();
    if (currentScope === "collections") void renderCollectionCatalog();
    else requestSearch();
  }
  if (destination !== "text" && deferredArchiveError) {
    const error = deferredArchiveError;
    deferredArchiveError = null;
    renderArchiveError(error);
  }
  updateDestinationButtons();
  const path = destination === "library" ? "/" : destination === "text" ? textLibrary.currentRoute() : destination === "bookmarks" ? savedUrl() : searchUrl();
  if (navigate && `${location.pathname}${location.search}` !== path) {
    const state = destination === "search" ? { redstmSearch: currentSearchState() } :
      destination === "bookmarks" ? { redstmSaved: { ...currentSearchState(), view: currentView } } : null;
    history.pushState(state, "", path);
  }
}

function setImmersive(active, restoreFocus = true) {
  const wasActive = document.body.classList.contains("immersive");
  if (active && !wasActive) immersiveOpener = document.activeElement;
  document.body.classList.toggle("immersive", active);
  elements["immersive-exit"].hidden = !active;
  elements["immersive-toggle"].setAttribute("aria-pressed", active);
  elements["immersive-toggle"].textContent = active ? "집중 종료" : "집중";
  if (active) requestAnimationFrame(() => elements["immersive-exit"].focus());
  else if (wasActive) {
    const opener = immersiveOpener;
    immersiveOpener = null;
    if (restoreFocus) requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
  }
}

function resolvePosts(summaries) {
  const identities = summaries.map(postIdentity).filter(Boolean);
  if (!identities.length) return Promise.resolve([]);
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    searchWorker.postMessage({ type: "resolve", id, identities });
  });
}

async function hydrateSavedEntries() {
  for (const entries of [historyEntries, bookmarks]) {
    for (let start = 0; start < entries.length; start += 500) {
      const chunk = entries.slice(start, start + 500);
      const summaries = await resolvePosts(chunk.map((entry) => entry.summary));
      summaries.forEach((summary, index) => {
        if (summary) chunk[index].summary = summary;
      });
    }
  }
}

function routeSummary() {
  const route = /^\/read\/([a-z0-9_]+)\/([1-9]\d*)\/?$/.exec(location.pathname);
  if (route) return { board_id: route[1], external_post_id: Number(route[2]) };
  try {
    const legacy = postObjectKeyPattern.exec(decodeURIComponent(location.hash.slice(1)));
    return legacy ? { board_id: legacy[1], external_post_id: Number(legacy[2]) } : null;
  } catch {
    return null;
  }
}

function routeCollectionId() {
  const route = /^\/collections\/([1-9]\d*)\/?$/.exec(location.pathname);
  return route ? Number(route[1]) : null;
}

function currentRoute() {
  return `${location.pathname}${location.search}`;
}

// A Reader, work table of contents, or text chapter opened straight from a link has no list
// under it. Build that parent once, so the first Back lands on a list instead of leaving the app.
function synthesizeParentEntry() {
  if (history.state?.redstmParent || history.state?.redstmSynthetic) return;
  const summary = routeSummary();
  const collectionId = routeCollectionId();
  let parent = null;
  let state = null;
  if (summary) {
    parent = `/browse?board=${encodeURIComponent(summary.board_id)}`;
    state = { redstmReader: true };
  } else if (collectionId !== null) {
    parent = "/browse?scope=collections";
    state = { redstmCollection: true };
  } else if (location.pathname === "/text") {
    parent = textLibrary.parentRoute(new URLSearchParams(location.search));
    state = { redstmText: true, redstmReader: true };
  }
  if (!parent) return;
  const target = `${currentRoute()}${location.hash}`;
  history.replaceState({ redstmSynthetic: true }, "", parent);
  history.pushState({ ...state, redstmParent: parent, redstmSyntheticParent: true }, "", target);
}

// Back from a Reader: return to the list that opened it when this session owns that entry,
// otherwise replace the Reader in place with its destination list.
function returnToList() {
  if (history.state?.redstmParent) {
    history.back();
    return;
  }
  const destination = currentDestination;
  const view = currentView;
  const path = destination === "library" ? "/" : destination === "text" ? textLibrary.currentRoute() : destination === "bookmarks" ? savedUrl() : searchUrl();
  history.replaceState(null, "", path);
  showDestination(destination, false, view);
}

async function handleRoute() {
  if (!routeHandled) {
    routeHandled = true;
    synthesizeParentEntry();
  }
  closeReaderMore();
  const summary = routeSummary();
  if (summary && currentDestination === "text") {
    textLibrary.leave();
    document.body.classList.remove("text-library-open");
  }
  if (!summary) {
    const collectionId = routeCollectionId();
    const settingsRoute = location.pathname === "/settings";
    const destination = location.pathname === "/saved" ? "bookmarks" :
      location.pathname === "/search" ? "search" :
      location.pathname === "/text" ? "text" :
      (location.pathname === "/browse" || location.pathname.startsWith("/collections")) ? "browse" : "library";
    if (destination === "text" && currentDestination === "text") {
      await textLibrary.route(new URLSearchParams(location.search));
    } else {
      if (destination !== "library") applyCatalogRoute(destination);
      if (collectionId !== null) {
        currentDestination = ["browse", "search"].includes(destination) ? destination : "browse";
        await openCollectionDetail(collectionId, "route");
      } else {
        showDestination(destination, false, currentView);
        if (destination !== "library") syncSearchRoute();
      }
    }
    if (settingsRoute) {
      openSettings();
      document.title = "읽기 설정 — ReDSTM";
    }
    else if (!settingsRoute && elements["settings-dialog"].open) elements["settings-dialog"].close();
    return;
  }
  if (elements["settings-dialog"].open) elements["settings-dialog"].close();
  if (!samePost(summary, currentSummary)) await loadPost(summary, "route");
  else document.title = `${currentSummary.title || "제목 없음"} — ReDSTM`;
}

function handleWorkerMessage({ data }) {
  const pending = workerRequests.get(data.id);
  if (pending) {
    workerRequests.delete(data.id);
    if (data.type === "error") {
      const error = new Error(data.message);
      error.code = data.code;
      pending.reject(error);
    }
    else pending.resolve(data.type === "page" ? data : data.summaries);
    return;
  }
  if (data.type === "error") {
    // The text library is a separate archive: a TypeMoon failure must not take over the page
    // (or close a chapter) while it is on screen. It shows on the next TypeMoon screen instead.
    if (currentDestination === "text" || readerSource === "text") {
      deferredArchiveError = { code: data.code, message: data.message };
      return;
    }
    renderArchiveError({ code: data.code, message: data.message });
    return;
  }
  if (data.type === "ready") {
    archiveReady = true;
    elements["archive-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["empty-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["archive-state"].textContent = "보존본";
    latestPosts = data.recentPosts;
    publishedAt = data.publishedAt;
    searchSupportsAa = data.hasIsAa;
    elements["mode-filter"].disabled = !searchSupportsAa;
    if (!searchSupportsAa) elements["mode-filter"].value = "all";
    boardById = new Map((data.boardMetadata ?? []).map((board) => [board.board_id, board]));
    populateBoardFilter();
    elements["result-list"].classList.remove("loading");
    // The text library boots on its own (see the end of this module); do not reset it here.
    const textAlreadyOpen = routeHandled && currentDestination === "text";
    if (!textAlreadyOpen) renderCover();
    if (routeSummary()) requestSearch();
    void hydrateSavedEntries().then(() => {
      if (!currentSummary && currentDestination === "library") renderCover();
      if (currentView !== "all") renderCurrentView();
    }).catch((error) => { elements["result-status"].textContent = error.message; });
    if (!textAlreadyOpen) void handleRoute();
    return;
  }
  if (data.type === "results" && data.id === searchRequestId && currentDestination !== "text" && currentView === "all" && currentScope === "posts") {
    resultTotal = data.total;
    if (searchAppend) appendResults(data.posts);
    else {
      const count = data.posts.length < data.total
        ? `${data.total.toLocaleString("ko-KR")}건 중 ${data.posts.length.toLocaleString("ko-KR")}건`
        : `${data.total.toLocaleString("ko-KR")}건`;
      renderResults(data.posts, count);
    }
  }
}

function renderSearchEmpty() {
  renderedResults = [];
  resultTotal = 0;
  elements["result-list"].replaceChildren();
  elements["result-list"].classList.remove("loading");
  elements["result-more"].hidden = true;
  elements["search-empty"].hidden = false;
  renderWidenActions(false);
  elements["result-status"].textContent = "";
  const hasRecent = recentQueries.length > 0;
  elements["search-empty-copy"].textContent = hasRecent ? "최근 검색" : "검색어를 입력하세요";
  elements["recent-queries"].hidden = !hasRecent;
  elements["recent-queries"].replaceChildren();
  for (const query of recentQueries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = query;
    button.addEventListener("click", () => {
      elements["search-input"].value = query;
      syncSearchRoute();
      renderCurrentView();
    });
    item.append(button);
    elements["recent-queries"].append(item);
  }
  if (hasRecent) {
    const item = document.createElement("li");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "recent-queries-clear";
    clear.textContent = "기록 지우기";
    clear.addEventListener("click", () => {
      recentQueries = [];
      persistCatalogState();
      renderSearchEmpty();
      elements["search-input"].focus({ preventScroll: true });
    });
    item.append(clear);
    elements["recent-queries"].append(item);
  }
}

function requestSearch(offset = 0) {
  if (currentScope === "collections") {
    void renderCollectionCatalog(offset);
    return;
  }
  if (currentDestination === "search" && !elements["search-input"].value.trim()) {
    renderSearchEmpty();
    return;
  }
  elements["search-empty"].hidden = true;
  if (elements["search-input"].value.trim()) rememberQuery(elements["search-input"].value);
  currentView = "all";
  updateTabs();
  const id = ++messageId;
  searchRequestId = id;
  searchAppend = offset > 0;
  if (searchAppend) {
    elements["result-more"].disabled = true;
    elements["result-more"].textContent = "불러오는 중…";
  } else elements["result-more"].hidden = true;
  searchWorker.postMessage({
    type: "search",
    id,
    query: elements["search-input"].value,
    boardId: elements["board-filter"].value,
    mode: elements["mode-filter"].value,
    sort: elements["sort-filter"].value,
    target: elements["search-target"].value,
    match: elements["search-match"].value,
    limit: RESULT_PAGE_SIZE,
    offset,
  });
}

function loadMoreResults() {
  if (currentView !== "all") return;
  if (currentScope === "collections") {
    if (renderedCollections.length < resultTotal) void renderCollectionCatalog(renderedCollections.length);
  } else if (renderedResults.length < resultTotal) requestSearch(renderedResults.length);
}

function updateLoadMore() {
  const more = elements["result-more"];
  const rendered = currentScope === "collections" ? renderedCollections.length : renderedResults.length;
  const remaining = currentView === "all" ? resultTotal - rendered : 0;
  if (remaining > 0) {
    more.hidden = false;
    more.disabled = false;
    more.textContent = `더 보기 · 남은 ${remaining.toLocaleString("ko-KR")}건`;
  } else {
    more.hidden = true;
    more.disabled = true;
  }
}

function localResults(entries) {
  const tokens = normalized(elements["search-input"].value).trim().split(/\s+/).filter(Boolean);
  const saved = currentDestination === "bookmarks";
  const board = saved ? "" : elements["board-filter"].value;
  const mode = saved ? "all" : elements["mode-filter"].value;
  const target = saved ? "all" : elements["search-target"].value;
  const match = saved ? "and" : elements["search-match"].value;
  return entries
    .map((entry) => entry.summary)
    .filter((post) => !board || post.board_id === board)
    .filter((post) => mode === "all" || (mode === "aa") === Boolean(post.is_aa))
    .filter((post) => {
      const bookmark = bookmarks.find((entry) => postIdentity(entry.summary) === postIdentity(post));
      const searchText = target === "title" ? normalized(post.title) : target === "author" ? normalized(post.author) :
        normalized([post.title, post.author, post.category, boardLabel(post.board_id), bookmark?.note, ...(bookmark?.tags ?? [])].join(" "));
      return !tokens.length || (match === "or"
        ? tokens.some((token) => searchText.includes(token))
        : tokens.every((token) => searchText.includes(token)));
    });
}

function renderCurrentView() {
  if (currentDestination === "text") return void textLibrary.searchChanged(elements["search-input"].value);
  if (currentView === "reading") return void renderReadingView();
  if (currentScope === "collections") return void renderCollectionCatalog();
  if (currentView === "all") return requestSearch();
  const entries = currentView === "history" ? historyEntries : bookmarks;
  const posts = localResults(entries);
  const label = currentView === "history" ? "최근 읽음" : "저장한 글";
  renderResults(posts, posts.length ? `${label} ${posts.length}건 · 이 브라우저` : `${label}이 없습니다`);
}

async function renderReadingView() {
  const inProgress = localResults(historyEntries.filter((entry) => postReadingState(entry.progress) === "reading"));
  let collections = [];
  try {
    const index = await collectionIndex();
    const { progress, failedBoards } = await collectionReadingProgress(index);
    if (currentView !== "reading") return;
    collectionProgressFailedBoards = failedBoards;
    collectionProgressById = progress;
    collections = index.summaries.filter((collection) => {
      if (failedBoards.has(collection.board_id)) return false;
      return collectionOccupancy({
        availableCount: collectionAvailableCount(collection),
        finishedCount: progress.get(collection.id)?.finished ?? 0,
        readingCount: progress.get(collection.id)?.reading ?? 0,
      }) === "reading";
    });
  } catch {
    collections = [];
  }
  if (currentView !== "reading") return;
  renderedResults = inProgress;
  renderedCollections = collections;
  resultTotal = inProgress.length + collections.length;
  elements["search-empty"].hidden = true;
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const { read, saved } = stateIdentities();
  const fragment = document.createDocumentFragment();
  inProgress.forEach((post, index) => fragment.append(resultItemElement(post, index, read, saved)));
  for (const collection of collections) fragment.append(collectionItemElement(collection));
  elements["result-list"].append(fragment);
  const failedNote = collectionProgressFailedBoards.size ? " · 일부 읽기 상태 미확인" : "";
  elements["result-status"].textContent = resultTotal
    ? `읽는 중 ${resultTotal}건 · 이 브라우저${failedNote}`
    : (failedNote ? "읽기 상태를 확인하지 못했습니다" : "읽는 중인 글이나 작품이 없습니다");
  updateLoadMore();
}

function resultItemElement(post, index, readIdentities, savedIdentities) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item";
  button.dataset.index = index;
  button.dataset.key = postIdentity(post) ?? `row:${index}`;
  button.classList.toggle("active", samePost(post, currentSummary));
  const title = document.createElement("strong");
  title.className = "result-title";
  if (currentDestination === "search") appendHighlightedText(title, post.title || "제목 없음", elements["search-input"].value);
  else title.textContent = post.title || "제목 없음";
  const titleLine = document.createElement("span");
  titleLine.className = "result-title-line";
  const badges = document.createElement("span");
  badges.className = "result-badges";
  const identity = postIdentity(post);
  const bookmark = bookmarks.find((entry) => postIdentity(entry.summary) === identity);
  const history = historyEntries.find((entry) => postIdentity(entry.summary) === identity);
  const readLabel = postReadingLabel(history?.progress, { seen: Boolean(history) });
  for (const [visible, label] of [
    [post.is_aa === true, "AA"], [savedIdentities.has(identity), "저장"], [Boolean(readLabel), readLabel],
  ]) {
    if (!visible) continue;
    const badge = document.createElement("span");
    badge.textContent = label;
    badges.append(badge);
  }
  if (currentView === "bookmarks") {
    const tags = bookmark?.tags ?? [];
    for (const tag of tags.slice(0, 2)) {
      const badge = document.createElement("span");
      badge.textContent = `#${tag}`;
      badges.append(badge);
    }
    if (tags.length > 2) {
      const badge = document.createElement("span");
      badge.textContent = `+${tags.length - 2}`;
      badges.append(badge);
    }
  }
  titleLine.append(title);
  if (badges.childElementCount) titleLine.append(badges);
  const meta = document.createElement("span");
  meta.className = "result-meta";
  const author = document.createElement("span");
  if (currentDestination === "search") appendHighlightedText(author, post.author || "작성자 없음", elements["search-input"].value);
  else author.textContent = post.author || "작성자 없음";
  for (const [node, className] of [
    [boardLabel(post.board_id) || post.board_id, "result-board"],
    [author, ""],
    [formatSourceDate(post.created_at_raw) || "날짜 없음", ""],
  ]) {
    if (typeof node === "string") {
      const part = document.createElement("span");
      part.className = className;
      part.textContent = node;
      meta.append(part);
    } else {
      node.className = className;
      meta.append(node);
    }
  }
  button.append(titleLine, meta);
  if (currentView === "bookmarks" && bookmark?.note) {
    const note = document.createElement("span");
    note.className = "bookmark-note";
    note.textContent = bookmark.note;
    button.append(note);
  }
  item.append(button);
  if (currentView === "bookmarks") {
    item.className = "bookmark-row";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "bookmark-edit";
    edit.dataset.identity = identity;
    edit.textContent = "편집";
    edit.ariaLabel = `${post.title || "제목 없음"} 메모와 태그 편집`;
    item.append(edit);
  }
  return item;
}

function stateIdentities() {
  return {
    read: new Set(historyEntries.map((entry) => postIdentity(entry.summary)).filter(Boolean)),
    saved: new Set(bookmarks.map((entry) => postIdentity(entry.summary)).filter(Boolean)),
  };
}

function renderWidenActions(empty) {
  const host = elements["search-widen"];
  if (!host) return;
  host.replaceChildren();
  if (!empty || currentDestination !== "search" || !elements["search-input"].value.trim()) {
    host.hidden = true;
    return;
  }
  const actions = [];
  if (elements["search-target"].value !== "all") {
    actions.push(["target", "전체 필드로 검색"]);
  }
  if (elements["board-filter"].value) {
    actions.push(["board", "모든 게시판에서 검색"]);
  }
  if (elements["mode-filter"].value !== "all") {
    actions.push(["mode", "모든 형식으로 검색"]);
  }
  if (!actions.length && activeFilterItems().length) {
    actions.push(["reset", "필터 초기화"]);
  }
  if (!actions.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const lead = document.createElement("p");
  lead.textContent = "결과가 없습니다. 조건을 한 단계 넓혀 보세요.";
  host.append(lead);
  for (const [key, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (key === "reset") resetFilters();
      else clearFilter(key);
    });
    host.append(button);
  }
}

function catalogStatus(countText) {
  if (!["browse", "search"].includes(currentDestination)) return countText;
  const labels = activeFilterItems().map((item) => item.label);
  const note = catalogNote;
  catalogNote = "";
  const status = labels.length ? `${labels.join(" · ")} · ${countText}` : countText;
  return note ? `${note} · ${status}` : status;
}

function renderResults(posts, status) {
  renderedResults = posts;
  elements["search-empty"].hidden = true;
  elements["result-status"].textContent = catalogStatus(status);
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const { read, saved } = stateIdentities();
  const fragment = document.createDocumentFragment();
  posts.forEach((post, index) => fragment.append(resultItemElement(post, index, read, saved)));
  elements["result-list"].append(fragment);
  renderWidenActions(!posts.length);
  updateLoadMore();
  restoreCatalogPosition();
}

// Append the next page in place so paging deeper keeps the already-loaded rows, the reader's
// prev/next-post adjacency, and the current scroll position instead of resetting the list.
function appendResults(posts) {
  const { read, saved } = stateIdentities();
  const fragment = document.createDocumentFragment();
  const base = renderedResults.length;
  posts.forEach((post, index) => fragment.append(resultItemElement(post, base + index, read, saved)));
  elements["result-list"].append(fragment);
  renderedResults = renderedResults.concat(posts);
  elements["result-status"].textContent = catalogStatus(`${resultTotal.toLocaleString("ko-KR")}건`);
  updateLoadMore();
  restoreCatalogPosition();
}

async function renderCollectionCatalog(offset = 0) {
  const requestId = ++collectionSearchId;
  elements["result-more"].hidden = true;
  if (!offset) {
    elements["result-list"].classList.add("loading");
    elements["result-status"].textContent = "작품 목록 준비 중";
  }
  try {
    const index = await collectionIndex();
    collectionBoardIds = new Set(index.summaries.map((collection) => collection.board_id));
    applyBoardFilterOptions();
    const { progress, failedBoards } = await collectionReadingProgress(index);
    if (requestId !== collectionSearchId || currentScope !== "collections") return;
    collectionProgressFailedBoards = failedBoards;
    const query = normalized(elements["search-input"].value).trim();
    if (currentDestination === "search" && !query) {
      renderSearchEmpty();
      renderWidenActions(false);
      return;
    }
    elements["search-empty"].hidden = true;
    const boardId = elements["board-filter"].value;
    const kind = elements["collection-kind-filter"].value;
    const readState = elements["collection-read-filter"].value;
    const matches = index.summaries
      .filter((collection) => !boardId || collection.board_id === boardId)
      .filter((collection) => kind === "all" || collection.kind === kind)
      .filter((collection) => {
        const state = progress.get(collection.id);
        const occupancy = collectionOccupancy({
          availableCount: collectionAvailableCount(collection),
          finishedCount: state?.finished ?? 0,
          readingCount: state?.reading ?? 0,
        });
        if (collectionProgressFailedBoards.has(collection.board_id) && readState !== "all") {
          return false;
        }
        if (readState === "unread") return occupancy === "unread";
        if (readState === "reading") return occupancy === "reading";
        if (readState === "finished") return occupancy === "finished";
        return true;
      })
      .filter((collection) => !query || normalized(collection.title).includes(query))
      .sort(elements["sort-filter"].value === "longest"
        ? (left, right) => right.entry_count - left.entry_count || titleCollator.compare(left.title, right.title)
        : elements["sort-filter"].value === "updated"
        ? (left, right) => (Date.parse(right.latest_created_at) || 0) - (Date.parse(left.latest_created_at) || 0) ||
          titleCollator.compare(left.title, right.title)
        : (left, right) => titleCollator.compare(left.title, right.title) || left.id - right.id);
    collectionProgressById = progress;
    resultTotal = matches.length;
    renderedCollections = matches.slice(0, offset + RESULT_PAGE_SIZE);
    renderCollectionResults();
  } catch (error) {
    if (requestId === collectionSearchId) renderArchiveError(error, "작품 목록을 열 수 없음");
  }
}

function collectionItemElement(collection) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item";
  button.dataset.collectionId = collection.id;
  button.dataset.key = `collection:${collection.id}`;
  button.classList.toggle("active", collection.id === activeCollectionId);
  const title = document.createElement("strong");
  title.className = "result-title";
  if (currentDestination === "search") appendHighlightedText(title, collection.title, elements["search-input"].value);
  else title.textContent = collection.title;
  const meta = document.createElement("span");
  meta.className = "result-meta";
  const progress = collectionProgressById.get(collection.id);
  const copy = collectionRowCopy({
    entryCount: collection.entry_count,
    unavailableCount: collection.unavailable_count ?? 0,
    finishedCount: progress?.finished ?? 0,
    readingCount: progress?.reading ?? 0,
    unknown: collectionProgressFailedBoards.has(collection.board_id),
  });
  const updated = Number.isFinite(Date.parse(collection.latest_created_at))
    ? `최근 글 ${collectionDateFormatter.format(new Date(collection.latest_created_at))}` : null;
  for (const [text, className] of [
    [boardLabel(collection.board_id) || collection.board_id, ""],
    [collection.kind === "oneshot" ? "단편 묶음" : "연재", ""],
    [copy.progress, ""],
    [copy.action, "result-action"],
    [copy.gap, ""],
    [updated, ""],
  ].filter(([text]) => text)) {
    const part = document.createElement("span");
    part.className = className;
    part.textContent = text;
    meta.append(part);
  }
  button.append(title, meta);
  item.append(button);
  return item;
}

function renderCollectionResults() {
  elements["search-empty"].hidden = true;
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const collection of renderedCollections) fragment.append(collectionItemElement(collection));
  elements["result-list"].append(fragment);
  const shown = renderedCollections.length;
  renderWidenActions(!shown);
  const countText = shown < resultTotal
    ? `${resultTotal.toLocaleString("ko-KR")}개 작품 중 ${shown.toLocaleString("ko-KR")}개`
    : `${resultTotal.toLocaleString("ko-KR")}개 작품`;
  elements["result-status"].textContent = catalogStatus(
    collectionProgressFailedBoards.size ? `${countText} · 일부 읽기 상태 미확인` : countText,
  );
  updateLoadMore();
  restoreCatalogPosition();
}

async function collectionReadingProgress(index) {
  const progress = new Map();
  const record = (collectionId, position, readAt, readingProgress = 0) => {
    const current = progress.get(collectionId) ?? {
      positions: new Set(), lastPosition: null, lastReadAt: "", finished: 0, reading: 0,
    };
    const wasUnknown = !current.positions.has(position);
    current.positions.add(position);
    const state = postReadingState(readingProgress);
    if (wasUnknown) {
      if (state === "finished") current.finished += 1;
      if (state === "reading") current.reading += 1;
    }
    if (!current.lastReadAt || Date.parse(readAt) > Date.parse(current.lastReadAt)) {
      current.lastReadAt = readAt;
      current.lastPosition = position;
      current.lastProgress = readingProgress;
    }
    progress.set(collectionId, current);
  };
  const historyByIdentity = historyByIdentityMap();
  const failedBoards = new Set();
  if (index.schemaVersion === 1) {
    for (const collection of index.legacy) {
      for (const entry of collection.entries) {
        if (!entry.object_key) continue;
        const history = historyByIdentity.get(postIdentity(entry));
        if (history) record(collection.id, entry.position, history.readAt, history.progress);
      }
    }
    return { progress, failedBoards };
  }
  const byBoard = new Map();
  for (const entry of historyEntries) {
    const boardEntries = byBoard.get(entry.summary.board_id) ?? [];
    boardEntries.push(entry);
    byBoard.set(entry.summary.board_id, boardEntries);
  }
  await Promise.all([...byBoard].map(async ([boardId, entries]) => {
    try {
      const membership = await loadCollectionMembership(boardId);
      for (const entry of entries) {
        const member = membership.get(entry.summary.external_post_id);
        if (member?.available === false) continue;
        if (member) record(member.collectionId, member.position, entry.readAt, entry.progress);
      }
    } catch {
      failedBoards.add(boardId);
    }
  }));
  return { progress, failedBoards };
}

// navigation: "push" opens from a list, "replace" swaps the Reader for its table of contents,
// "route" follows history (Back/Forward/deep link) and restores the saved list viewport.
async function openCollectionDetail(collectionId, navigation = "push", { focusPosition = null } = {}) {
  if (currentSummary) persistReadingPosition();
  const viewId = ++readerViewId;
  postController?.abort();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  try {
    const collection = await loadCollectionDetail(collectionId);
    if (viewId !== readerViewId) return;
    if (!collection) throw new Error("현재 보존본에서 작품을 찾을 수 없습니다");
    currentSummary = null;
    currentPayload = null;
    currentCollection = null;
    activeCollectionId = collection.id;
    setScope("collections");
    if (!["browse", "search"].includes(currentDestination)) currentDestination = "browse";
    updateDestinationLayout();
    updateDestinationButtons();
    setReaderSource(null);
    elements["empty-reader"].hidden = true;
    elements["collection-view"].hidden = false;
    document.body.classList.add("collection-detail-open");
    elements["collection-title"].textContent = collection.title;
    const unavailable = collection.entries.filter((entry) => !entry.object_key).length;
    void collectionIndex().then((index) => {
      const summary = index.summaryById?.get(collection.id) ?? index.summaries.find((item) => item.id === collection.id);
      if (summary) summary.unavailable_count = unavailable;
    }).catch(() => {});
    const historyByIdentity = historyByIdentityMap();
    const available = collection.entries.filter((entry) => entry.object_key);
    const finishedEntries = available.filter((entry) => postReadingState(historyByIdentity.get(postIdentity(entry))?.progress) === "finished");
    const readingEntries = available.filter((entry) => postReadingState(historyByIdentity.get(postIdentity(entry))?.progress) === "reading");
    const continueTarget = collectionContinueTarget(collection.entries, historyByIdentity);
    elements["collection-meta"].textContent = [
      boardLabel(collection.board_id) || collection.board_id,
      collection.kind === "oneshot" ? "단편 묶음" : "연재",
      `${collection.entries.length.toLocaleString("ko-KR")}편`,
      unavailable ? `${unavailable.toLocaleString("ko-KR")}편 보존 불가` : "전체 보존",
      `읽음 ${finishedEntries.length.toLocaleString("ko-KR")}/${available.length.toLocaleString("ko-KR")}`,
      readingEntries.length ? `읽는 중 ${readingEntries.length}` : null,
    ].filter(Boolean).join(" · ");
    const skippedUnread = available.filter((entry) =>
      postReadingState(historyByIdentity.get(postIdentity(entry))?.progress) !== "finished");
    const continueEntry = continueTarget.kind === "finished" || continueTarget.kind === "empty" ? null : continueTarget.entry;
    const unreadFocus = continueTarget.kind === "finished" ? skippedUnread[0] : null;
    elements["collection-continue"].hidden = !continueEntry && !unreadFocus;
    elements["collection-continue"].dataset.action = unreadFocus ? "unread" : "read";
    elements["collection-continue"].dataset.position = (continueEntry ?? unreadFocus)?.position ?? "";
    elements["collection-continue"].textContent = continueTarget.kind === "start"
      ? `처음부터 읽기 · ${continueEntry.position}편`
      : continueTarget.kind === "resume"
      ? `${continueEntry.position}편부터 이어 읽기`
      : continueTarget.kind === "next"
      ? `${continueEntry.position}편부터 이어 읽기`
      : unreadFocus
      ? `앞쪽 미독 ${skippedUnread.length.toLocaleString("ko-KR")}편 보기`
      : "";
    const lastRead = collection.entries
      .map((entry) => ({ entry, readAt: Date.parse(historyByIdentity.get(postIdentity(entry))?.readAt ?? "") }))
      .filter((item) => Number.isFinite(item.readAt))
      .sort((left, right) => right.readAt - left.readAt)[0]?.entry ?? null;
    const fragment = document.createDocumentFragment();
    for (const entry of collection.entries) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "collection-entry";
      button.disabled = !entry.object_key;
      button.dataset.position = entry.position;
      button.dataset.key = String(entry.position);
      if (entry === lastRead) {
        button.classList.add("current");
        button.setAttribute("aria-current", "true");
      }
      const position = document.createElement("span");
      position.className = "collection-entry-position";
      position.textContent = `${entry.position}편`;
      const title = document.createElement("span");
      title.className = "collection-entry-title";
      title.textContent = entry.title || "제목 없음";
      const state = document.createElement("span");
      state.className = "collection-entry-state";
      const entryState = postReadingState(historyByIdentity.get(postIdentity(entry))?.progress);
      state.textContent = entryState === "finished" ? "완료"
        : entryState === "reading" ? postReadingLabel(historyByIdentity.get(postIdentity(entry))?.progress)
        : entry === continueEntry ? "다음" : "";
      button.classList.toggle("read", entryState === "finished");
      button.append(position, title, state);
      item.append(button);
      fragment.append(item);
    }
    elements["collection-entry-list"].replaceChildren(fragment);
    elements["collection-entry-list"].dataset.collectionId = collection.id;
    document.title = `${collection.title} — ReDSTM`;
    const route = `/collections/${collection.id}`;
    if (navigation === "push") {
      history.pushState({ redstmCollection: true, redstmParent: currentRoute() }, "", route);
    } else if (navigation === "replace") {
      history.replaceState({ redstmCollection: true, redstmParent: history.state?.redstmParent ?? null }, "", route);
    }
    openMobileReader();
    requestAnimationFrame(() => restoreCollectionViewport(route, navigation, focusPosition));
  } catch (error) {
    if (viewId !== readerViewId) return;
    renderArchiveError(error, "작품 목차를 열 수 없음");
  } finally {
    if (viewId === readerViewId) elements["reader-pane"].removeAttribute("aria-busy");
  }
}

function restoreCollectionViewport(route, navigation, focusPosition) {
  const pane = elements["reader-pane"];
  const list = elements["collection-entry-list"];
  const entryAt = (position) => list.querySelector(`.collection-entry[data-key="${Number(position)}"]`);
  const snapshot = navigation === "replace" ? null : loadListPosition(route);
  let focusTarget = elements["collection-title"];
  if (focusPosition && entryAt(focusPosition)) {
    const entry = entryAt(focusPosition);
    pane.scrollTop += entry.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3;
    focusTarget = entry;
  } else if (snapshot) {
    restoreListAnchor(pane, snapshot, ".collection-entry[data-key]");
    const activated = snapshot.activatedKey && entryAt(snapshot.activatedKey);
    if (activated) focusTarget = activated;
  } else {
    pane.scrollTop = 0;
  }
  focusTarget.focus({ preventScroll: true });
}

function rememberCollectionViewport(activatedPosition) {
  const collectionId = elements["collection-entry-list"].dataset.collectionId;
  const snapshot = captureListAnchor(elements["reader-pane"], ".collection-entry[data-key]");
  if (collectionId && snapshot) {
    saveListPosition(`/collections/${collectionId}`, { ...snapshot, activatedKey: String(activatedPosition) });
  }
}

async function fetchCollectionObject(ref, label) {
  if (!collectionObjectKeyPattern.test(ref?.object_key ?? "")) throw new Error(`잘못된 ${label} 참조`);
  const response = await fetch(`/archive/${ref.object_key}`);
  requireArchiveResponse(response, `${label} 응답 ${response.status}`);
  return response.json();
}

function validateCollection(collection) {
  if (!Number.isInteger(collection?.id) || collection.id <= 0 || typeof collection.title !== "string" ||
      typeof collection.board_id !== "string" || !Array.isArray(collection.entries)) {
    throw new Error("잘못된 컬렉션");
  }
  collection.entries.forEach((entry, index) => {
    const match = postObjectKeyPattern.exec(entry?.object_key ?? "");
    const invalidObject = entry?.object_key !== null &&
      (!match || match[1] !== entry.board_id || Number(match[2]) !== entry.external_post_id);
    if (entry?.position !== index + 1 || !Number.isInteger(entry.external_post_id) ||
        entry.external_post_id <= 0 || entry.board_id !== collection.board_id || invalidObject) {
      throw new Error("잘못된 컬렉션 글");
    }
  });
  return collection;
}

async function loadCollectionIndex() {
  const releaseResponse = await fetch("/archive/release.json");
  requireArchiveResponse(releaseResponse, `release 응답 ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  if (release.schema_version !== 1) {
    throw new Error("지원하지 않는 컬렉션 release 형식");
  }
  const payload = await fetchCollectionObject(release.collections, "컬렉션");
  if (!Array.isArray(payload?.collections)) throw new Error("지원하지 않는 컬렉션 형식");
  if (payload.schema_version === 1) {
    const legacy = payload.collections.map(validateCollection);
    return {
      schemaVersion: 1,
      summaries: legacy.map(({ id, board_id, kind, title, entries }) =>
        ({
          id, board_id, kind, title, entry_count: entries.length,
          unavailable_count: entries.filter((entry) => !entry.object_key).length,
        })),
      legacy,
    };
  }
  if (payload.schema_version !== 2 || !Number.isInteger(payload.shard_count) ||
      payload.shard_count < 1 || payload.shard_count > 256 ||
      !Array.isArray(payload.detail_shards) || !Array.isArray(payload.memberships)) {
    throw new Error("지원하지 않는 컬렉션 형식");
  }
  const summaries = new Map();
  for (const summary of payload.collections) {
    if (!Number.isInteger(summary?.id) || summary.id <= 0 || typeof summary.board_id !== "string" ||
        typeof summary.kind !== "string" || typeof summary.title !== "string" ||
        !Number.isInteger(summary.entry_count) || summary.entry_count < 0 || summaries.has(summary.id) ||
        (summary.unavailable_count !== undefined && (
          !Number.isInteger(summary.unavailable_count) || summary.unavailable_count < 0 ||
          summary.unavailable_count > summary.entry_count)) ||
        (summary.latest_created_at !== null && summary.latest_created_at !== undefined &&
          (typeof summary.latest_created_at !== "string" || !Number.isFinite(Date.parse(summary.latest_created_at))))) {
      throw new Error("잘못된 컬렉션 요약");
    }
    summaries.set(summary.id, summary);
  }
  const details = new Map();
  for (const ref of payload.detail_shards) {
    if (!Number.isInteger(ref?.shard) || ref.shard < 0 || ref.shard >= payload.shard_count || details.has(ref.shard) ||
        !collectionObjectKeyPattern.test(ref.object_key ?? "")) throw new Error("잘못된 컬렉션 목차 참조");
    details.set(ref.shard, ref);
  }
  const memberships = new Map();
  for (const ref of payload.memberships) {
    if (typeof ref?.board_id !== "string" || memberships.has(ref.board_id) ||
        !collectionObjectKeyPattern.test(ref.object_key ?? "")) throw new Error("잘못된 컬렉션 소속 참조");
    memberships.set(ref.board_id, ref);
  }
  return {
    schemaVersion: 2,
    shardCount: payload.shard_count,
    summaries: [...summaries.values()],
    summaryById: summaries,
    details,
    memberships,
  };
}

function collectionIndex() {
  collectionIndexPromise ??= loadCollectionIndex().catch((error) => {
    collectionIndexPromise = undefined;
    throw error;
  });
  return collectionIndexPromise;
}

async function loadCollectionDetail(collectionId) {
  const index = await collectionIndex();
  if (index.schemaVersion === 1) return index.legacy.find((item) => item.id === collectionId) ?? null;
  const summary = index.summaryById.get(collectionId);
  if (!summary) return null;
  const shard = collectionId % index.shardCount;
  const ref = index.details.get(shard);
  if (!ref) throw new Error("컬렉션 목차가 없습니다");
  let promise = collectionDetailPromises.get(shard);
  if (!promise) {
    promise = fetchCollectionObject(ref, "컬렉션 목차").then((payload) => {
      if (payload?.schema_version !== 1 || payload.shard !== shard || !Array.isArray(payload.collections)) {
        throw new Error("잘못된 컬렉션 목차");
      }
      return payload.collections.map(validateCollection);
    }).catch((error) => {
      collectionDetailPromises.delete(shard);
      throw error;
    });
    collectionDetailPromises.set(shard, promise);
  }
  const collection = (await promise).find((item) => item.id === collectionId) ?? null;
  if (collection && (collection.board_id !== summary.board_id || collection.kind !== summary.kind ||
      collection.title !== summary.title || collection.entries.length !== summary.entry_count)) {
    throw new Error("컬렉션 요약이 목차와 다릅니다");
  }
  return collection;
}

async function loadCollectionMembership(boardId) {
  const index = await collectionIndex();
  if (index.schemaVersion === 1) return null;
  const ref = index.memberships.get(boardId);
  if (!ref) return new Map();
  let promise = collectionMembershipPromises.get(boardId);
  if (!promise) {
    promise = fetchCollectionObject(ref, "컬렉션 소속").then((payload) => {
      if (payload?.schema_version !== 1 || payload.board_id !== boardId || !Array.isArray(payload.members)) {
        throw new Error("잘못된 컬렉션 소속");
      }
      const memberships = new Map();
      for (const member of payload.members) {
        if (!Array.isArray(member) || member.length !== 3 ||
            !Number.isInteger(member[0]) || member[0] <= 0 ||
            !Number.isInteger(member[1]) || member[1] <= 0 ||
            !Number.isInteger(member[2]) || member[2] <= 0 ||
            memberships.has(member[0])) {
          throw new Error("잘못된 컬렉션 소속 글");
        }
        memberships.set(member[0], { collectionId: member[1], position: member[2], available: true });
      }
      if (payload.unavailable !== undefined) {
        if (!Array.isArray(payload.unavailable)) throw new Error("잘못된 컬렉션 소속 글");
        const seen = new Set();
        for (const id of payload.unavailable) {
          if (!Number.isInteger(id) || id <= 0 || !memberships.has(id) || seen.has(id)) {
            throw new Error("잘못된 컬렉션 소속 글");
          }
          seen.add(id);
          memberships.get(id).available = false;
        }
      }
      return memberships;
    }).catch((error) => {
      collectionMembershipPromises.delete(boardId);
      throw error;
    });
    collectionMembershipPromises.set(boardId, promise);
  }
  return promise;
}

async function findCollection(summary) {
  const index = await collectionIndex();
  if (index.schemaVersion === 1) {
    const candidates = activeCollectionId === null
      ? index.legacy
      : [...index.legacy.filter((item) => item.id === activeCollectionId),
        ...index.legacy.filter((item) => item.id !== activeCollectionId)];
    for (const collection of candidates) {
      const position = collection.entries.findIndex((entry) => samePost(entry, summary));
      if (position >= 0) return { collection, index: position };
    }
    return null;
  }
  const membership = (await loadCollectionMembership(summary.board_id)).get(summary.external_post_id);
  if (!membership) return null;
  const collection = await loadCollectionDetail(membership.collectionId);
  if (!collection) throw new Error("컬렉션 목차가 없습니다");
  const position = membership.position - 1;
  if (!samePost(collection.entries[position], summary)) throw new Error("컬렉션 소속이 목차와 다릅니다");
  return { collection, index: position };
}

async function updateCollection() {
  const summary = currentSummary;
  currentCollection = null;
  elements["collection-context"].hidden = true;
  // Hold the step buttons until membership decides whether they mean "episode" or "list row".
  renderReaderNavigation({ ...typeMoonNavigation(), pending: true });
  try {
    const membership = await findCollection(summary);
    if (!samePost(summary, currentSummary)) return;
    currentCollection = membership;
    if (membership) {
      activeCollectionId = membership.collection.id;
      const unavailable = membership.collection.entries.filter((entry) => !entry.object_key).length;
      const label = `${membership.collection.title} · ${membership.index + 1}/${membership.collection.entries.length}` +
        (unavailable ? ` · ${unavailable}편 보존 불가` : "");
      elements["collection-context"].textContent = label;
      elements["collection-context"].title = label;
      elements["collection-context"].hidden = false;
    }
    updateNavigation();
  } catch {
    if (samePost(summary, currentSummary)) updateNavigation();
  }
}

// navigation: "push" enters the Reader from a list or Home, "replace" moves within the same
// reading session (previous/next, another row of a visible side list), "route" follows history.
async function loadPost(summary, navigation = "push", { listHint = "" } = {}) {
  const viewId = ++readerViewId;
  if (currentSummary) persistReadingPosition();
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  if (!currentSummary && currentDestination === "library") {
    renderCover("본문을 불러오는 중", "보존 객체를 확인하고 있습니다.", false);
  }
  try {
    const resolved = summary?.object_key ? summary : (await resolvePosts([summary]))[0];
    if (viewId !== readerViewId) return;
    if (!resolved?.object_key) throw new Error("현재 보존본에서 글을 찾을 수 없습니다");
    const response = await fetch(`/archive/${resolved.object_key}`, { signal: postController.signal });
    requireArchiveResponse(response, response.status === 404 ? "보존 객체가 없습니다" : `본문 응답 ${response.status}`);
    const payload = await responseJsonWithProgress(response, "본문");
    if (viewId !== readerViewId) return;
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
    elements["archive-state"].textContent = "보존본";
    showPost(payload, resolved, navigation, listHint);
  } catch (error) {
    if (viewId !== readerViewId || error.name === "AbortError") return;
    renderArchiveError(error, "본문을 열 수 없음");
    if (error.code !== "access_expired" && navigator.onLine) elements["archive-state"].textContent = "본문 오류";
  } finally {
    if (viewId === readerViewId) elements["reader-pane"].removeAttribute("aria-busy");
  }
}

function showPost(payload, suppliedSummary, navigation, listHint = "") {
  const post = payload.post;
  currentPayload = payload;
  currentSummary = {
    ...suppliedSummary,
    board_id: post.board_id,
    external_post_id: post.external_post_id,
    title: post.title,
    author: post.author,
    category: post.category,
    created_at_raw: post.created_at_raw,
    is_aa: post.is_aa,
    object_key: suppliedSummary.object_key,
    comment_count: payload.comments.length,
    views: post.views,
  };
  const continuing = readerSource === "typemoon";
  setReaderSource("typemoon");
  resetReaderChrome();
  if (!continuing) collapseCatalogForReading();
  elements["reader-kicker"].textContent = [boardLabel(post.board_id) || post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  document.title = `${post.title || "제목 없음"} — ReDSTM`;
  elements["reader-meta"].textContent = [post.author || "작성자 없음", formatSourceDate(post.created_at_raw) || post.created_at_raw, `조회 ${post.views ?? 0}`].filter(Boolean).join(" · ");
  setSourceLink(post.canonical_url);
  renderPostBody();
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  void updateCollection();
  if (currentScope === "collections") renderCollectionResults();
  else renderResults(renderedResults, elements["result-status"].textContent);
  const nextUrl = `/read/${currentSummary.board_id}/${currentSummary.external_post_id}`;
  // Only entering the Reader adds a history entry. Episode moves replace it, so one Back
  // (system or the 목록 button) always returns to the list the session started from.
  if (navigation === "push") {
    history.pushState({ redstmReader: true, redstmParent: currentRoute(), ...(listHint ? { redstmList: listHint } : {}) }, "", nextUrl);
  } else {
    history.replaceState({ ...(history.state ?? {}), redstmReader: true, redstmCollection: false }, "", nextUrl);
  }
  // Reads the parent route from history.state, so it runs after the entry above is written.
  void refreshTypeMoonList();
  openMobileReader();
  updateShellMode();
  requestAnimationFrame(() => {
    elements["reader-title"].focus({ preventScroll: true });
    restoreReadingPosition(currentSummary);
  });
}

function renderPostBody() {
  const post = currentPayload.post;
  const identity = `${post.board_id}:${post.external_post_id}`;
  const override = settings.viewModes[identity];
  currentMode = override ?? (post.is_aa ? "aa" : "prose");
  const isAa = currentMode === "aa";
  elements["archive-body"].classList.toggle("aa", isAa);
  elements["archive-body"].ariaLabel = isAa ? "AA 본문 · 좌우로 이동하거나 두 손가락으로 확대할 수 있습니다" : "글 본문";
  elements["aa-controls"].hidden = !isAa;
  elements["mode-toggle"].textContent = isAa ? "소설로 보기" : "AA로 보기";
  elements["mode-reset"].hidden = !override;
  elements["archive-body"].classList.remove("plain-text");
  delete elements["archive-body"].dataset.mediaEnhanced;
  if (isAa) {
    const canvas = document.createElement("div");
    canvas.className = "aa-canvas";
    canvas.innerHTML = post.body_html;
    elements["archive-body"].replaceChildren(canvas);
  } else {
    elements["archive-body"].innerHTML = post.body_html;
  }
  normalizeReaderTypography(elements["archive-body"]);
  applySettings();
  decorateImages(elements["archive-body"]);
  if (!isAa) enhanceHtmlMedia(elements["archive-body"]);
  requestAnimationFrame(() => updateAaOverflowCue(true));
}

function normalizeReaderTypography(container) {
  for (const element of container.querySelectorAll('font, [style*="font" i], [style*="line-height" i]')) {
    for (const property of ["font-family", "font-size", "line-height"]) {
      element.style.setProperty(property, "inherit", "important");
    }
  }
}

function openImageViewer(href) {
  elements["image-viewer-image"].src = href;
  elements["image-viewer-source"].href = href;
  if (!elements["image-viewer"].open) elements["image-viewer"].showModal();
}

function renderComments(comments) {
  elements["comment-count"].textContent = comments.length.toLocaleString("ko-KR");
  elements["comment-list"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const comment of comments) {
    const item = document.createElement("li");
    item.className = "comment";
    item.style.setProperty("--depth", Math.max(0, Number(comment.depth) || 0));
    const header = document.createElement("header");
    const author = document.createElement("strong");
    author.textContent = comment.author || "작성자 없음";
    const date = document.createElement("span");
    date.textContent = comment.created_at_raw || "";
    const body = document.createElement("div");
    body.className = "comment-body";
    body.innerHTML = comment.content_html;
    const isAaComment =
      /AA_Text|saitamaar|Stmr|MS P(?:Gothic|ゴシック)|ＭＳ Ｐゴシック|IPAMona|(?:font-family|face)\s*[:=]\s*["']?Mona\b/i.test(comment.content_html);
    body.classList.toggle("aa-comment", isAaComment);
    if (isAaComment) normalizeReaderTypography(body);
    decorateImages(body);
    header.append(author, date);
    item.append(header, body);
    fragment.append(item);
  }
  elements["comment-list"].append(fragment);
  applySettings();
}

function rememberHistory(summary) {
  const previous = historyEntries.find((entry) => samePost(entry.summary, summary));
  historyEntries = historyEntries.filter((entry) => !samePost(entry.summary, summary));
  historyEntries.unshift({ summary, readAt: new Date().toISOString(), scroll: previous?.scroll ?? 0, progress: previous?.progress ?? 0 });
  persistUserState();
}

function isNarrowScreen() {
  return matchMedia("(max-width: 759px)").matches;
}

function readingPosition() {
  return elements["reader-pane"].scrollTop;
}

let restoredScroll = null;
function restoreReadingPosition(summary) {
  const position = historyEntries.find((entry) => samePost(entry.summary, summary))?.scroll ?? 0;
  lastReaderScroll = position;
  readerScrollDelta = 0;
  elements["reader-pane"].scrollTop = position;
  restoredScroll = elements["reader-pane"].scrollTop;
}

function persistReadingPosition() {
  clearTimeout(scrollTimer);
  if (!currentSummary) return;
  const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
  if (entry) {
    entry.scroll = readingPosition();
    const measured = bodyProgress();
    entry.progress = postReadingState(entry.progress) === "finished"
      ? Math.max(entry.progress, measured)
      : measured;
  }
  persistUserState();
}

function markCurrentFinished() {
  persistReadingPosition();
  const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
  if (!entry) return;
  entry.progress = Math.max(entry.progress ?? 0, 1); // end-of-article next is 완독, not just 95%
  persistUserState();
}

function queueScrollSave() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(persistReadingPosition, 250);
}

function updateReadingProgress() {
  if (!readerSource) return;
  const progress = bodyProgress();
  elements["reading-progress"].style.width = `${progress * 100}%`;
  elements["reader-topbar-progress"].textContent = `${Math.round(progress * 100)}%`;
  elements["reader-status"].textContent = `${Math.round(progress * 100)}%`;
  elements["reading-progress"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function updateBookmarkButton() {
  if (readerSource !== "typemoon") return;
  renderBookmarkState(bookmarks.some((entry) => samePost(entry.summary, currentSummary)), { notes: true });
}

function toggleTypeMoonBookmark() {
  if (!currentSummary) return;
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  bookmarks = active
    ? bookmarks.filter((entry) => !samePost(entry.summary, currentSummary))
    : [{ summary: currentSummary, savedAt: new Date().toISOString() }, ...bookmarks];
  persistUserState();
  renderAfterBookmarkChange();
}

function openTextBookmarkEditor() {
  const details = textLibrary.bookmarkDetails();
  if (!details) return;
  editingTextBookmark = true;
  editingBookmarkSummary = null;
  elements["bookmark-dialog-post"].textContent = details.title;
  elements["bookmark-note"].value = details.note;
  elements["bookmark-tags"].value = details.tags.join(", ");
  elements["bookmark-remove"].hidden = !details.saved;
  if (!elements["bookmark-dialog"].open) elements["bookmark-dialog"].showModal();
  requestAnimationFrame(() => elements["bookmark-note"].focus());
}

function openBookmarkEditor(summary) {
  const identity = postIdentity(summary);
  if (!identity) return;
  editingTextBookmark = false;
  const existing = bookmarks.find((entry) => postIdentity(entry.summary) === identity);
  editingBookmarkSummary = existing?.summary ?? summary;
  elements["bookmark-dialog-post"].textContent = editingBookmarkSummary.title || "제목 없음";
  elements["bookmark-note"].value = existing?.note ?? "";
  elements["bookmark-tags"].value = (existing?.tags ?? []).join(", ");
  elements["bookmark-remove"].hidden = !existing;
  if (!elements["bookmark-dialog"].open) elements["bookmark-dialog"].showModal();
  requestAnimationFrame(() => elements["bookmark-note"].focus());
}

function closeBookmarkEditor() {
  if (elements["bookmark-dialog"].open) elements["bookmark-dialog"].close();
  editingBookmarkSummary = null;
  editingTextBookmark = false;
}

function renderAfterBookmarkChange() {
  updateBookmarkButton();
  if (currentView === "bookmarks") renderCurrentView();
  else if (currentScope === "collections") renderCollectionResults();
  else renderResults(renderedResults, elements["result-status"].textContent);
}

function updateNavigation() {
  if (readerSource === "typemoon") renderReaderNavigation(typeMoonNavigation());
}

function entryStep(entry) {
  return entry ? {
    title: entry.title || "제목 없음",
    entry,
    prefetch: postObjectKeyPattern.test(entry.object_key ?? "") ? `/archive/${entry.object_key}` : "",
  } : null;
}

// Collection members move in collection order; other posts move through the list the Reader
// was opened from, frozen as rendered. A post missing from that list never borrows a neighbour.
function typeMoonNavigation() {
  if (currentCollection) {
    const { collection, index } = currentCollection;
    const available = (entry) => Boolean(entry.object_key);
    const previous = adjacentInSequence(collection.entries, index, -1, available);
    const next = adjacentInSequence(collection.entries, index, 1, available);
    const skipped = next.skipped.length;
    const note = next.kind === "gap"
      ? `${skipped <= 3 ? next.skipped.map((entry) => `${entry.position}편`).join("·") : `${skipped}편`}은 보존되지 않아 ${next.target.position}편으로 이어집니다.`
      : next.kind === "unavailable-tail" ? `이후 ${skipped}편은 현재 보존되지 않았습니다.` : "";
    return {
      unit: "편",
      previous: entryStep(previous.target),
      next: entryStep(next.target),
      note,
      endFallback: next.target ? null : { kicker: "마지막 보존 편", label: "작품 목차로 돌아가기", action: "toc" },
      hasToc: true,
      context: `${collection.title} · ${index + 1}/${collection.entries.length}`,
    };
  }
  // Other posts step through the list the session came from, in that list's order.
  const located = listContext?.result && listContext.summaryKey === postIdentity(currentSummary) ? listContext.result : null;
  const next = located ? entryStep(located.next) : null;
  return {
    unit: "글",
    qualifier: listContext?.descriptor.qualifier ?? "",
    previous: located ? entryStep(located.previous) : null,
    next,
    pending: !located && Boolean(listContext?.loading),
    note: located && located.found >= 0 && !next ? "목록의 마지막 글입니다." : "",
    hasToc: false,
    context: boardLabel(currentSummary?.board_id) || "",
  };
}

// ---- The list under the Reader ------------------------------------------------------------

// Which list a TypeMoon reading session belongs to, read from the route that opened it.
function listDescriptor() {
  const state = history.state ?? {};
  const parent = typeof state.redstmParent === "string" ? state.redstmParent : "";
  const url = new URL(parent || "/", location.origin);
  const boardOnly = (boardId) => ({
    kind: "search",
    params: { boardId },
    kicker: "게시판",
    title: boardLabel(boardId) || boardId,
    qualifier: "게시판",
  });
  const collection = /^\/collections\/([1-9]\d*)$/.exec(url.pathname);
  if (collection) return { kind: "collection", collectionId: Number(collection[1]), kicker: "작품 목차", title: "" };
  if (!parent || state.redstmSyntheticParent) return boardOnly(currentSummary.board_id);
  if (url.pathname === "/saved") {
    const view = url.searchParams.get("view");
    const source = view === "recent" ? historyEntries
      : view === "reading" ? historyEntries.filter((entry) => postReadingState(entry.progress) === "reading")
      : bookmarks;
    return {
      kind: "items",
      items: source.map((entry) => entry.summary),
      kicker: "보관함",
      title: view === "recent" ? "최근 읽음" : view === "reading" ? "읽는 중" : "저장한 글",
      qualifier: "현재 목록",
    };
  }
  if (url.pathname === "/" && state.redstmList === "recent") {
    return { kind: "items", items: historyEntries.map((entry) => entry.summary), kicker: "홈", title: "최근 읽은 글", qualifier: "현재 목록" };
  }
  if (url.pathname === "/browse" || url.pathname === "/search") {
    const query = url.searchParams;
    const params = {
      query: query.get("q") ?? "",
      boardId: query.get("board") ?? "",
      mode: searchSupportsAa && ["aa", "prose"].includes(query.get("mode")) ? query.get("mode") : "all",
      sort: query.get("sort") === "oldest" ? "oldest" : "latest",
      target: ["title", "author"].includes(query.get("target")) ? query.get("target") : "all",
      match: query.get("match") === "or" ? "or" : "and",
    };
    const conditions = [
      params.query && params.boardId ? boardLabel(params.boardId) : "",
      params.mode === "aa" ? "AA" : params.mode === "prose" ? "소설·일반" : "",
      params.sort === "oldest" ? "오래된순" : "",
    ].filter(Boolean);
    return {
      kind: "search",
      params,
      kicker: params.query ? "검색 결과" : "게시판",
      title: [params.query ? `“${params.query}”` : (boardLabel(params.boardId) || "전체 게시판"), ...conditions].join(" · "),
      qualifier: "현재 결과",
    };
  }
  if (url.pathname === "/") return { kind: "search", params: {}, kicker: "홈", title: "최근 게시된 글", qualifier: "최근 글" };
  return boardOnly(currentSummary.board_id);
}

function workerPage(params) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    searchWorker.postMessage({ type: "page", id, pageSize: READER_LIST_PAGE, ...params });
  });
}

function localPage(items, identity, page) {
  const found = items.findIndex((item) => postIdentity(item) === identity);
  const lastPage = Math.max(0, Math.ceil(items.length / READER_LIST_PAGE) - 1);
  const pageIndex = Number.isInteger(page) ? Math.min(Math.max(0, page), lastPage)
    : found >= 0 ? Math.floor(found / READER_LIST_PAGE) : 0;
  const offset = pageIndex * READER_LIST_PAGE;
  return {
    posts: items.slice(offset, offset + READER_LIST_PAGE),
    total: items.length,
    offset,
    found,
    previous: found > 0 ? items[found - 1] : null,
    next: found >= 0 ? items[found + 1] ?? null : null,
  };
}

// Loads the page of the session's list containing the current post (or an explicit page).
async function refreshTypeMoonList({ page = null } = {}) {
  if (!currentSummary) return;
  const requestId = ++listRequestId;
  const summaryKey = postIdentity(currentSummary);
  const descriptor = page === null || !listContext ? listDescriptor() : listContext.descriptor;
  listContext = { descriptor, summaryKey, loading: true, result: page === null ? null : listContext?.result };
  let result;
  try {
    if (descriptor.kind === "collection") {
      const collection = await loadCollectionDetail(descriptor.collectionId);
      if (!collection) throw new Error("작품 목차가 없습니다");
      descriptor.title = collection.title;
      result = localPage(collection.entries, summaryKey, page);
      result.collection = true;
    } else if (descriptor.kind === "items") {
      result = localPage(descriptor.items, summaryKey, page);
    } else {
      result = await workerPage({ ...descriptor.params, around: summaryKey, page });
    }
  } catch {
    result = null;
  }
  if (requestId !== listRequestId || postIdentity(currentSummary) !== summaryKey) return;
  // Paging keeps the neighbours that were located around the current post.
  if (page !== null && result && listContext.result) {
    result.found = listContext.result.found;
    result.previous = listContext.result.previous;
    result.next = listContext.result.next;
  }
  listContext = { descriptor, summaryKey, loading: false, result };
  renderTypeMoonList();
  updateNavigation();
}

function renderTypeMoonList() {
  const { descriptor, result } = listContext ?? {};
  if (!result) {
    renderReaderList(null);
    return;
  }
  const history = historyByIdentityMap();
  const current = postIdentity(currentSummary);
  const showBoard = descriptor.kind !== "search" || !descriptor.params.boardId || descriptor.params.query;
  renderReaderList({
    kicker: descriptor.kicker,
    title: descriptor.title,
    total: result.total,
    offset: result.offset,
    hint: result.found < 0 ? "지금 읽는 글은 이 목록에 없습니다." : "",
    rows: result.posts.map((post) => {
      const identity = postIdentity(post);
      const progress = history.get(identity)?.progress;
      return {
        key: identity,
        title: post.title || "제목 없음",
        meta: result.collection
          ? [`${post.position}편`, post.object_key ? "" : "보존 불가",
            identity === current ? "" : postReadingLabel(progress, { seen: history.has(identity) })].filter(Boolean).join(" · ")
          : [showBoard ? boardLabel(post.board_id) : "", post.author, formatSourceDate(post.created_at_raw),
            identity === current ? "" : postReadingLabel(progress, { seen: history.has(identity) })].filter(Boolean).join(" · "),
        current: identity === current,
        read: postReadingState(progress) === "finished",
        disabled: result.collection && !post.object_key,
        post,
      };
    }),
    onOpen: (row) => loadPost(row.post, "replace"),
    onPage: (delta) => refreshTypeMoonList({ page: Math.floor(result.offset / READER_LIST_PAGE) + delta }),
  });
}

// model: { kicker, title, total, offset, hint, rows: [{ key, title, meta, current, read, disabled }],
// onOpen(row), onPage(delta) } or null to hide the section.
function renderReaderList(model) {
  readerListModel = model;
  elements["reader-list"].hidden = !model || !model.total;
  if (!model) return;
  elements["reader-list-kicker"].textContent = model.kicker ?? "";
  elements["reader-list-title"].textContent = model.title ?? "";
  elements["reader-list-hint"].textContent = model.hint ?? "";
  elements["reader-list-hint"].hidden = !model.hint;
  const fragment = document.createDocumentFragment();
  model.rows.forEach((row, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reader-list-row";
    button.dataset.index = String(index);
    button.classList.toggle("read", Boolean(row.read));
    if (row.current) button.setAttribute("aria-current", "true");
    button.disabled = Boolean(row.disabled || row.current);
    const title = document.createElement("strong");
    title.textContent = row.title;
    button.append(title);
    if (row.current || row.meta) {
      const meta = document.createElement("span");
      meta.textContent = [row.current ? "지금 읽는 중" : "", row.meta].filter(Boolean).join(" · ");
      button.append(meta);
    }
    item.append(button);
    fragment.append(item);
  });
  elements["reader-list-items"].replaceChildren(fragment);
  const first = model.offset + 1;
  const last = model.offset + model.rows.length;
  elements["reader-list-range"].textContent = `${first.toLocaleString("ko-KR")}–${last.toLocaleString("ko-KR")} / ${model.total.toLocaleString("ko-KR")}`;
  elements["reader-list-previous"].disabled = model.offset <= 0;
  elements["reader-list-next"].disabled = last >= model.total;
  elements["reader-list"].querySelector(".reader-list-pager").hidden = model.total <= model.rows.length;
}

function typeMoonStep(offset, { finished = false } = {}) {
  if (!currentSummary || readerNavigation?.pending) return;
  const target = (offset > 0 ? typeMoonNavigation().next : typeMoonNavigation().previous)?.entry;
  if (!target) return;
  if (finished) markCurrentFinished();
  loadPost(target, "replace");
}

// The Reader was usually opened from this table of contents; go back to it instead of stacking
// another copy. Otherwise the table of contents takes the Reader's place in history.
function openCurrentToc() {
  if (!currentCollection) return;
  const { collection, index } = currentCollection;
  if (history.state?.redstmParent === `/collections/${collection.id}`) {
    history.back();
    return;
  }
  void openCollectionDetail(collection.id, "replace", { focusPosition: collection.entries[index]?.position });
}

function updateTabs() {
  for (const tab of document.querySelectorAll("[data-view]")) {
    const active = tab.dataset.view === currentView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", active);
  }
}

function focusResult(offset) {
  const buttons = [...elements["result-list"].querySelectorAll(".result-item")];
  if (!buttons.length || (isNarrowScreen() && document.body.classList.contains("reader-open"))) return;
  const current = buttons.indexOf(document.activeElement);
  const next = current < 0
    ? (offset > 0 ? 0 : buttons.length - 1)
    : Math.max(0, Math.min(buttons.length - 1, current + offset));
  buttons[next].focus({ preventScroll: false });
}

elements["result-list"].addEventListener("click", (event) => {
  const edit = event.target.closest(".bookmark-edit");
  if (edit) {
    const bookmark = bookmarks.find((entry) => postIdentity(entry.summary) === edit.dataset.identity);
    if (bookmark) openBookmarkEditor(bookmark.summary);
    return;
  }
  const button = event.target.closest(".result-item");
  if (button) {
    if (currentDestination === "text") {
      textLibrary.activate(button);
      return;
    }
    // Picking another row from the side list while reading stays in the same session, so Back
    // still means "the list" rather than "the previously opened row".
    const withinSession = Boolean(history.state?.redstmReader || history.state?.redstmCollection);
    const navigation = withinSession ? "replace" : "push";
    if (!withinSession) persistCatalogState();
    if (button.dataset.collectionId) void openCollectionDetail(Number(button.dataset.collectionId), navigation);
    else loadPost(renderedResults[Number(button.dataset.index)], navigation);
  }
});
// Continue from Home places the work's table of contents under the Reader, so Back walks
// Reader → 목차 → 홈 without flashing the table of contents first.
// Text: the chapter list goes under the chapter so Back walks 본문 → 회차 목록 → 홈.
// A finished chapter resumes at its list, whose 이어 읽기 row offers the next chapter.
function openTextFromHome(target, { listOnly = false } = {}) {
  const home = currentRoute();
  const finished = postReadingState(target.progress) === "finished";
  const novel = target.identity.startsWith("novel:");
  if (!listOnly && finished && novel) {
    // The work list opens and moves straight on to the next chapter (see text-library resume).
    const separator = target.listRoute.includes("?") ? "&" : "?";
    history.pushState({ redstmText: true, redstmParent: home }, "", `${target.listRoute}${separator}resume=next`);
  } else {
    history.pushState({ redstmText: true, redstmParent: home }, "", target.listRoute);
    if (!listOnly) {
      history.pushState({ redstmText: true, redstmReader: true, redstmParent: target.listRoute }, "", target.route);
    }
  }
  void handleRoute();
}

elements["continue-reading"].addEventListener("click", () => {
  if (continueText) return openTextFromHome(continueText);
  if (!continueTargetPost) return;
  if (continueCollectionId) {
    history.pushState({ redstmCollection: true, redstmParent: currentRoute() }, "", `/collections/${continueCollectionId}`);
  }
  loadPost(continueTargetPost, "push", { listHint: continueCollectionId ? "" : "recent" });
});
elements["continue-toc"].addEventListener("click", () => {
  if (continueText) return openTextFromHome(continueText, { listOnly: true });
  if (continueCollectionId) void openCollectionDetail(continueCollectionId);
});
elements["browse-all"].addEventListener("click", () => showDestination("browse"));
elements["reading-works-all"].addEventListener("click", () => showDestination("bookmarks", true, "reading"));
elements["recent-all"].addEventListener("click", () => showDestination("bookmarks", true, "history"));
elements["home-action"].addEventListener("click", () => location.reload());
elements["catalog-toggle"].addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("catalog-collapsed");
  elements["catalog-toggle"].setAttribute("aria-expanded", String(!collapsed));
  elements["catalog-toggle"].ariaLabel = collapsed ? "목록 펼치기" : "목록 접기";
});
for (const [id, command] of [
  ["catalog-back", "list"], ["reader-bottom-list", "list"], ["end-list", "list"],
  ["previous-post", "previous"], ["reader-bottom-previous", "previous"], ["end-previous", "previous"],
  ["next-post", "next"], ["reader-bottom-next", "next"], ["end-next", "end-next"],
  ["end-toc", "toc"], ["collection-context", "toc"],
  ["bookmark-post", "bookmark"], ["reader-top-bookmark", "bookmark"],
  ["reader-settings", "settings"], ["reader-bottom-settings", "settings"], ["reader-bottom-more", "more"], ["reader-toolbar-more", "more"],
]) {
  elements[id].addEventListener("click", () => readerCommand(command));
}
for (const [id, command] of [["more-toc", "toc"], ["more-bookmark", "bookmark"]]) {
  elements[id].addEventListener("click", () => {
    closeReaderMore();
    readerCommand(command);
  });
}
elements["more-note"].addEventListener("click", () => {
  closeReaderMore();
  if (readerSource === "text") openTextBookmarkEditor();
  else if (currentSummary) openBookmarkEditor(currentSummary);
});
elements["more-source"].addEventListener("click", closeReaderMore);
elements["reader-list-items"].addEventListener("click", (event) => {
  const button = event.target.closest(".reader-list-row");
  const row = button && readerListModel?.rows[Number(button.dataset.index)];
  if (row && !button.disabled) readerListModel.onOpen(row);
});
for (const [id, delta] of [["reader-list-previous", -1], ["reader-list-next", 1]]) {
  elements[id].addEventListener("click", () => readerListModel?.onPage(delta));
}
elements["reader-list-all"].addEventListener("click", () => readerCommand("list"));
// Jump within a long body (the inverse of bodyProgress).
elements["more-position"].addEventListener("input", () => {
  const pane = elements["reader-pane"];
  const body = elements["archive-body"];
  const ratio = Number(elements["more-position"].value) / 100;
  const span = body.offsetTop + body.offsetHeight - pane.clientHeight;
  const chapterEnd = document.getElementById("chapter-end");
  // The far end lands on the 다음 화 card rather than the last line behind the toolbar.
  pane.scrollTop = ratio >= 1
    ? chapterEnd.offsetTop - pane.clientHeight / 3
    : ratio * (span > 0 ? span : pane.scrollHeight - pane.clientHeight);
  syncScrollBaseline();
  elements["more-position-output"].value = `${Math.round(ratio * 100)}%`;
});
elements["more-mode"].addEventListener("click", () => {
  closeReaderMore();
  elements["mode-toggle"].click();
});
elements["more-mode-reset"].addEventListener("click", () => {
  closeReaderMore();
  elements["mode-reset"].click();
});
elements["more-immersive"].addEventListener("click", () => {
  closeReaderMore();
  const active = !document.body.classList.contains("immersive");
  setImmersive(active);
  if (active && moreOpener?.isConnected) immersiveOpener = moreOpener;
});
window.addEventListener("popstate", () => { void handleRoute(); });
elements["settings-dialog"].addEventListener("close", () => {
  resetImportReview();
  if (location.pathname !== "/settings") return;
  if (history.state?.redstmSettings) history.back();
  else {
    history.replaceState(null, "", "/");
    showDestination("library", false);
  }
});
elements["search-input"].addEventListener("input", () => {
  elements["result-more"].hidden = true;
  elements["search-clear"].hidden = !elements["search-input"].value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (currentDestination === "text") {
      textLibrary.searchChanged(elements["search-input"].value);
      return;
    }
    syncSearchRoute();
    renderCurrentView();
  }, 250);
});
elements["search-input"].addEventListener("search", () => {
  clearTimeout(searchTimer);
  if (currentDestination === "text") {
    textLibrary.searchChanged(elements["search-input"].value);
    return;
  }
  syncSearchRoute();
  renderCurrentView();
});
elements["search-clear"].addEventListener("click", () => {
  elements["search-input"].value = "";
  elements["search-clear"].hidden = true;
  if (currentDestination === "text") {
    textLibrary.searchChanged("");
    elements["search-input"].focus();
    return;
  }
  syncSearchRoute();
  renderCurrentView();
  elements["search-input"].focus();
});
elements["filter-toggle"].addEventListener("click", openFilterSheet);
elements["filter-reset"].addEventListener("click", () => {
  resetSheetFilterValues();
  applyBoardFilterOptions();
});
elements["filter-apply"].addEventListener("click", applyFilterSheet);
// X, Esc, and system Back discard the draft.
elements["filter-dialog"].addEventListener("close", () => {
  restoreCatalogControls();
  if (!filterDraft) return;
  for (const [id, value] of Object.entries(filterDraft)) elements[id].value = value;
  filterDraft = null;
  updateDestinationLayout();
});
elements["board-dock-button"].addEventListener("click", () => boardNavigator.open());
elements["text-sort-chips"].addEventListener("click", (event) => {
  const chip = event.target.closest("[data-text-sort]");
  if (!chip) return;
  elements["sort-filter"].value = chip.dataset.textSort;
  textLibrary.setSort(chip.dataset.textSort);
  applyTextSortOptions();
  elements["result-list"].scrollTop = 0;
});
elements["board-dock-clear"].addEventListener("click", () => selectBoard(""));
elements["active-filters"].addEventListener("click", (event) => {
  const key = event.target.closest("[data-clear]")?.dataset.clear;
  if (key) clearFilter(key);
});
for (const button of elements["mode-chips"].querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => {
    elements["mode-filter"].value = button.dataset.mode;
    updateDestinationLayout();
    syncSearchRoute();
    renderCurrentView();
  });
}
for (const button of elements["kind-chips"].querySelectorAll("[data-kind]")) {
  button.addEventListener("click", () => {
    elements["collection-kind-filter"].value = button.dataset.kind;
    syncSearchRoute();
    updateDestinationLayout();
    renderCurrentView();
  });
}
elements["search-input"].addEventListener("focus", () => {
  if (currentDestination === "library") showDestination("search");
});
for (const filter of [
  elements["board-filter"], elements["mode-filter"], elements["sort-filter"],
  elements["search-target"], elements["search-match"],
  elements["collection-kind-filter"], elements["collection-read-filter"],
]) {
  filter.addEventListener("change", () => {
    if (currentDestination === "text" && filter === elements["sort-filter"]) {
      textLibrary.setSort(elements["sort-filter"].value);
      return;
    }
    if (filterDraft) return;
    if (filter === elements["mode-filter"]) applyBoardFilterOptions();
    syncSearchRoute();
    renderCurrentView();
  });
}
for (const button of document.querySelectorAll("[data-scope]")) {
  button.addEventListener("click", () => {
    if (button.dataset.scope === currentScope) return;
    setScope(button.dataset.scope);
    showDestination(["browse", "search"].includes(currentDestination) ? currentDestination : "browse");
  });
}
elements["result-more"].addEventListener("click", loadMoreResults);
for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => {
    currentView = tab.dataset.view;
    currentDestination = "bookmarks";
    updateDestinationLayout();
    updateDestinationButtons();
    updateTabs();
    renderCurrentView();
    const path = savedUrl();
    if (`${location.pathname}${location.search}` !== path) {
      history.pushState({ redstmSaved: { ...currentSearchState(), view: currentView } }, "", path);
    }
  });
}
for (const button of document.querySelectorAll("[data-destination]")) {
  button.addEventListener("click", () => {
    // Tapping the tab you are on first returns a scrolled list to its top; at the top it
    // does what it always did.
    if (button.dataset.destination === currentDestination && !readerSource) {
      const scroller = document.body.classList.contains("collection-detail-open") ? elements["reader-pane"] : elements["result-list"];
      if (scroller.scrollTop > 0) {
        scroller.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        return;
      }
    }
    if (["browse", "search"].includes(button.dataset.destination)) setScope("posts");
    showDestination(button.dataset.destination);
  });
}
elements["collection-entry-list"].addEventListener("click", async (event) => {
  const button = event.target.closest(".collection-entry");
  if (!button || button.disabled) return;
  rememberCollectionViewport(button.dataset.position);
  const collection = await loadCollectionDetail(Number(elements["collection-entry-list"].dataset.collectionId));
  const entry = collection?.entries[Number(button.dataset.position) - 1];
  if (entry?.object_key) loadPost(entry);
});
elements["collection-continue"].addEventListener("click", async () => {
  const position = elements["collection-continue"].dataset.position;
  if (elements["collection-continue"].dataset.action === "unread") {
    const target = elements["collection-entry-list"].querySelector(`.collection-entry[data-position="${position}"]`);
    target?.focus({ preventScroll: false });
    target?.scrollIntoView({ block: "center" });
    return;
  }
  rememberCollectionViewport(position);
  const collection = await loadCollectionDetail(Number(elements["collection-entry-list"].dataset.collectionId));
  const entry = collection?.entries[Number(position) - 1];
  if (entry?.object_key) loadPost(entry);
});
// 회차로 이동 finds the row (nearest existing number) without opening it.
elements["collection-jump"].addEventListener("submit", (event) => {
  event.preventDefault();
  const wanted = Number(elements["collection-jump-input"].value);
  const rows = [...elements["collection-entry-list"].querySelectorAll(".collection-entry[data-key]")];
  if (!Number.isInteger(wanted) || !rows.length) return;
  const row = rows.reduce((best, candidate) =>
    Math.abs(Number(candidate.dataset.key) - wanted) < Math.abs(Number(best.dataset.key) - wanted) ? candidate : best);
  const pane = elements["reader-pane"];
  pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 3;
  row.classList.remove("jumped");
  void row.offsetWidth;
  row.classList.add("jumped");
  elements["collection-jump-input"].blur();
  row.focus({ preventScroll: true });
});
elements["collection-back"].addEventListener("click", () => {
  if (history.state?.redstmParent) history.back();
  else {
    history.replaceState(null, "", "/browse?scope=collections");
    setScope("collections");
    showDestination("browse", false);
  }
});
elements["bookmark-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (editingTextBookmark) {
    textLibrary.saveBookmarkDetails(sanitizeBookmarkMetadata(
      elements["bookmark-note"].value,
      elements["bookmark-tags"].value.split(/[,，]/),
    ));
    closeBookmarkEditor();
    return;
  }
  if (!editingBookmarkSummary) return;
  const identity = postIdentity(editingBookmarkSummary);
  const metadata = sanitizeBookmarkMetadata(
    elements["bookmark-note"].value,
    elements["bookmark-tags"].value.split(/[,，]/),
  );
  const existing = bookmarks.find((entry) => postIdentity(entry.summary) === identity);
  const updated = {
    summary: existing?.summary ?? editingBookmarkSummary,
    savedAt: existing?.savedAt ?? new Date().toISOString(),
    ...metadata,
  };
  bookmarks = existing
    ? bookmarks.map((entry) => postIdentity(entry.summary) === identity ? updated : entry)
    : [updated, ...bookmarks];
  persistUserState();
  closeBookmarkEditor();
  renderAfterBookmarkChange();
});
elements["bookmark-remove"].addEventListener("click", () => {
  if (editingTextBookmark) {
    textLibrary.removeBookmark();
    closeBookmarkEditor();
    return;
  }
  const identity = postIdentity(editingBookmarkSummary);
  bookmarks = bookmarks.filter((entry) => postIdentity(entry.summary) !== identity);
  persistUserState();
  closeBookmarkEditor();
  renderAfterBookmarkChange();
});
for (const button of document.querySelectorAll("[data-bookmark-close]")) {
  button.addEventListener("click", closeBookmarkEditor);
}
elements["bookmark-dialog"].addEventListener("cancel", () => { editingBookmarkSummary = null; });
// Inline images and image links open a full-screen viewer; Back or 닫기 returns to the text.
elements["archive-body"].addEventListener("click", (event) => {
  if (currentMode === "aa") return;
  const trigger = event.target.closest(".media-open, a[data-image], img");
  if (!trigger || !elements["archive-body"].contains(trigger)) return;
  const href = trigger.dataset.image ?? trigger.querySelector?.("img")?.src ?? trigger.src;
  if (!href) return;
  event.preventDefault();
  openImageViewer(href);
});
elements["image-viewer"].addEventListener("close", () => elements["image-viewer-image"].removeAttribute("src"));
elements["image-viewer"].addEventListener("click", (event) => {
  if (event.target === elements["image-viewer"]) elements["image-viewer"].close();
});
// Reading chrome (docs/19 §4.3): reading downward folds the top and bottom bars away on every
// screen width; a still tap toggles them, a deliberate scroll back up or reaching the end of
// the body brings them back. Reduced motion only drops the slide animation (CSS).
const CHROME_HIDE_AFTER = 48;
const CHROME_SHOW_AFTER = 96;

function setReaderChromeHidden(hidden) {
  document.body.classList.toggle("reader-controls-hidden", hidden);
  readerScrollDelta = 0;
}

function readerAtEnd() {
  const end = document.getElementById("chapter-end");
  if (!end || end.hidden) return false;
  return end.getBoundingClientRect().top < elements["reader-pane"].getBoundingClientRect().bottom - 48;
}

elements["reader-pane"].addEventListener("scroll", () => {
  queueScrollSave();
  updateReadingProgress();
  const current = elements["reader-pane"].scrollTop;
  const delta = current - lastReaderScroll;
  lastReaderScroll = current;
  if (!document.body.classList.contains("reader-open")) return;
  if (current < 80 || readerAtEnd()) {
    setReaderChromeHidden(false);
    return;
  }
  if (!delta) return;
  readerScrollDelta = Math.sign(readerScrollDelta) === Math.sign(delta) ? readerScrollDelta + delta : delta;
  if (readerScrollDelta >= CHROME_HIDE_AFTER) setReaderChromeHidden(true);
  else if (readerScrollDelta <= -CHROME_SHOW_AFTER) setReaderChromeHidden(false);
}, { passive: true });
// A short, still touch on the text toggles the bars. Scroll flings end in pointercancel or move
// the pane, so they are not mistaken for taps. A mouse click is left to text selection; the
// mouse brings the bars back by moving to the top edge instead.
elements["reader-pane"].addEventListener("pointerdown", (event) => {
  pointerStart = event.isPrimary
    ? { x: event.clientX, y: event.clientY, time: event.timeStamp, scroll: elements["reader-pane"].scrollTop }
    : null;
}, { passive: true });
elements["reader-pane"].addEventListener("pointercancel", () => { pointerStart = null; }, { passive: true });
elements["reader-pane"].addEventListener("pointerup", (event) => {
  const start = pointerStart;
  pointerStart = null;
  if (!start || event.pointerType === "mouse" || !document.body.classList.contains("reader-open")) return;
  if (event.target.closest("a, button, input, select, textarea, label, summary, img, [role='button'], .media-figure, .chapter-end, .reader-list, .reader-topbar, .reader-toolbar")) return;
  const still = Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10 &&
    event.timeStamp - start.time <= 500 &&
    Math.abs(elements["reader-pane"].scrollTop - start.scroll) <= 4;
  if (!still || String(getSelection() ?? "")) return;
  setReaderChromeHidden(!document.body.classList.contains("reader-controls-hidden"));
});
elements["reader-pane"].addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse" || !document.body.classList.contains("reader-controls-hidden")) return;
  if (event.clientY - elements["reader-pane"].getBoundingClientRect().top < 64) setReaderChromeHidden(false);
}, { passive: true });

elements["theme-toggle"].addEventListener("click", () => {
  settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  saveSettings();
});
for (const choice of elements["theme-choices"].querySelectorAll("[data-theme-choice]")) {
  choice.addEventListener("click", () => {
    settings.theme = choice.dataset.themeChoice;
    saveSettings();
  });
}
elements["immersive-exit"].addEventListener("click", () => setImmersive(false));
elements["immersive-toggle"].addEventListener("click", () => setImmersive(!document.body.classList.contains("immersive")));
elements["mode-toggle"].addEventListener("click", () => {
  if (!currentPayload) return;
  const identity = `${currentSummary.board_id}:${currentSummary.external_post_id}`;
  settings.viewModes[identity] = currentMode === "aa" ? "prose" : "aa";
  persistUserState();
  renderPostBody();
});
elements["mode-reset"].addEventListener("click", () => {
  if (!currentPayload) return;
  delete settings.viewModes[`${currentSummary.board_id}:${currentSummary.external_post_id}`];
  persistUserState();
  renderPostBody();
});
// Typography changes keep the sentence at the top of the screen in place instead of the pixel
// offset, which would land somewhere else once lines reflow.
function changeTypography(mutate) {
  const keepAnchor = readerSource && currentMode === "prose";
  const anchor = keepAnchor ? captureTextAnchor(elements["archive-body"], elements["reader-pane"], readerTopInset()) : null;
  mutate();
  saveSettings();
  if (anchor) {
    restoreTextAnchor(elements["archive-body"], elements["reader-pane"], anchor, readerTopInset());
    syncScrollBaseline();
  }
}
for (const [id, key] of [["prose-size", "proseSize"], ["line-height", "lineHeight"], ["prose-width", "proseWidth"], ["prose-margin", "proseMargin"], ["aa-size", "aaSize"]]) {
  elements[id].addEventListener("input", () => changeTypography(() => {
    settings[key] = Number(elements[id].value);
  }));
}
for (const button of document.querySelectorAll("[data-prose-size-delta]")) {
  button.addEventListener("click", () => changeTypography(() => {
    const min = Number(elements["prose-size"].min);
    const max = Number(elements["prose-size"].max);
    settings.proseSize = Math.max(min, Math.min(max, settings.proseSize + Number(button.dataset.proseSizeDelta)));
  }));
}
elements["prose-font"].addEventListener("change", () => changeTypography(() => {
  settings.proseFont = elements["prose-font"].value;
}));
for (const button of document.querySelectorAll("[data-aa-size-delta]")) {
  button.addEventListener("click", () => {
    settings.aaSize = Math.max(9, Math.min(24, settings.aaSize + Number(button.dataset.aaSizeDelta)));
    saveSettings();
  });
}
for (const button of document.querySelectorAll("[data-aa-preset]")) {
  button.addEventListener("click", () => {
    const [size, width] = button.dataset.aaPreset.split(":");
    settings = { ...settings, aaSize: Number(size), aaCanvasWidth: width === "auto" ? null : Number(width), aaZoom: 1 };
    saveSettings();
    showZoomFeedback();
  });
}
for (const button of document.querySelectorAll("[data-aa-zoom-delta]")) {
  button.addEventListener("click", () => setAaZoom(settings.aaZoom + Number(button.dataset.aaZoomDelta)));
}
elements["aa-zoom-reset"].addEventListener("click", () => setAaZoom(1));
elements["aa-source-styles"].addEventListener("click", () => {
  settings.aaPreserveStyles = !settings.aaPreserveStyles;
  saveSettings();
});
for (const button of document.querySelectorAll("[data-aa-background]")) {
  button.addEventListener("click", () => {
    settings.aaBackground = button.dataset.aaBackground;
    saveSettings();
  });
}
elements["aa-background"].addEventListener("input", () => {
  settings.aaBackground = elements["aa-background"].value;
  saveSettings();
});
elements["archive-body"].addEventListener("touchstart", (event) => {
  if (currentMode === "aa" && event.touches.length === 2) pinchDistance = touchDistance(event);
}, { passive: true });
elements["archive-body"].addEventListener("touchmove", (event) => {
  if (currentMode !== "aa" || event.touches.length !== 2 || !pinchDistance) return;
  const distance = touchDistance(event);
  const next = settings.aaZoom + (distance - pinchDistance) * 0.003;
  if (Math.abs(next - settings.aaZoom) > 0.002) setAaZoom(next, true);
  pinchDistance = distance;
}, { passive: true });
elements["archive-body"].addEventListener("touchend", () => { pinchDistance = 0; }, { passive: true });
elements["archive-body"].addEventListener("dblclick", () => {
  if (currentMode !== "aa") return;
  setAaZoom(settings.aaZoom < 1.25 ? 1.5 : settings.aaZoom < 1.75 ? 2 : 1);
});
elements["archive-body"].addEventListener("scroll", () => updateAaOverflowCue(), { passive: true });
function touchDistance(event) {
  return Math.hypot(
    event.touches[0].clientX - event.touches[1].clientX,
    event.touches[0].clientY - event.touches[1].clientY,
  );
}
elements["reset-settings"].addEventListener("click", () => {
  settings = { ...defaultSettings, viewModes: {} };
  saveSettings();
});
elements["export-state"].addEventListener("click", () => {
  persistUserState();
  const blob = new Blob([exportUserState(userState)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `redstm-state-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});
function resetImportReview() {
  pendingImportPlan = null;
  elements["import-review"].hidden = true;
  elements["import-review"].removeAttribute("data-state");
  elements["import-apply"].disabled = false;
  elements["import-apply"].hidden = false;
  elements["import-cancel"].textContent = "취소";
  elements["import-state-file"].value = "";
}

elements["import-state"].addEventListener("click", () => {
  resetImportReview();
  elements["import-state-file"].click();
});
elements["import-state-file"].addEventListener("change", async () => {
  const [file] = elements["import-state-file"].files;
  if (!file) return;
  try {
    if (file.size > 1_048_576) throw new Error("상태 파일은 1MB 이하여야 합니다");
    pendingImportPlan = planImport(await file.text(), defaultSettings);
    const summary = pendingImportPlan.summary;
    const defaulted = summary.defaultedSettings.length
      ? ` · 기본값 보정 ${summary.defaultedSettings.map((key) => settingLabels[key] ?? key).join(", ")}` : "";
    elements["import-review-summary"].textContent =
      `읽기 ${summary.history} · 저장 ${summary.bookmarks} · 위치 ${summary.scroll} · 보기 ${summary.viewModes}${defaulted}`;
    elements["import-review"].dataset.state = "ready";
    elements["import-review"].hidden = false;
    elements["import-apply"].focus();
  } catch (error) {
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = error.message;
    elements["import-review"].dataset.state = "error";
    elements["import-review"].hidden = false;
    elements["import-apply"].disabled = true;
  } finally {
    elements["import-state-file"].value = "";
  }
});
elements["import-cancel"].addEventListener("click", resetImportReview);
elements["import-apply"].addEventListener("click", async () => {
  if (!pendingImportPlan) return;
  elements["import-apply"].disabled = true;
  try {
    applyUserState(pendingImportPlan.state);
    persistUserState();
    await hydrateSavedEntries();
    applySettings();
    renderCurrentView();
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = "사용자 상태를 가져왔습니다";
    elements["import-review"].dataset.state = "success";
    elements["import-apply"].hidden = true;
    elements["import-cancel"].textContent = "닫기";
    elements["import-cancel"].focus();
  } catch (error) {
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = error.message;
    elements["import-review"].dataset.state = "error";
    elements["import-apply"].disabled = true;
  }
});

document.addEventListener("keydown", (event) => {
  const catalogArrow = event.target === elements["search-input"] || event.target.closest(".result-item");
  if (catalogArrow && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    focusResult(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Escape" && document.body.classList.contains("immersive")) {
    setImmersive(false);
    return;
  }
  if (event.target.closest("input, select, textarea, button, [contenteditable]")) return;
  if (event.key === "/") {
    event.preventDefault();
    showDestination("search");
    elements["search-input"].focus();
  } else if (event.key === "[" || (event.key === "ArrowLeft" && readerSource && currentMode !== "aa" && !event.altKey)) {
    readerCommand("previous");
  } else if (event.key === "]" || (event.key === "ArrowRight" && readerSource && currentMode !== "aa" && !event.altKey)) {
    readerCommand("next");
  } else if (event.key.toLowerCase() === "b") {
    readerCommand("bookmark");
  } else if (event.key.toLowerCase() === "f" && readerSource) {
    setImmersive(!document.body.classList.contains("immersive"));
  }
});
document.addEventListener("focusin", () => document.body.classList.remove("reader-controls-hidden"));

history.scrollRestoration = "manual";
window.addEventListener("offline", () => {
  elements["archive-state"].textContent = "오프라인";
  if (!archiveReady) renderArchiveError({ code: "offline" });
});
window.addEventListener("online", () => {
  if (archiveReady) elements["archive-state"].textContent = "보존본";
});
function flushLifecycleState() {
  if (currentSummary) persistReadingPosition();
  else if (readerSource === "text" || currentDestination === "text") textLibrary.flush();
  else persistCatalogState();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushLifecycleState();
});
window.addEventListener("pagehide", flushLifecycleState);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});
// Pinch zoom also shrinks the visual viewport; only a focused text field means a keyboard.
function updateKeyboardState() {
  const editing = document.activeElement?.matches?.("input:not([type='range'], [type='color'], [type='file']), textarea, [contenteditable]");
  const shrunk = window.visualViewport ? window.visualViewport.height < innerHeight * 0.75 : false;
  document.body.classList.toggle("keyboard-open", Boolean(editing && shrunk));
}
window.visualViewport?.addEventListener("resize", updateKeyboardState);
document.addEventListener("focusout", () => requestAnimationFrame(updateKeyboardState));
matchMedia("(max-width: 759px)").addEventListener("change", applySettings);
// Late web fonts can reflow the body; re-apply the saved position only if the reader has not
// started scrolling in the meantime.
document.fonts.ready.then(() => {
  if (currentSummary && restoredScroll !== null && Math.abs(elements["reader-pane"].scrollTop - restoredScroll) < 2) {
    restoreReadingPosition(currentSummary);
  }
});
applySettings();
// Text archive routes do not depend on the TypeMoon search index; start them immediately.
if (location.pathname === "/text") void handleRoute();
