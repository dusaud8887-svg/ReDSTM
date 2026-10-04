import {
  STATE_KEY,
  defaultUserState,
  exportUserState,
  mergeAnnotationRecords,
  mergeSessionRecords,
  mergeTextStates,
  mergeUserStates,
  migrateLegacyState,
  PROFILE_KEYS,
  planImport,
  postIdentity,
  readingLocationFields,
  sanitizeBookmarkMetadata,
  samePost,
  serializeUserState,
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
  readingMinutes,
  readingTimeLabel,
  remainingTimeLabel,
  weightedPicks,
  lastSentenceQuote,
} from "/reading-model.js";
import { createBoardNavigator } from "/board-navigator.js";
import {
  applyArchivedMedia, arcaPaths, decorateImages, enhanceHtmlMedia, renderPlainTextWithMedia,
} from "/media.js";
import { captureListAnchor, loadListPosition, restoreListAnchor, saveListPosition } from "/list-anchor.js";
import { adjacentInSequence } from "/sequence.js";
import { createTextLibrary } from "/text-library.js";
import { createDocumentSession, createScrollAdapter } from "/reader-session.js";
import { createOverlayManager } from "/overlay-manager.js";
import { applyAppearance, syncThemeColor as syncBrowserThemeColor } from "/theme.js";
import { createHeaderFold, createMiniBar } from "/shell.js";
import { excerptOfTheDay, fillContinueCard, fillWeekBars, shelfCard } from "/home.js";
import { workHue, workKey } from "/type-cover.js";
import { fillWorkCover, savedMark, showWorkBarcode } from "/work-header.js";
import { createSuggester, createSuggestIndex } from "/search-suggest.js";
import { createFind } from "/find.js";
import { createPersonalLibrary, mergeLibrary, mergeWorkStyles, sanitizeLibrary, sanitizeWorkStyle } from "/library.js";
import { createKwic } from "/kwic.js";
import { arcaliveBody, novelBody } from "/text-work.js";
import { renderChapterRun } from "/reader-chrome.js";
import { openGallery } from "/gallery.js";
import { annotationAt, annotationRecord, documentAnnotations, excerptList, excerptsMarkdown, MARK_PRIORITY, placeAnnotations, selectionOffsets, tombstone, withNote } from "/annotations.js";
import { openStore } from "/store.js";
import { featureEnabled } from "/capabilities.js";
import { createOffline, deleteNamespace } from "/offline.js";
import { CREDIT, canvasBlob, drawAaScene, drawExcerptCard, drawStatsCard } from "/share-canvas.js";
import { charactersRead, closeSpans, dailyReading, extendSpans, finishedWorks, localDay, minutesLabel, monthCells, readingStreak, unionLength, weekSummary, workReading } from "/stats.js";
import { createLocator, createTextModel, decodeLocator, encodeLocator, modelOffset, modelPosition } from "/text-model.js";
import { renderSVG } from "/vendor/uqr@0.1.3/uqr.js";
import { autoUpdate, computePosition, flip, hide, inline, offset, shift } from "/vendor/floating-ui-dom@1.8.0/floating-ui.js";
import { clampAaZoom, createTapJudge, fitAaZoomValue, isSceneHeader, minimapScroll, minimapWindow, pinchAaZoom, sceneAt, sceneTarget, sceneY, scrollKeepingPoint } from "/aa-viewer.js";
import { anchorLeft, capturePagedAnchor, pageAt, pageCount, pageGeometry, swipeTarget } from "/reader-modes.js";
import { createContinuousReader } from "/continuous-reader.js";
import UFuzzy from "/vendor/leeoniya-ufuzzy@1.0.19/ufuzzy.js";
import { DragGesture, PinchGesture } from "/vendor/use-gesture-vanilla@10.3.1/use-gesture.js";
import * as hangul from "/vendor/es-hangul@2.4.0/es-hangul.js";

const readerSession = createDocumentSession();
let personalLibrary = null;
let fontGeneration = 0;

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
  theme: "system", readerSurface: "default", readerDim: 0, readerWarm: 0, paragraphSpacing: 0.95, textIndent: 0, homeQuote: "on", readingMode: "scroll", proseSize: 18, lineHeight: 1.8, proseWidth: 760, proseMargin: 20,
  proseFont: "serif", proseAlign: "start", tapPaging: "off", aaAutoFit: "off", aaSize: 16, aaZoom: 1, aaCanvasWidth: null, aaBackground: "#f5f5f0", aaPreserveStyles: true, aaBold: false,
  viewModes: {},
};
const settingLabels = {
  theme: "테마", proseSize: "본문 크기", lineHeight: "줄 간격", proseWidth: "본문 너비", proseMargin: "좌우 여백",
  proseFont: "본문 서체", proseAlign: "문단 정렬", readerSurface: "본문 면", readerDim: "밝기", readerWarm: "따뜻하게", paragraphSpacing: "문단 간격", textIndent: "들여쓰기", homeQuote: "마지막 문장", readingMode: "읽기 방식", tapPaging: "화면 탭으로 넘기기", aaAutoFit: "넓은 AA 맞추기", aaSize: "AA 크기", aaZoom: "AA 확대", aaCanvasWidth: "AA 폭",
  aaBackground: "AA 배경", aaPreserveStyles: "AA 원본색", aaBold: "AA 굵게",
};
const elements = Object.fromEntries(
  [
    "archive-count", "archive-state", "search-input", "search-target", "search-match", "board-filter", "mode-filter", "sort-filter", "collection-kind-filter", "collection-read-filter", "result-bar", "result-status", "result-list", "result-more",
    "reader-pane", "empty-reader", "empty-count", "reader", "reader-kicker", "reader-title", "reader-meta", "collection-context",
    "scope-tabs", "source-switch", "search-suggest", "collection-view", "collection-back", "collection-title", "collection-meta", "collection-continue", "collection-entry-list",
    "archive-body", "page-hint", "comments", "comment-count", "comment-list", "comments-toggle", "end-comments", "end-comments-count", "previous-post", "next-post", "previous-post-label", "next-post-label", "bookmark-post", "source-link",
    "reader-topbar-title", "reader-top-bookmark", "chapter-end-note", "end-next-kicker", "end-previous-kicker", "end-list", "end-toc",
    "theme-toggle", "reader-settings", "settings-dialog", "prose-size", "line-height", "prose-width", "prose-margin", "aa-size",
    "prose-size-output", "line-height-output", "prose-width-output", "prose-margin-output", "aa-size-output", "reset-settings",
    "reader-dim", "reader-dim-output", "reader-warm", "reader-warm-output",
    "paragraph-spacing", "paragraph-spacing-output", "text-indent", "text-indent-output",
    "export-state", "import-state", "import-state-file", "continue-reading", "continue-title", "continue-work",
    "continue-meta", "continue-block", "continue-toc", "continue-cover", "continue-quote", "continue-when", "home-onboarding", "catalog-back", "prose-font", "aa-controls", "aa-scenes", "aa-scene-previous", "aa-scene-output", "aa-scene-next",
    "catalog-search-row", "catalog-toolbar", "catalog-controls", "filter-toggle", "active-filters", "search-clear",
    "mode-chips", "kind-chips", "category-chips",
    "search-empty", "search-empty-copy", "search-widen", "recent-queries", "reading-works", "reading-works-list", "reading-works-all",
    "recent-all", "filter-dialog", "filter-dialog-fields", "filter-reset", "filter-apply",
    "board-dock", "board-dock-button", "board-dock-group", "board-dock-name", "board-dock-clear", "board-dialog", "board-panel", "board-search",
    "autoscroll-bar", "offline-works", "offline-works-list", "other-account", "auth-dialog", "collection-offline", "offline-save", "offline-state", "offline-delete", "offline-storage", "excerpts-export", "stats-panel", "stats-ring", "stats-today", "stats-streak", "stats-finished", "stats-chars", "stats-month-title", "stats-heat", "stats-share",
    "home-excerpt", "home-excerpt-list", "home-week", "home-week-total", "home-week-bars", "share-dialog", "share-preview", "share-tones", "share-credit", "share-send", "share-download", "share-status", "selection-menu", "mark-menu", "mark-menu-note", "mark-note", "note-dialog", "note-form", "note-quote", "note-text", "selection-more", "selection-more-quote", "selection-namu",
    "image-viewer", "image-viewer-stage", "image-viewer-share", "image-viewer-source",
    "collection-jump", "collection-jump-input",
    "reader-topbar-progress", "more-position", "more-position-output", "more-remaining", "reader-length",
    "more-link", "more-wake", "image-viewer-zoom", "install-app",
    "text-sort-chips",
    "reader-list", "reader-list-kicker", "reader-list-title", "reader-list-all", "reader-list-hint",
    "reader-list-items", "reader-list-previous", "reader-list-next", "reader-list-range",
    "aa-source-styles", "aa-color", "aa-bold", "aa-background", "aa-zoom-output", "aa-zoom-reset", "aa-zoom-indicator", "aa-fit", "aa-host", "aa-fullscreen", "aa-minimap",
    "reading-progress", "reader-status", "immersive-toggle", "end-previous", "end-next",
    "end-previous-title", "end-next-title", "mode-toggle", "mode-reset", "theme-choices",
    "home-title", "home-freshness", "latest-list", "recent-list", "browse-all",
    "discover", "discover-shuffle", "discover-picks-group", "discover-picks", "discover-hot-group", "discover-hot",
    "discover-day-group", "discover-day-title", "discover-day",
    "reader-bottom-list", "reader-bottom-previous", "reader-bottom-next", "reader-bottom-settings", "reader-bottom-more", "reader-toolbar-more",
    "reader-bottom-previous-label", "reader-bottom-next-label",
    "reader-more", "reader-more-context", "more-mark-read", "more-mark-read-label", "more-toc", "more-bookmark", "more-bookmark-label", "more-note", "more-source",
    "more-mode", "more-mode-label", "more-mode-reset", "more-immersive", "more-immersive-label",
    "catalog-toggle", "catalog-title", "catalog-subtitle", "home-action", "immersive-exit", "import-review", "import-review-summary", "import-apply", "import-merge", "import-cancel",
    "bookmark-dialog", "bookmark-form", "bookmark-dialog-post", "bookmark-note", "bookmark-tags", "bookmark-remove",
  ].map((id) => [id, document.getElementById(id)]),
);
elements["result-list"].classList.add("loading");
const overlays = createOverlayManager();
for (const dialog of document.querySelectorAll("dialog")) overlays.watch(dialog);
overlays.watchFullscreen(document);

const RESULT_PAGE_SIZE = 100;

let userState = loadUserState();
// What this tab last wrote to localStorage, to tell another tab's save from our own echo.
let lastStoredState = null;
// P6-6 reading state copies in the owner's idb (mirrorState, restoreMirroredStates).
const TEXT_STATE_KEY = "redstm.textState.v1";
const mirrorQueue = new Map();
let statesRestored = null;
// P6-8 AA scene moves (findAaScenes).
let aaScenes = [];
let aaSceneFrame = 0;
let settings;
let historyEntries;
// Per-post AA zoom and sideways position (see effectiveAaZoom).
let aaViews = {};
let aaAutoZoom = null;
let aaLeftTimer;
let bookmarks;
applyUserState(userState);
let renderedResults = [];
let resultCountText = "";
// About 1MB of saved state; far above any e2e or real reading pattern that needs older marks.
const HISTORY_LIMIT = 10_000;
let currentSummary = null;
let currentPayload = null;
let currentMode = "prose";
let currentCollection = null;
let collectionPending = false;
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
// Whether the release carries view/comment counts for posts (search index) and works.
let searchStats = false;
let collectionStats = false;
let pendingSort = null;
// Settles once saved history/bookmarks are resolved against the current index.
let savedEntriesReady = Promise.resolve();
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
let readerMinutes = 0;
// 다른 추천 presses today; each one draws a new set of picks.
let discoverShuffle = 0;
// Screen wake lock sentinel and whether the reader asked to keep the screen on.
let wakeLock = null;
let wakeWanted = false;
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
let lastPointerType = "";
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
    workSearch: () => void openWorkSearch(),
    classifyWork: (work) => personalLibrary.openWork(work),
    captureAnchor: captureReaderPosition,
    readingPosition: () => readingPosition(),
    canSavePosition: () => readerSession.canSave,
    keepContinuousPosition: () => continuous.transitioning,
    cancelPendingWork: () => readerSession.cancelPendingWork(),
    mirrorState: (raw) => mirrorState(TEXT_STATE_KEY, raw),
    trackPendingWork: (cancel) => readerSession.track(cancel),
    scheduleFrame: (callback) => readerSession.frame(callback),
    restoreAnchor: (anchor) => {
      if (!readerSession.restore(anchor) && anchor.loc) showReaderFeedback("읽던 문장을 찾지 못했습니다", 2200);
      syncScrollBaseline();
    },
  },
  onChange: () => {
    updateShellMode();
    if (currentDestination === "text") applyTextSortOptions();
  },
});

let readerDocument = null;
let continuousPreview = null;
const continuous = createContinuousReader({
  body: elements["archive-body"], scroller: elements["reader-pane"], enabled: continuousEnabled, topInset: readerTopInset,
  step: (direction) => readerSource === "text" ? textLibrary.command(direction > 0 ? "end-next" : "previous") : typeMoonStep(direction, { finished: direction > 0 }),
  onError: () => showReaderFeedback("다음 회차를 잇지 못했어요 · 다시 시도해 주세요", 2400),
});
function continuousEnabled() {
  return settings.readingMode === "continuous" && Boolean(readerSource) && currentMode !== "aa" &&
    Boolean(readerNavigation?.hasToc || (readerNavigation?.pending && readerDocument?.workId?.startsWith("typemoon:collection:")));
}
function captureReaderPosition() {
  const anchor = readerSession.capture();
  if (anchor || !readerSession.canSave || !continuousEnabled()) return anchor;
  // A fling can pass the last line before the boundary switch runs. Save this document's
  // original end, rather than attaching the next document's text to its reading record.
  const body = elements["archive-body"];
  const model = createTextModel(body);
  if (!model.text.length) return null;
  const start = Math.max(0, model.text.length - 48);
  const position = modelPosition(model, start);
  const range = document.createRange(); range.selectNodeContents(body); range.setEnd(position.node, position.offset);
  const offset = range.toString().length;
  return { offset, quote: body.textContent.slice(offset, offset + 48), viewportOffset: 0, atStart: false,
    loc: createLocator(model, start, model.text.length, readerSession.rev) };
}
function refreshContinuous() {
  const enabled = continuousEnabled();
  document.body.classList.toggle("continuous-mode", enabled);
  if (!enabled) { continuous.reset(); continuousPreview = null; return; }
  if (!readerDocument || readerSession.documentKey !== readerDocument.key || readerNavigation.pending) return;
  readerDocument.workId = readerSession.workId || readerDocument.workId;
  if (continuous.currentKey !== readerDocument.key) continuous.commit(readerDocument);
  const next = readerNavigation.next;
  if (!next?.prefetch || next.entry?.is_aa) return;
  const key = next.documentId || `typemoon:${postIdentity(next.entry)}`;
  const generation = readerSession.generation;
  if (continuousPreview?.key === key && continuousPreview.generation === generation) return;
  continuousPreview = { key, generation };
  void (async () => {
    const response = await fetch(next.prefetch, { credentials: "same-origin", redirect: "error", signal: readerSession.signal });
    requireArchiveResponse(response, `다음 회차 응답 ${response.status}`);
    const node = document.createElement("div"); node.className = elements["archive-body"].className;
    if (next.sourceLane) {
      const raw = await response.text();
      const parsed = next.sourceLane === "manual" ? { text: raw, sourceUrl: "" } : next.sourceLane === "novel" ? novelBody(raw) : arcaliveBody(raw);
      renderPlainTextWithMedia(node, parsed.text, { sourceUrl: parsed.sourceUrl });
    } else {
      const payload = await response.json();
      if (payload.schema_version !== 1 || !payload.post?.body_html || payload.post.is_aa) return;
      node.innerHTML = payload.post.body_html;
      normalizeReaderTypography(node); decorateImages(node); enhanceHtmlMedia(node);
    }
    if (generation !== readerSession.generation || !continuousEnabled()) return;
    continuous.offer({ key, title: next.title, workId: readerSession.workId }, node);
  })().catch((error) => {
    if (error.name !== "AbortError" && generation === readerSession.generation) showReaderFeedback("다음 회차를 잇지 못했어요 · 다음 버튼으로 다시 열 수 있어요", 2400);
  });
}

// Find in the chapter (docs/24 §8.11): the bar takes the dock's place and, after moving through
// hits, closing it offers the place the reader was before.
const find = createFind({
  bar: document.querySelector("#find-bar"),
  input: document.querySelector("#find-input"),
  count: document.querySelector("#find-count"),
  band: document.querySelector("#find-band"),
  root: () => elements["archive-body"],
  scroller: elements["reader-pane"],
  topInset: () => readerTopInset(),
  overlays,
  session: {
    get generation() { return readerSession.generation; },
    markUserScroll: () => readerSession.markUserScroll(),
    capturePosition: () => readerSession.adapter?.captureVisiblePosition() ?? null,
  },
});
let findReturnTimer = null;
let findReturnAnchor = null;
function openFind() {
  pauseAutoScroll();
  if (!readerSource) return;
  find.open((anchor) => {
    if (!anchor) return;
    findReturnAnchor = anchor;
    rememberReturn(anchor, "검색 전 위치");
    const toast = document.querySelector("#find-return");
    overlays.showToast(toast);
    clearTimeout(findReturnTimer);
    findReturnTimer = setTimeout(() => overlays.hideToast(toast), 4000);
  });
}
for (const id of ["reader-find", "reader-toolbar-find"]) document.querySelector(`#${id}`).addEventListener("click", openFind);
document.querySelector("#more-find").addEventListener("click", () => {
  elements["reader-more"].close();
  openFind();
});
document.querySelector("#find-next").addEventListener("click", () => find.next());
document.querySelector("#find-previous").addEventListener("click", () => find.previous());
document.querySelector("#find-close").addEventListener("click", () => find.close());
document.querySelector("#find-return-button").addEventListener("click", () => {
  overlays.hideToast(document.querySelector("#find-return"));
  if (findReturnAnchor && readerSession.restore(findReturnAnchor)) syncScrollBaseline();
  findReturnAnchor = null;
});

const miniBar = createMiniBar({ element: document.querySelector("#mini-bar"), homeCard: elements["continue-block"] });
const headerFold = createHeaderFold({
  catalog: document.querySelector(".catalog"), list: elements["result-list"],
  active: () => isNarrowScreen() && ["browse", "search", "text"].includes(currentDestination) && !document.body.classList.contains("reading"),
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
// A Worker that fails to load or cannot read a message never answers; settle what waits on it.
for (const type of ["error", "messageerror"]) {
  searchWorker.addEventListener(type, () => {
    for (const { reject } of workerRequests.values()) reject(Object.assign(new Error("검색 색인을 사용할 수 없습니다"), { code: "worker_failed" }));
    workerRequests.clear();
  });
}
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
        ...(timestampKey === "readAt" ? { scroll: userState.scroll[identity] ?? 0, progress: value.progress ?? 0, ...readingLocationFields(value) } : {}),
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
  aaViews = { ...(state.aaViews ?? {}) };
}

// 고운바탕 is fetched only once someone picks it (DESIGN §10: an unchosen font is not downloaded).
function proseFontStack() {
  if (settings.proseFont === "sans") return "var(--font-ui)";
  if (settings.proseFont !== "gowun") return "var(--font-reading)";
  if (!document.querySelector("#gowun-batang-css")) {
    const link = Object.assign(document.createElement("link"), { id: "gowun-batang-css", rel: "stylesheet", href: "/fonts/gowun-batang@5.3.0/gowun-batang.css" });
    document.head.append(link);
  }
  return "var(--font-reading-alt)";
}

// The idle archive label; a failing local save stays visible over later "loaded" updates.
function readyLabel() {
  return elements["archive-state"].dataset.storageFailed ? "로컬 저장 실패" : "보존본";
}

function persistUserState() {
  const { viewModes, ...current } = settings;
  // While a work's own profile is on (이 작품만), the user's base reading settings are what is kept.
  const savedSettings = { ...current, ...(workProfileBase ?? {}) };
  userState = {
    schema_version: 2,
    settings: savedSettings,
    history: Object.fromEntries(historyEntries.map((entry) => [
      postIdentity(entry.summary), { readAt: entry.readAt, progress: entry.progress ?? 0, ...readingLocationFields(entry) },
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
    aaViews,
    lastCatalogState: userState.lastCatalogState,
  };
  let serialized;
  try {
    serialized = serializeUserState(userState);
    localStorage.setItem(STATE_KEY, serialized);
    lastStoredState = serialized;
    for (const key of Object.values(storageKeys)) localStorage.removeItem(key);
    // A save that works again clears an earlier failure notice.
    delete elements["archive-state"].dataset.storageFailed;
    if (elements["archive-state"].textContent === "로컬 저장 실패" && archiveReady) {
      elements["archive-state"].textContent = readyLabel();
    }
  } catch (error) {
    elements["archive-state"].dataset.storageFailed = "true";
    elements["archive-state"].textContent = "로컬 저장 실패";
    console.warn("Reader state could not be saved", error);
  }
  if (serialized) mirrorState(STATE_KEY, serialized);
}

// Another tab saved reading state. Every save writes the whole state, so a tab that kept its old
// copy would erase the other tab's new bookmarks and history on its next scroll save. Adopt the
// newer copy instead (settings included), then re-resolve records against the index.
function adoptStoredState(serialized) {
  if (!serialized || serialized === lastStoredState) return;
  let incoming;
  try {
    incoming = planImport(serialized, defaultSettings).state;
  } catch {
    return;
  }
  lastStoredState = serialized;
  applyUserState(incoming);
  applySettings();
  if (currentSummary && !historyEntries.some((entry) => samePost(entry.summary, currentSummary))) {
    rememberHistory(currentSummary);
  }
  if (!archiveReady) return;
  savedEntriesReady = hydrateSavedEntries();
  void savedEntriesReady.then(() => {
    updateBookmarkButton();
    if (currentDestination === "library" && !readerSource) renderCover();
    else refreshCatalogRows();
  }).catch(() => {});
}

window.addEventListener("storage", (event) => {
  if (event.key === STATE_KEY) adoptStoredState(event.newValue);
});

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
  miniBar.render(miniBarModel());
}

// The newest unfinished place to go back to: a text chapter or a TypeMoon post (docs/24 §8.1).
function miniBarModel() {
  const text = textLibrary.latestReading();
  const post = historyEntries.find((entry) => entry.summary?.object_key && postReadingState(entry.progress) !== "finished");
  if (text && (!post || Date.parse(text.readAt) > Date.parse(post.readAt))) {
    return {
      title: text.work || text.title || "텍스트 장서", detail: text.work ? text.title : "", progress: text.progress,
      hue: workHue(textHueKey(text)), open: () => openTextFromHome(text),
    };
  }
  if (!post) return null;
  return {
    title: post.summary.title || "제목 없음", detail: boardLabel(post.summary.board_id), progress: post.progress,
    hue: workHue(postHueKey(post.summary)),
    open: () => loadPost(post.summary, "push", { listHint: "recent" }),
  };
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

function svgIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
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
  const dark = applyAppearance(settings);
  root.style.setProperty("--prose-align", settings.proseAlign === "justify" ? "justify" : "start");
  root.style.setProperty("--prose-size", `${settings.proseSize}px`);
  root.style.setProperty("--prose-line", settings.lineHeight);
  root.style.setProperty("--prose-width", `${settings.proseWidth}px`);
  root.style.setProperty("--prose-margin", `${settings.proseMargin}px`);
  root.style.setProperty("--prose-paragraph", `${settings.paragraphSpacing}em`);
  root.style.setProperty("--prose-indent", `${settings.textIndent}em`);
  root.style.setProperty("--prose-font", proseFontStack());
  const aaZoom = effectiveAaZoom();
  root.style.setProperty("--aa-effective-size", `${settings.aaSize * aaZoom}px`);
  root.style.setProperty("--aa-effective-line", `${settings.aaSize * 1.125 * aaZoom}px`);
  root.style.setProperty("--aa-background", settings.aaBackground);
  root.style.setProperty("--aa-ink", readableAaInk(settings.aaBackground));
  elements["theme-toggle"].ariaLabel = dark ? "밝은 테마로 전환" : "어두운 테마로 전환";
  elements["theme-toggle"].title = elements["theme-toggle"].ariaLabel;
  for (const [selector, key, value] of [
    ["[data-theme-choice]", "themeChoice", settings.theme],
    ["[data-reader-surface]", "readerSurface", settings.readerSurface],
    ["[data-prose-align]", "proseAlign", settings.proseAlign],
    ["[data-tap-paging]", "tapPaging", settings.tapPaging],
    ["[data-aa-auto-fit]", "aaAutoFit", settings.aaAutoFit],
    ["[data-home-quote]", "homeQuote", settings.homeQuote],
    ["[data-reading-mode]", "readingMode", settings.readingMode],
  ]) {
    for (const choice of document.querySelectorAll(selector)) {
      choice.setAttribute("aria-checked", String(choice.dataset[key] === value));
    }
  }
  syncThemeColor();
  for (const [id, value, suffix] of [
    ["prose-size", settings.proseSize, "px"],
    ["line-height", settings.lineHeight, ""],
    ["prose-width", settings.proseWidth, "px"],
    ["prose-margin", settings.proseMargin, "px"],
    ["aa-size", settings.aaSize, "px"],
    ["reader-dim", settings.readerDim, "%"],
    ["reader-warm", settings.readerWarm, "%"],
    ["paragraph-spacing", settings.paragraphSpacing, "em"],
    ["text-indent", settings.textIndent, "em"],
  ]) {
    for (const quick of document.querySelectorAll(`[data-quick-setting="${id === "reader-dim" ? "readerDim" : id === "reader-warm" ? "readerWarm" : ""}"]`)) quick.value = value;
    elements[id].value = value;
    elements[`${id}-output`].value = `${value}${suffix}`;
  }
  elements["prose-font"].value = settings.proseFont;
  // The font is judged on the reader's own text: the first lines of the open chapter, if any.
  const preview = document.querySelector("#font-preview");
  preview.textContent = elements["archive-body"].textContent.replace(/\s+/g, " ").trim().slice(0, 60) || "창밖으로 눈이 내리고 있었다. 그녀는 오래된 책을 덮었다.";
  preview.style.fontFamily = proseFontStack();
  document.querySelector("#quick-size-output").value = String(settings.proseSize);
  elements["aa-zoom-output"].value = `${Math.round(aaZoom * 100)}%`;
  elements["aa-background"].value = settings.aaBackground;
  elements["aa-source-styles"].textContent = settings.aaPreserveStyles ? "원본색" : "단색";
  elements["aa-source-styles"].setAttribute("aria-pressed", settings.aaPreserveStyles);
  elements["aa-color"].setAttribute("aria-pressed", settings.aaPreserveStyles);
  elements["aa-color"].ariaLabel = settings.aaPreserveStyles ? "AA 색: 원본색 (누르면 단색)" : "AA 색: 단색 (누르면 원본색)";
  // 색 only does something when the picture has its own colours; without them the button is left out.
  elements["aa-color"].hidden = !elements["archive-body"].querySelector('font[color], span[style*="color"]');
  // 굵게 has two strengths: 살짝 (light) and 굵게 (true); the button steps 끔 → 살짝 → 굵게.
  elements["aa-bold"].setAttribute("aria-pressed", String(Boolean(settings.aaBold)));
  elements["aa-bold"].textContent = settings.aaBold === "light" ? "살짝 굵게" : "굵게";
  for (const surface of document.querySelectorAll("#archive-body, .aa-comment")) {
    surface.classList.toggle("normalize-source-styles", !settings.aaPreserveStyles);
    surface.classList.toggle("aa-bold", settings.aaBold === true);
    surface.classList.toggle("aa-bold-light", settings.aaBold === "light");
  }
  const canvas = elements["archive-body"].querySelector(".aa-canvas");
  if (canvas) canvas.dataset.width = settings.aaCanvasWidth ?? "auto";
  for (const button of document.querySelectorAll("[data-aa-preset]")) {
    const [size, width] = button.dataset.aaPreset.split(":");
    button.classList.toggle("active", settings.aaSize === Number(size) &&
      settings.aaCanvasWidth === (width === "auto" ? null : Number(width)) && aaZoom === 1);
  }
  let backgroundPresetSelected = false;
  elements["aa-bold"].addEventListener("click", () => {
  settings.aaBold = settings.aaBold === false ? "light" : settings.aaBold === "light";
  saveSettings();
});
for (const button of document.querySelectorAll("[data-aa-background]")) {
    const selected = button.dataset.aaBackground === settings.aaBackground;
    button.classList.toggle("active", selected);
    backgroundPresetSelected ||= selected;
  }
  elements["aa-background"].closest(".aa-color-picker").classList.toggle("active", !backgroundPresetSelected);
  requestAnimationFrame(() => updateAaOverflowCue());
}

function syncThemeColor() {
  syncBrowserThemeColor(settings, Boolean(readerSource));
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
  overlays.showToast(elements["aa-zoom-indicator"]);
  zoomFeedbackTimer = setTimeout(() => overlays.hideToast(elements["aa-zoom-indicator"]), duration);
}

function showZoomFeedback() {
  showReaderFeedback(`${Math.round(effectiveAaZoom() * 100)}%`);
}

// AA zoom is kept per picture (aaViews): the zoom chosen for this post, else an automatic fit
// for this visit (넓은 AA 화면에 맞추기), else the default zoom.
function currentAaKey() {
  return currentSummary && currentMode === "aa" ? postIdentity(currentSummary) : "";
}

function effectiveAaZoom() {
  const key = currentAaKey();
  return (key && aaViews[key]?.zoom) || (key && aaAutoZoom) || settings.aaZoom;
}

function rememberAaView(change) {
  const key = currentAaKey();
  if (!key) return;
  const next = { ...aaViews[key], ...change, at: Date.now() };
  if (next.zoom == null) delete next.zoom;
  aaViews[key] = next;
}

// Restores the zoom and sideways position of an AA post as it opens.
function restoreAaView() {
  const key = currentAaKey();
  aaAutoZoom = null;
  if (!key) return;
  const saved = aaViews[key];
  requestAnimationFrame(() => {
    if (currentAaKey() !== key) return;
    if (!saved?.zoom && settings.aaAutoFit === "on") fitAaZoom({ remember: false });
    aaScroller().scrollLeft = saved?.left ?? 0;
    updateAaOverflowCue(true);
  });
}

// What scrolls an AA picture sideways (aa.css): the reader pane, or the AA host in full screen,
// scrolling both directions at once; the body itself where scroll-driven animations are missing.
const aaPanSupported = CSS.supports("animation-timeline: scroll()");
function aaScroller() {
  if (!aaPanSupported) return elements["archive-body"];
  return document.fullscreenElement === elements["aa-host"] ? elements["aa-host"] : elements["reader-pane"];
}

// How far the AA scroller goes sideways. Measured when the size or zoom changes (here), never per
// scroll event: a fling fires one per frame, and each measure, class toggle and custom-property
// write there cost the main thread a style pass over a large AA body.
let aaPanMax = 0;
let aaScrollFrame = 0;
function updateAaOverflowCue(showHint = false) {
  const scroller = aaScroller();
  const overflow = currentMode === "aa" && scroller.scrollWidth > scroller.clientWidth + 1;
  aaPanMax = overflow ? scroller.scrollWidth - scroller.clientWidth : 0;
  // The parts around the picture follow the sideways scroll by exactly this much at its end.
  const panMax = `${aaPanMax}px`;
  for (const host of [elements["reader-pane"], elements["aa-host"]]) {
    if (host.style.getPropertyValue("--aa-pan-max") !== panMax) host.style.setProperty("--aa-pan-max", panMax);
  }
  updateAaScrollCue();
  if (showHint && overflow && !aaHintShown) {
    aaHintShown = true;
    showReaderFeedback("↔ 가로로 이동", 2200);
  }
}

// The per-scroll part: the right-edge cue and the minimap, from the size measured above.
function updateAaScrollCue() {
  const body = elements["archive-body"];
  const canScrollRight = aaPanMax > 0 && aaScroller().scrollLeft < aaPanMax - 2;
  if (body.classList.contains("aa-can-scroll") !== canScrollRight) body.classList.toggle("aa-can-scroll", canScrollRight);
  updateAaMinimap();
}

function scheduleAaScrollCue() {
  if (aaScrollFrame) return;
  aaScrollFrame = requestAnimationFrame(() => {
    aaScrollFrame = 0;
    updateAaScrollCue();
  });
}

// `fit` marks a 맞춤 result, so a double tap knows to go back to 100% (fit and manual are kept apart).
// The minimap under a picture wider than the stage: where the view is across it (DESIGN §8.4).
// P6-8 scene moves (DESIGN §8.4): the 레스 header text nodes of this AA body, found once per body.
// Their positions are measured on use, since zoom and width change them (state at the top).
function findAaScenes() {
  aaScenes = [];
  if (currentMode === "aa") {
    const walker = document.createTreeWalker(elements["archive-body"], NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (isSceneHeader(node.data)) aaScenes.push(node);
    }
  }
  if (aaScenes.length < 2) aaScenes = [];
  elements["aa-scenes"].hidden = !aaScenes.length;
  updateAaScene();
}

function aaSceneView() {
  const scroller = document.fullscreenElement === elements["aa-host"] ? elements["aa-host"] : elements["reader-pane"];
  const controls = elements["aa-controls"];
  // A header lands just under the sticky toolbar.
  const offset = (Number.parseFloat(getComputedStyle(controls).top) || 0) + controls.offsetHeight + 8;
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const range = document.createRange();
  const tops = aaScenes.map((node) => {
    range.selectNodeContents(node);
    return range.getBoundingClientRect().top - origin;
  });
  return { scroller, offset, tops, y: sceneY(tops, { scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, offset }) };
}

function updateAaScene() {
  if (!aaScenes.length) return;
  const { tops, y } = aaSceneView();
  const index = sceneAt(tops, y);
  elements["aa-scene-output"].value = `장면 ${index + 1}/${tops.length}`;
  elements["aa-scene-previous"].disabled = sceneTarget(tops, y, -1) < 0;
  elements["aa-scene-next"].disabled = sceneTarget(tops, y, 1) < 0;
}

function scheduleAaScene() {
  if (!aaScenes.length || aaSceneFrame) return;
  aaSceneFrame = requestAnimationFrame(() => {
    aaSceneFrame = 0;
    updateAaScene();
  });
}

function moveAaScene(direction) {
  const { scroller, offset, tops, y } = aaSceneView();
  const index = sceneTarget(tops, y, direction);
  if (index < 0) return;
  // A late font/layout restore must not put the reader back where the scene move started.
  readerSession.markUserScroll();
  // The toolbar stays for the next ‹ ›.
  holdChromeDuringScroll();
  scroller.scrollTo({ top: Math.max(0, tops[index] - offset), behavior: "instant" });
  updateAaScene();
}

function updateAaMinimap() {
  scheduleAaScene();
  const map = elements["aa-minimap"];
  const view = currentMode === "aa" ? minimapWindow(aaScroller()) : null;
  map.hidden = !view;
  if (!view) return;
  map.style.setProperty("--window-left", `${view.left * 100}%`);
  map.style.setProperty("--window-width", `${view.width * 100}%`);
  map.ariaValueNow = String(Math.round((view.left / Math.max(0.001, 1 - view.width)) * 100));
}

function setAaZoom(value, debounce = false, { remember = true, fit = false } = {}) {
  const zoom = clampAaZoom(value);
  if (!currentAaKey()) settings.aaZoom = zoom;
  else if (remember) rememberAaView({ zoom, fit: fit || undefined });
  else aaAutoZoom = zoom;
  applySettings();
  showZoomFeedback();
  clearTimeout(zoomPersistTimer);
  if (debounce) zoomPersistTimer = setTimeout(persistUserState, 250);
  else persistUserState();
}

// 맞춤: the zoom at which the widest AA line fits the stage without horizontal scrolling. The
// picture's width scales with the zoom, so one measurement at the current zoom is enough. It
// only shrinks; a picture that already fits returns to 100%.
function fitAaZoom({ remember = true } = {}) {
  const body = elements["archive-body"];
  const canvas = body.querySelector(".aa-canvas");
  if (currentMode !== "aa" || !canvas) return;
  // A fixed preset width (680/800px) does not scale with the zoom, so it could never fit a
  // narrower stage and each press would only shrink further; fitting uses the picture's width.
  if (settings.aaCanvasWidth !== null) {
    settings.aaCanvasWidth = null;
    applySettings();
  }
  // The canvas is at least as wide as the stage; lift that floor to read the picture's own width.
  canvas.style.minWidth = "0";
  const content = canvas.getBoundingClientRect().width;
  canvas.style.removeProperty("min-width");
  const style = getComputedStyle(body);
  // The stage is what is on screen: the scroller's width, not the body grown around a wide picture.
  const stage = aaPanSupported ? aaScroller().clientWidth : body.clientWidth;
  const available = stage - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  if (!(content > 0) || !(available > 0)) return;
  setAaZoom(fitAaZoomValue(effectiveAaZoom(), available, content), false, { remember, fit: true });
  aaScroller().scrollLeft = 0;
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
    const meta = [boardLabel(post.board_id), post.author, formatSourceDate(post.created_at_raw)];
    element.append(homeRow(post.title || "제목 없음", meta, () => loadPost(post, "push", { listHint })));
  }
}

// A Home list row: title (two lines) over one quiet meta line.
function homeRow(title, metaParts, open, { badge = "" } = {}) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-item";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const meta = document.createElement("span");
  if (badge) {
    const mark = document.createElement("b");
    mark.className = "home-badge";
    mark.textContent = badge;
    meta.append(mark);
  }
  meta.append(metaParts.filter(Boolean).join(" · "));
  button.append(heading, meta);
  button.addEventListener("click", open);
  item.append(button);
  return item;
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
  // Empty modules hide whole (docs/24 §8.2); a first visit gets one block of ways in instead.
  elements["recent-list"].closest("section").hidden = !historyEntries.length;
  const firstVisit = !historyEntries.length && !bookmarks.length && !textLibrary.latestReading();
  elements["home-onboarding"].hidden = !showContinue || !firstVisit;
  elements["empty-reader"].classList.toggle("home-alert", Boolean(actionLabel) || title !== "내 장서");
  void renderReadingWorks();
  void personalLibrary?.renderHome().catch(() => {});
  void renderDiscovery();
  void renderHomeRecords();
  updateShellMode();
}

// 오늘의 발견 on Home: today's picks among unread series (stable all day, weighted toward
// popular works when the release has counts), the most discussed recent posts, and posts
// written on this day in earlier years. Each group hides when it has nothing to show.
async function renderDiscovery() {
  if (currentDestination !== "library" || !archiveReady) return;
  const now = new Date();
  const [year, month, day] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const [found, picks] = await Promise.all([
    workerRequest({ type: "discover", year, month, day, limit: 4 }).catch(() => null),
    discoveryPicks(dayKey).catch(() => []),
  ]);
  if (currentDestination !== "library" || currentSummary) return;
  const fill = (group, list, rows) => {
    list.replaceChildren(...rows);
    group.hidden = !rows.length;
  };
  fill(elements["discover-picks-group"], elements["discover-picks"], picks.map((collection) => homeRow(
    collection.title,
    [boardLabel(collection.board_id), `${collection.entry_count.toLocaleString("ko-KR")}편`,
      popularityLabel(collection.views, collection.comments)],
    () => void openCollectionDetail(collection.id),
  )));
  fill(elements["discover-hot-group"], elements["discover-hot"], (found?.hot ?? []).map((post) => homeRow(
    post.title || "제목 없음",
    [`댓글 ${post.comment_count.toLocaleString("ko-KR")}`, boardLabel(post.board_id), formatSourceDate(post.created_at_raw)],
    () => loadPost(post, "push", { listHint: "board" }),
  )));
  elements["discover-day-title"].textContent = `이날의 기록 · ${month}월 ${day}일`;
  // A post already shown as 요즘 화제 is not repeated under 이날의 기록.
  const shownHot = new Set((found?.hot ?? []).map(postIdentity));
  const dayPosts = (found?.onThisDay ?? []).filter((post) => !shownHot.has(postIdentity(post))).slice(0, 3);
  fill(elements["discover-day-group"], elements["discover-day"], dayPosts.map((post) => {
    const written = Number(/^\d{4}/.exec(String(post.created_at_raw))?.[0]);
    return homeRow(
      post.title || "제목 없음",
      [written ? `${year - written}년 전` : "", boardLabel(post.board_id), post.author],
      () => loadPost(post, "push", { listHint: "board" }),
    );
  }));
  elements["discover-shuffle"].hidden = !picks.length;
  elements.discover.hidden = [elements["discover-picks-group"], elements["discover-hot-group"], elements["discover-day-group"]]
    .every((group) => group.hidden);
}

async function discoveryPicks(dayKey) {
  const index = await collectionIndex();
  const { progress, failedBoards } = await collectionReadingProgress(index);
  const candidates = index.summaries.filter((collection) => collection.kind !== "oneshot" &&
    collectionAvailableCount(collection) >= 3 && !failedBoards.has(collection.board_id) &&
    collectionOccupancy({
      availableCount: collectionAvailableCount(collection),
      finishedCount: progress.get(collection.id)?.finished ?? 0,
      readingCount: progress.get(collection.id)?.reading ?? 0,
    }) === "unread");
  return weightedPicks(candidates, {
    seed: `${dayKey}#${discoverShuffle}`,
    count: 3,
    // Popular works are likelier, but every unread series can come up.
    weight: (collection) => index.hasStats ? 1 + Math.log10(1 + collection.views + 5 * collection.comments) : 1,
  });
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
    text.identity.startsWith("manual:") ? "수동 문서" : text.identity.startsWith("novel:") ? "소설" : "아카라이브",
    finished ? (text.identity.startsWith("novel:") ? "다 읽음 · 다음 화로 이어서" : "다 읽음") : postReadingLabel(text.progress, { seen: true }),
  ].filter(Boolean).join(" · ");
  elements["continue-toc"].hidden = !text.identity.startsWith("novel:");
  setContinueProgress(finished ? 0 : text.progress);
  fillContinueCard(continueCardParts(), {
    title: text.work || text.title || "텍스트 장서", source: text.identity.startsWith("manual:") ? "수동 문서" : text.identity.startsWith("novel:") ? "소설" : "아카라이브",
    hueKey: textHueKey(text), progress: finished ? 0 : text.progress, sentence: finished || settings.homeQuote === "off" ? "" : lastSentenceQuote(text.loc), readAt: text.readAt,
  });
}

function continueCardParts() {
  return { cover: elements["continue-cover"], quote: elements["continue-quote"], when: elements["continue-when"] };
}

// Stable cover keys (DESIGN §2.5) for records that only know an identity.
function textHueKey(text) {
  if (text.identity?.startsWith("manual:")) return text.identity;
  if (text.identity?.startsWith("novel:")) return workKey({ source: "novel", id: text.workId || text.work || text.identity });
  return workKey({ source: "arcalive", board: text.board || "", id: text.workId || text.work || text.identity });
}
function postHueKey(summary, collectionId = null) {
  return collectionId ? workKey({ source: "typemoon", id: collectionId })
    : workKey({ source: "typemoon-post", board: summary.board_id, id: summary.external_post_id });
}

// The red progress piece along the bottom of the 이어서 읽기 card (DESIGN §3).
function setContinueProgress(progress) {
  const ratio = Math.min(1, Math.max(0, Number(progress) || 0));
  elements["continue-reading"].style.setProperty("--continue-progress", `${Math.round(ratio * 100)}%`);
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
  let shownEntry = latestEntry;
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
      shownEntry = historyEntries.find((entry) => samePost(entry.summary, target.entry)) ?? null;
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
      shownEntry = fallback;
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
    shownEntry = fallback;
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
  setContinueProgress(progress);
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
  fillContinueCard(continueCardParts(), {
    title: membership?.collection.title || summary.title || "제목 없음", source: "타입문넷",
    hueKey: postHueKey(summary, membership?.collection.id), progress, sentence: settings.homeQuote === "off" ? "" : lastSentenceQuote(shownEntry?.loc),
    readAt: shownEntry?.readAt ?? latestEntry.readAt,
  });
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
        source: "타입문넷",
        hueKey: workKey({ source: "typemoon", id: collection.id }),
        progress: collectionAvailableCount(collection) ? (state?.finished ?? 0) / collectionAvailableCount(collection) : null,
        meta: [copy.progress, copy.action],
        readAt: state?.lastReadAt ?? "",
        fresh: hasNewEpisodes(collection, state),
        open: () => void openCollectionDetail(collection.id),
      });
    }
  } catch {
    typeMoonFailed = true;
  }
  if (currentDestination !== "library") return;
  const textWorks = await textLibrary.readingWorks();
  if (currentDestination !== "library") return;
  for (const work of textWorks) {
    items.push({
      title: work.title,
      source: "소설",
      hueKey: workKey({ source: "novel", id: work.workId }),
      progress: work.progress,
      newCount: work.newCount,
      meta: [work.meta],
      readAt: work.readAt,
      fresh: work.newCount > 0,
      badge: work.newCount > 0 ? `새 ${work.newCount}화` : "",
      open: () => openTextFromHome({ identity: "novel:", listRoute: work.listRoute, progress: 0 }, { listOnly: true }),
    });
  }
  // Works with episodes added since they were last read come first.
  items.sort((left, right) => Number(right.fresh) - Number(left.fresh) ||
    (Date.parse(right.readAt) || 0) - (Date.parse(left.readAt) || 0));
  const shown = items.slice(0, 8);
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
    list.append(shelfCard({ ...item, badge: item.badge || (item.fresh ? "새 편" : ""), newCount: item.newCount ?? (item.fresh ? 1 : 0) }));
  }
  if (failedBoards.size && shown.length) {
    const note = document.createElement("li");
    note.className = "home-empty";
    note.textContent = "일부 읽기 상태 미확인";
    list.append(note);
  }
}

// A work has new episodes for this reader when it continues past the furthest episode they have
// opened and its newest episode was posted after their last visit.
function hasNewEpisodes(collection, state) {
  if (!state?.positions?.size || !state.lastReadAt) return false;
  const furthest = Math.max(...state.positions);
  const latest = Date.parse(collection.latest_created_at ?? "");
  return collection.entry_count > furthest && Number.isFinite(latest) && latest > Date.parse(state.lastReadAt);
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
  // The error cover replaces the Reader: keep the open post's place while it is still measured,
  // then let the post go so later saves (cover scroll, pagehide) cannot overwrite its progress.
  if (currentSummary) {
    if (readerSource === "typemoon") persistReadingPosition();
    currentSummary = null;
    currentPayload = null;
    currentCollection = null;
  }
  renderCover(title, message, false, expired ? "다시 로그인" : "다시 시도");
  void renderOfflineWorks(offline || expired);
}

// 내려받은 작품 (offline): shown when the archive cannot be reached; each opens from its snapshot.
async function renderOfflineWorks(show = true) {
  const store = show ? await ownerStore() : null;
  const works = store ? (await store.getAll("offline")).filter((work) => work.descriptor && work.state !== "interrupted") : [];
  elements["offline-works"].hidden = !works.length;
  elements["offline-works-list"].replaceChildren(...works.map((work) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${work.title}${work.state === "partial" ? " · 일부만" : ""}`;
    button.addEventListener("click", () => void openCollectionDetail(work.descriptor.id));
    item.append(button);
    return item;
  }));
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
  const previousSource = readerSource;
  readerSource = source;
  elements.reader.hidden = !source;
  elements.reader.dataset.source = source ?? "";
  document.body.classList.toggle("reader-active", Boolean(source));
  syncThemeColor();
  if (!source) {
    continuous.reset(); readerDocument = null; continuousPreview = null;
    document.body.classList.remove("continuous-mode");
    stopAutoScroll();
    finishReadingSession();
    if (previousSource) readerSession.cancelPendingWork();
    readerNavigation = null;
    listContext = null;
    if (wakeWanted) setScreenAwake(false);
    renderReaderList(null);
    elements["reader-more"].open && elements["reader-more"].close();
    return;
  }
  elements["empty-reader"].hidden = true;
  elements["collection-view"].hidden = true;
  document.body.classList.remove("collection-detail-open");
  const text = source === "text";
  elements.comments.hidden = text;
  if (text) elements["end-comments"].hidden = true;
  elements["mode-toggle"].hidden = text;
  if (text) {
    elements["mode-reset"].hidden = true;
    elements["aa-controls"].hidden = true;
  }
}

function beginReaderDocument(documentKey, workId, rev) {
  readerSession.begin({ documentKey, workId, rev });
  fontGeneration = readerSession.generation;
  readerSession.track(() => {
    clearTimeout(scrollTimer);
    clearTimeout(pagingTimer);
    clearTimeout(zoomFeedbackTimer);
    cancelAnimationFrame(progressFrame);
    progressFrame = 0;
    pagingScroll = false;
    textLibrary.cancelPendingPosition();
    overlays.hideToast(elements["aa-zoom-indicator"]);
  });
  scrollAdapter = createScrollAdapter({
    body: elements["archive-body"], scroller: elements["reader-pane"], topInset: readerTopInset,
    revision: () => readerSession.rev, progress: bodyProgress, mode: currentMode === "aa" ? "aa" : "scroll",
  });
  // A TypeMoon post lays its body out (and may enter page mode) before the document begins.
  readerSession.adapter = paged.active ? pagedAdapter : scrollAdapter;
  paged.page = 0;
  paged.anchor = null;
  hideSelectionMenu();
  stopAutoScroll();
  finishReadingSession();
  readerSession.frame(applyWorkProfile);
  readerSession.frame(startReadingSession);
  readerSession.frame(() => void ownerStore().then(() => {
    paintAnnotations();
    jumpToPendingExcerpt();
    jumpToHandoff();
  }));
}

// Work search shares the Reader's original-text extraction and its parent route.
const kwic = createKwic({
  overlays,
  parse(entry, raw) {
    const body = document.createElement("div");
    if (entry.type === "typemoon") body.innerHTML = JSON.parse(raw).post.body_html;
    else body.textContent = (entry.type === "manual" ? raw : (entry.type === "novel" ? novelBody(raw) : arcaliveBody(raw)).text);
    return createTextModel(body).text;
  },
  async onOpen(hit, parent) {
    persistReadingPosition();
    history.replaceState({ ...(history.state ?? {}), redstmReader: false }, "", parent);
    if (hit.entry.type === "typemoon") await loadPost(hit.entry.summary);
    else await textLibrary.openKwicResult(hit.entry);
    readerSession.frame(() => readerSession.frame(() => {
      if (readerSession.restore({ loc: hit.locator, viewportOffset: Math.round(elements["reader-pane"].clientHeight / 3) })) syncScrollBaseline();
      else showReaderFeedback("원문에서 이 문장을 찾지 못했어요", 2400);
    }));
  },
});
async function openWorkSearch(query = "", all = false) {
  const route = currentRoute();
  closeReaderMore();
  find.close();
  pauseAutoScroll();
  let context;
  if (readerSource === "text" || currentDestination === "text") context = textLibrary.kwicContext();
  else {
    const collection = currentSummary ? (currentCollection?.collection || (await findCollection(currentSummary))?.collection)
      : activeCollectionId === null ? null : await loadCollectionDetail(activeCollectionId);
    if (collection) {
      const records = historyByIdentityMap();
      context = {
        title: collection.title, from: location.pathname.startsWith("/collections/") ? currentRoute()
          : history.state?.redstmParent?.startsWith("/collections/") ? history.state.redstmParent : `/collections/${collection.id}`,
        current: currentSummary ? postIdentity(currentSummary) : "",
        read: collection.entries.filter((entry) => records.has(postIdentity(entry))).map(postIdentity),
        entries: collection.entries.filter((entry) => entry.object_key).map((entry) => ({
          documentId: postIdentity(entry), title: `${entry.position}편 · ${entry.title}`, type: "typemoon",
          url: `/archive/${entry.object_key}`, summary: entry,
          rev: entry.object_key.match(/-([a-f0-9]{64})\.json/)?.[1] || "",
        })),
      };
    }
  }
  if (route !== currentRoute()) return;
  if (!context) return void showReaderFeedback("작품의 회차 목록에서 찾을 수 있어요", 2200);
  kwic.open(context, query, all);
}
for (const id of ["collection-find", "reader-work-find", "find-work"]) {
  document.querySelector(`#${id}`).addEventListener("click", () => void openWorkSearch(id === "find-work" ? document.querySelector("#find-input").value : ""));
}
document.querySelector("#selection-work-find").addEventListener("click", () => {
  elements["selection-more"].close();
  void openWorkSearch(moreQuote || "");
});

// ---- Page mode (docs/24 §8.10, S1: whole-chapter columns moved by a transform) -----------------
let scrollAdapter = null;
// `anchor` is the sentence the current page was reached by (a turn, a restore or a find). Every
// relayout puts that sentence back on screen, so rotating there and back does not drift a page.
const paged = { active: false, page: 0, pages: 1, geometry: null, drag: null, anchor: null };
let pageNoticeShown = false;
const PAGE_HINT_KEY = "redstm.pageHint.v1";

// First page-mode visit on a touch screen shows the tap zones once (docs/24 §8.10); one tap dismisses it.
function showPageHintOnce() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  try {
    if (localStorage.getItem(PAGE_HINT_KEY)) return;
  } catch {
    return;
  }
  elements["page-hint"].hidden = false;
}

function layoutPages() {
  const pane = elements["reader-pane"];
  const narrow = isNarrowScreen();
  const top = readerTopInset() + 16;
  const geometry = pageGeometry({
    paneWidth: pane.clientWidth, paneHeight: pane.clientHeight, margin: narrow ? settings.proseMargin : 32,
    maxWidth: settings.proseWidth, top, bottom: narrow ? 84 : 32,
  });
  const reader = elements.reader;
  reader.style.setProperty("--page-width", `${geometry.width}px`);
  reader.style.setProperty("--page-gap", `${geometry.gap}px`);
  reader.style.setProperty("--page-height", `${geometry.height}px`);
  reader.style.setProperty("--page-left", `${geometry.left}px`);
  reader.style.setProperty("--page-top", `${top}px`);
  paged.geometry = geometry;
  paged.pages = pageCount(elements["archive-body"].scrollWidth, geometry);
}

function showPage(page, { animate = false, offset = 0 } = {}) {
  paged.page = Math.max(0, Math.min(paged.pages - 1, page));
  const body = elements["archive-body"];
  body.classList.toggle("turning", animate && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  body.style.transform = `translateX(${offset - paged.page * paged.geometry.step}px)`;
  updateReadingProgress();
}

// The reader turned the page: saved like a scroll, and no late layout pulls it back.
function turnPage(page, options) {
  readerSession.markUserScroll();
  showPage(page, options);
  paged.anchor = capturePageStart();
  queueScrollSave();
}

// The first character on the current page. Measured against the body's own box, which moves with
// the transform, so a turn still animating reads the page it is going to.
function capturePageStart() {
  return capturePagedAnchor(elements["archive-body"],
    elements["archive-body"].getBoundingClientRect().left + paged.page * paged.geometry.step, readerSession.rev);
}

const pagedAdapter = {
  mode: "paged",
  // The place is the sentence the page was reached by, not whatever begins the page now: a page
  // start moves with every relayout, and recapturing it would drift the place a page at a time.
  captureVisiblePosition: () => paged.anchor ?? capturePageStart(),
  scrollToRange(anchor) {
    if (anchor?.atStart) {
      showPage(0);
      paged.anchor = anchor;
      return true;
    }
    const left = anchorLeft(elements["archive-body"], anchor, readerSession.rev);
    if (left === null) return false;
    showPage(pageAt(left - elements["archive-body"].getBoundingClientRect().left, paged.geometry, paged.pages));
    paged.anchor = anchor;
    return true;
  },
  measureProgress: () => (paged.pages > 1 ? paged.page / (paged.pages - 1) : 1),
  onViewportChanged(anchor) { return pagedAdapter.scrollToRange(anchor); },
  scrollTop: () => 0,
};

// Chooses the layout for the open body and keeps the sentence at the reader's place across it.
function applyReadingMode() {
  const want = settings.readingMode === "page" && Boolean(readerSource) && currentMode !== "aa";
  if (settings.readingMode === "page" && readerSource && currentMode === "aa" && !pageNoticeShown) {
    pageNoticeShown = true;
    showReaderFeedback("AA는 스크롤로 보여 줍니다", 2200);
  }
  const anchor = paged.active !== want || (continuous.currentKey && !continuousEnabled()) ? readerSession.adapter?.captureVisiblePosition() : null;
  if (!continuousEnabled()) continuous.reset();
  paged.active = want;
  elements.reader.classList.toggle("paged", want);
  elements["reader-pane"].classList.toggle("paged-host", want);
  document.body.classList.toggle("page-mode", want);
  const body = elements["archive-body"];
  if (want) {
    elements["reader-pane"].scrollTop = 0;
    layoutPages();
    readerSession.adapter = pagedAdapter;
    showPage(paged.page);
    showPageHintOnce();
  } else {
    elements["page-hint"].hidden = true;
    body.style.transform = "";
    body.classList.remove("turning");
    paged.anchor = null;
    if (scrollAdapter) readerSession.adapter = scrollAdapter;
  }
  if (anchor && readerSession.restore(anchor)) syncScrollBaseline();
  refreshContinuous();
  updateReadingProgress();
}

// Pages turn by tap zones (오른손: left 30% back, middle 20% tools, right half forward) or by a
// swipe that follows the finger. A swipe starting at the screen edges belongs to system Back.
const EDGE_GUARD = 24;
function followPageGesture(event, start) {
  const dx = event.clientX - start.x;
  if (!paged.drag) {
    const fromEdge = start.x < EDGE_GUARD || start.x > innerWidth - EDGE_GUARD;
    if (fromEdge || Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    paged.drag = true;
  }
  showPage(paged.page, { offset: dx });
}

// Page keys belong to the Reader only while it is on screen (a list over it keeps Space for scrolling).
function pageKeys() {
  return paged.active && document.body.classList.contains("reader-open");
}

function stepPage(direction) {
  const next = paged.page + direction;
  if (next >= paged.pages) return void readerCommand("next");
  if (next < 0) return void readerCommand("previous");
  turnPage(next, { animate: true });
}

function finishPageGesture(event, start) {
  if (paged.drag) {
    paged.drag = false;
    const dx = event.clientX - start.x;
    const target = swipeTarget(paged.page, paged.pages, dx, event.timeStamp - start.time, paged.geometry.width);
    // A swipe past the last page moves on to the next episode, like the chapter end card.
    if (target === paged.page && dx < -paged.geometry.width * 0.2 && paged.page === paged.pages - 1) readerCommand("next");
    else turnPage(target, { animate: true });
    return true;
  }
  if (event.pointerType === "mouse" || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return false;
  if (event.target.closest("a, button, input, select, textarea, label, summary, img, [role='button'], .media-figure, .reader-topbar, .reader-toolbar")) return false;
  if (String(getSelection() ?? "")) return false;
  const rect = elements["reader-pane"].getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  if (ratio < 0.3) stepPage(-1);
  else if (ratio > 0.5) stepPage(1);
  else setReaderChromeHidden(!document.body.classList.contains("reader-controls-hidden"));
  return true;
}

// Size or fonts changed the columns: lay them out again around the same sentence.
function relayoutPages() {
  if (!paged.active) return;
  const anchor = pagedAdapter.captureVisiblePosition();
  layoutPages();
  if (!anchor || !pagedAdapter.scrollToRange(anchor)) showPage(paged.page);
}

function openTextReader({ kicker, title, meta, text, sourceUrl, documentId, workId, revision }) {
  if (currentSummary) persistReadingPosition();
  readerDocument = { key: documentId, title, workId };
  continuous.prepare(readerDocument);
  cancelReaderSelection();
  currentSummary = null;
  currentPayload = null;
  currentCollection = null;
  currentMode = "prose";
  beginReaderDocument(documentId, workId, revision);
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
  updateReaderLength();
  const renderId = String(++textRenderId);
  body.dataset.renderId = renderId;
  void archiveTextMedia(body, renderId);
  openMobileReader();
  applyReadingMode();
  const joined = continuous.commit(readerDocument);
  if (joined) readerSession.frame(() => { syncScrollBaseline(); readerSession.capture(); });
  updateShellMode();
  readerSession.frame(() => elements["reader-title"].focus({ preventScroll: true }));
}

// Arcalive images: show the copies Newtomi archived (docs/20). A failed lookup leaves the body
// as rendered (live signed links load; expired ones point at the source post).
// Archived copies never change (R2 keys are CDN path keys), so a path found once is not asked
// about again in this session; paths still missing are asked again on the next open.
const archivedMediaUrls = new Map();

async function archiveTextMedia(body, renderId) {
  const paths = arcaPaths(body);
  const known = Object.fromEntries(
    paths.filter((path) => archivedMediaUrls.has(path)).map((path) => [path, { url: archivedMediaUrls.get(path) }]),
  );
  if (Object.keys(known).length) applyArchivedMedia(body, known);
  const unknown = paths.filter((path) => !archivedMediaUrls.has(path));
  // The Worker checks each path with one R2 call, so a request carries at most 40.
  for (let start = 0; start < unknown.length; start += 40) {
    let media;
    try {
      const response = await fetch("/api/v1/text/media/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: unknown.slice(start, start + 40) }),
      });
      if (!response.ok) return;
      media = (await response.json()).media ?? {};
    } catch {
      return;
    }
    for (const [path, entry] of Object.entries(media)) {
      if (typeof entry?.url === "string") archivedMediaUrls.set(path, entry.url);
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
  if (paged.active) return pagedAdapter.measureProgress();
  const pane = elements["reader-pane"];
  const body = elements["archive-body"];
  if (continuousEnabled()) {
    const top = body.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const length = body.offsetHeight - pane.clientHeight + readerTopInset();
    return length > 0 ? Math.min(1, Math.max(0, (pane.scrollTop - top + readerTopInset()) / length)) :
      Number(body.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom);
  }
  const span = body.offsetTop + body.offsetHeight - pane.clientHeight;
  if (span > 0) return Math.min(1, Math.max(0, pane.scrollTop / span));
  const maximum = pane.scrollHeight - pane.clientHeight;
  return maximum > 0 ? Math.min(1, pane.scrollTop / maximum) : 0;
}

// Estimated reading time of the open prose body (AA pictures are looked at, not read).
function updateReaderLength() {
  readerMinutes = currentMode === "aa" ? 0 : readingMinutes(elements["archive-body"].textContent);
  elements["reader-length"].textContent = readingTimeLabel(readerMinutes);
  elements["reader-length"].hidden = !readerMinutes;
}

function renderRemainingTime(progress) {
  elements["more-remaining"].textContent = remainingTimeLabel(readerMinutes, progress);
  document.querySelector("#scrubber-remaining").textContent = elements["more-remaining"].textContent;
}

// Moves the body to a share of the chapter; the far end lands on the 다음 화 card rather than the
// last line behind the tools.
function scrubTo(ratio) {
  readerSession.markUserScroll();
  const pane = elements["reader-pane"];
  const body = elements["archive-body"];
  const span = body.offsetTop + body.offsetHeight - pane.clientHeight;
  const chapterEnd = document.getElementById("chapter-end");
  pane.scrollTop = ratio >= 1
    ? chapterEnd.offsetTop - pane.clientHeight / 3
    : ratio * (span > 0 ? span : pane.scrollHeight - pane.clientHeight);
  syncScrollBaseline();
  renderRemainingTime(ratio);
}

// Scrubber (docs/24 §8.9). The place before the reader's last explicit jump (a scrub or a find
// move) stays offered for this document until another jump replaces it.
const scrubber = document.querySelector("#scrubber");
let readerReturn = null;
function rememberReturn(anchor, label) {
  if (anchor) readerReturn = { anchor, label, generation: readerSession.generation };
}
function openScrubber() {
  if (!readerSource) return;
  const progress = bodyProgress();
  document.querySelector("#scrubber-position").value = String(Math.round(progress * 1000));
  document.querySelector("#scrubber-output").value = `${Math.round(progress * 100)}%`;
  document.querySelector("#scrubber-context").textContent = elements["reader-more-context"].textContent;
  renderRemainingTime(progress);
  renderChapterRun(document.querySelector("#scrubber-run"), document.querySelector("#scrubber-run-label"), readerNavigation?.run ?? null);
  const ticks = document.querySelector("#find-band").cloneNode(true).children;
  document.querySelector("#scrubber-ticks").replaceChildren(...ticks);
  const back = document.querySelector("#scrubber-return");
  const live = readerReturn && readerReturn.generation === readerSession.generation ? readerReturn : null;
  back.hidden = !live;
  if (live) back.textContent = `${live.label}로`;
  scrubAnchor = null;
  if (!scrubber.open) scrubber.showModal();
}
let scrubAnchor = null;
let scrubFrame = 0;

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
  renderChapterRun(document.querySelector("#end-run"), document.querySelector("#end-run-label"), nav.run ?? null);
  schedulePrefetch(nav.next?.prefetch);
  elements["reader-more-context"].textContent = nav.context ?? "";
  refreshContinuous();
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
  if (name === "settings") return openQuickSettings();
  if (name === "more") return openReaderMore();
  if (continuousEnabled() && (name === "next" || name === "previous" || (name === "end-next" && elements["end-next"].dataset.action === "next"))) return continuous.move(name === "previous" ? -1 : 1);
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
  const progress = bodyProgress();
  const percent = Math.round(progress * 100);
  elements["more-position"].value = String(percent);
  elements["more-position-output"].value = `${percent}%`;
  renderRemainingTime(progress);
  renderWakeState();
  const unreadBefore = readerSource === "text" ? textLibrary.previousUnreadCount() : 0;
  elements["more-mark-read"].hidden = unreadBefore === 0;
  elements["more-mark-read-label"].textContent = `이전 회차 모두 읽음 (${unreadBefore.toLocaleString("ko-KR")}화)`;
  if (!elements["reader-more"].open) {
    moreOpener = document.activeElement;
    elements["reader-more"].showModal();
  }
}

function closeReaderMore() {
  if (elements["reader-more"].open) elements["reader-more"].close();
}

// 화면 켜 두기: a screen wake lock the reader asks for, held only while a body is open. The
// browser drops it whenever the page is hidden, so it is requested again on return.
async function acquireWakeLock() {
  if (!wakeWanted || wakeLock || document.visibilityState !== "visible") return;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    // Turned off (or the body closed) while the request was pending.
    if (!wakeWanted || wakeLock) {
      void sentinel.release().catch(() => {});
      return;
    }
    wakeLock = sentinel;
    sentinel.addEventListener("release", () => {
      if (wakeLock === sentinel) wakeLock = null;
      renderWakeState();
    });
  } catch {
    wakeWanted = false;
    showReaderFeedback("화면 켜 두기를 쓸 수 없습니다", 2200);
  }
  renderWakeState();
}

function setScreenAwake(wanted) {
  wakeWanted = wanted;
  if (wanted) {
    void acquireWakeLock();
    return;
  }
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  renderWakeState();
}

function renderWakeState() {
  elements["more-wake"].hidden = !("wakeLock" in navigator);
  elements["more-wake"].setAttribute("aria-pressed", String(wakeWanted));
}

async function copyReaderLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    showReaderFeedback("링크를 복사했습니다", 1600);
  } catch {
    if (navigator.share) await navigator.share({ title: document.title, url }).catch(() => {});
    else showReaderFeedback("링크를 복사하지 못했습니다", 2200);
  }
}

// The text library is a source inside 둘러보기, so its screens keep that tab lit.
function updateDestinationButtons() {
  const tab = currentDestination === "text" ? "browse" : currentDestination;
  for (const button of document.querySelectorAll("[data-destination]")) {
    const active = button.dataset.destination === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active);
  }
}

const browseSourceKey = "redstm.browseSource";
function rememberedBrowseSource() {
  try {
    const source = localStorage.getItem(browseSourceKey);
    return ["novel", "arcalive", "manual"].includes(source) ? source : "typemoon";
  } catch {
    return "typemoon";
  }
}

function openBrowseSource(source) {
  try { localStorage.setItem(browseSourceKey, source); } catch { /* the choice is a convenience */ }
  if (source === "typemoon") {
    if (currentDestination === "browse") return;
    setScope("posts");
    restoreCatalogConditions("browse");
    showDestination("browse");
    return;
  }
  if (currentDestination === "text") {
    textLibrary.changeLane(source);
    return;
  }
  history.pushState(null, "", `/text?lane=${source}`);
  showDestination("text", false);
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
  renderSortOptions();
  syncFilterSheetFields();
  elements["search-input"].placeholder = collectionScope ? "작품 제목 검색" : "제목, 작성자, 분류 검색";
}

// Sort choices the current release supports; popularity needs the counts newer exports carry.
function sortChoices(scope) {
  if (scope === "collections") {
    return [["최근 글순", "updated"], ["가나다순", "title"], ["편수 많은순", "longest"],
      ...(collectionStats ? [["조회 많은순", "views"], ["댓글 많은순", "comments"]] : [])];
  }
  return [["최신순", "latest"], ["오래된순", "oldest"],
    ...(searchStats ? [["조회 많은순", "views"], ["댓글 많은순", "comments"]] : [])];
}

function allowedSort(scope, requested) {
  const choices = sortChoices(scope);
  return choices.some(([, value]) => value === requested) ? requested : choices[0][1];
}

// Options for the current scope, keeping the chosen sort when it is still offered.
function renderSortOptions() {
  const previousSort = elements["sort-filter"].value;
  const options = sortChoices(currentScope);
  elements["sort-filter"].replaceChildren(...options.map(([label, value]) => new Option(label, value)));
  elements["sort-filter"].value = options.some(([, value]) => value === previousSort)
    ? previousSort : options[0][1];
}

// Rebuilds the sort options once an index reports its counts. Returns true when the sort changed.
function refreshSortChoices() {
  // The text library owns the select while it is open (applyTextSortOptions).
  if (currentDestination === "text") return false;
  const wanted = pendingSort ?? elements["sort-filter"].value;
  renderSortOptions();
  const value = allowedSort(currentScope, wanted);
  if (value === wanted) pendingSort = null;
  if (elements["sort-filter"].value === value) return false;
  elements["sort-filter"].value = value;
  return true;
}

// A board's 분류 (TypeMoon's 장편·단편·칼럼 tabs, or per-work tags) narrows that board only: it
// belongs to the board it was picked on and stops applying as soon as the board changes.
let categoryFilter = { boardId: "", category: "" };
function activeCategory() {
  const boardId = elements["board-filter"].value;
  return boardId && currentScope === "posts" && categoryFilter.boardId === boardId ? categoryFilter.category : "";
}
function setCategory(category, boardId = elements["board-filter"].value) {
  categoryFilter = { boardId, category: boardId ? category ?? "" : "" };
}

function currentSearchState() {
  return {
    query: elements["search-input"].value,
    boardId: elements["board-filter"].value,
    category: activeCategory(),
    mode: elements["mode-filter"].value,
    sort: elements["sort-filter"].value,
    target: elements["search-target"].value,
    match: elements["search-match"].value,
    collectionKind: elements["collection-kind-filter"].value,
    collectionRead: elements["collection-read-filter"].value,
  };
}

// 둘러보기 and 검색 keep their own conditions (DESIGN §4.3): words typed in Search never filter
// Browse (which has no search field), and Browse finds its own board, format and sort again when
// you come back to it. Search opened from Browse searches the board on screen (removable in the
// dock) and keeps its last words. Links and Back still restore exactly what their URL says.
const catalogConditions = new Map();
let catalogConditionsRemembered = false;
function rememberCatalogConditions() {
  if (["browse", "search"].includes(currentDestination)) catalogConditions.set(currentDestination, currentSearchState());
}
// Called just before showDestination(destination); the tab being left is remembered first.
function restoreCatalogConditions(destination) {
  rememberCatalogConditions();
  catalogConditionsRemembered = true;
  const saved = catalogConditions.get(destination);
  const scope = destination === "search" && currentDestination === "browse" ? catalogConditions.get("browse") : saved;
  elements["search-input"].value = destination === "search" ? saved?.query ?? "" : "";
  elements["mode-filter"].value = scope?.mode ?? "all";
  // The board options follow the format filter; rebuild them before picking the board.
  populateBoardFilter();
  elements["board-filter"].value = scope?.boardId ?? "";
  setCategory(scope?.category, scope?.boardId ?? "");
  elements["sort-filter"].value = allowedSort(currentScope, saved?.sort);
  elements["search-target"].value = saved?.target ?? "all";
  elements["search-match"].value = saved?.match ?? "and";
  elements["collection-kind-filter"].value = saved?.collectionKind ?? "all";
  elements["collection-read-filter"].value = saved?.collectionRead ?? "all";
}

function searchUrl(state = currentSearchState(), destination = currentDestination) {
  const params = new URLSearchParams();
  if (currentScope === "collections") params.set("scope", "collections");
  if (state.query) params.set("q", state.query);
  if (state.boardId) params.set("board", state.boardId);
  if (currentScope === "posts" && state.category) params.set("category", state.category);
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
  if (view === "excerpts") params.set("view", "excerpts");
  if (view === "stats") params.set("view", "stats");
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
  setCategory(params.get("category"), params.get("board") ?? "");
  const mode = params.get("mode");
  elements["mode-filter"].value = searchSupportsAa && (mode === "aa" || mode === "prose") ? mode : "all";
  elements["search-target"].value = ["title", "author"].includes(params.get("target")) ? params.get("target") : "all";
  elements["search-match"].value = params.get("match") === "or" ? "or" : "and";
  const requestedSort = params.get("sort");
  elements["sort-filter"].value = allowedSort(currentScope, requestedSort);
  // A popularity sort from a link waits for the index that says whether counts exist.
  pendingSort = requestedSort && elements["sort-filter"].value !== requestedSort ? requestedSort : null;
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
    destination === "bookmarks" && params.get("view") === "excerpts" ? "excerpts" :
    destination === "bookmarks" && params.get("view") === "stats" ? "stats" :
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
  // The result bar's sort menu is the control, as on TypeMoon lists; a separate chip row cost a
  // whole row of the phone screen above the list.
  elements["text-sort-chips"].hidden = true;
  document.querySelector(".sort-field").hidden = sortOptions.length < 2;
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
  elements["source-switch"].hidden = !browsing && !text;
  if (!searching) elements["search-suggest"].hidden = true;
  if (browsing) {
    for (const button of elements["source-switch"].querySelectorAll("[data-source]")) {
      button.setAttribute("aria-pressed", String(button.dataset.source === "typemoon"));
    }
  }
  document.querySelector(".saved-tabs").hidden = !saved;
  elements["excerpts-export"].hidden = !saved || currentView !== "excerpts";
  elements["stats-panel"].hidden = !saved || currentView !== "stats";
  elements["result-list"].hidden = saved && currentView === "stats";
  // 검색 범위 내 기록: the same words in 기록 › 발췌 (B4).
  document.querySelector("[data-records-scope]").hidden = !searching;
  // 통계 has nothing to search.
  elements["catalog-search-row"].hidden = (!searching && !saved && !text) || (saved && currentView === "stats");
  elements["catalog-toolbar"].hidden = saved && currentView !== "all";
  elements["mode-chips"].hidden = saved || collections || searching || text;
  elements["kind-chips"].hidden = saved || !collections || searching;
  document.querySelector(".sort-field").hidden = saved;
  // The board lives in its own picker (board dock); the select only carries the value.
  document.querySelector(".board-field").hidden = true;
  elements["board-dock"].hidden = !browsing && !searching;
  elements["search-input"].placeholder = saved ? "제목, 메모, 태그 검색"
    : text ? textLibrary.searchPlaceholder()
    : collections ? "작품 제목 검색" : "제목, 작성자, 분류 검색";
  elements["catalog-title"].textContent = saved ? "기록"
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
  headerFold.reset();
  syncFilterChips();
  void renderCategoryChips();
  renderActiveFilters();
  elements["search-clear"].hidden = !elements["search-input"].value;
  syncFilterSheetFields();
  if (text) applyTextSortOptions();
}

// The filter sheet holds only what is not already a chip on screen, and 필터 shows only when the
// sheet has something in it. 형식 moves into the sheet when a board's 분류 chips take its row.
function syncFilterSheetFields() {
  const searching = currentDestination === "search";
  const browsing = currentDestination === "browse";
  const saved = currentDestination === "bookmarks";
  const text = currentDestination === "text";
  const posts = (searching || browsing) && currentScope === "posts";
  const collections = currentScope === "collections";
  const fields = [
    [elements["mode-filter"].closest("label"), posts && (searching || elements["mode-chips"].hidden)],
    [document.querySelector(".search-target-field"), searching && posts],
    [document.querySelector(".search-match-field"), searching && posts],
    [document.querySelector(".collection-kind-field"), searching && collections],
    [document.querySelector(".collection-read-field"), !saved && collections],
  ];
  for (const [field, shown] of fields) field.hidden = !shown;
  const empty = !fields.some(([, shown]) => shown);
  elements["filter-toggle"].hidden = saved || text || empty || (browsing && !isNarrowScreen());
}

// The board's 분류 row takes the format chips' place: one board is almost always one format, and
// the format stays in the filter sheet. Counts come from the search index (worker), per board.
const categoryCache = new Map();
let categoryRender = 0;
async function renderCategoryChips() {
  const row = elements["category-chips"];
  const boardId = elements["board-filter"].value;
  const shown = ["browse", "search"].includes(currentDestination) && currentScope === "posts" && Boolean(boardId);
  const render = ++categoryRender;
  if (!shown) {
    row.hidden = true;
    return;
  }
  const mode = elements["mode-filter"].value;
  const key = `${boardId}|${mode}`;
  if (!categoryCache.has(key)) {
    categoryCache.set(key, workerRequest({ type: "categories", boardId, mode }).catch(() => {
      categoryCache.delete(key);
      return [];
    }));
  }
  const categories = await categoryCache.get(key);
  if (render !== categoryRender) return;
  const total = categories.reduce((sum, item) => sum + item.count, 0);
  const selected = activeCategory();
  row.hidden = categories.length < 2;
  if (row.hidden) return;
  elements["mode-chips"].hidden = true;
  syncFilterSheetFields();
  const chip = (label, value, count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.category = value;
    button.setAttribute("aria-pressed", String(value === selected));
    const number = document.createElement("small");
    number.textContent = count.toLocaleString("ko-KR");
    button.append(label, " ", number);
    return button;
  };
  row.replaceChildren(chip("전체", "", total), ...categories.slice(0, 40).map((item) => chip(item.label, item.label, item.count)));
  // A link or Back can land on a category further along the row.
  row.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    button.ariaLabel = `${item.label} 조건 해제`;
    button.append(item.label, svgIcon("m6 6 12 12M18 6 6 18"));
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
    elements["result-bar"].before(elements["catalog-controls"]);
  }
}

// Filters edited as a draft in the phone sheet. Sort sits in the result bar and applies at once.
const sheetFilterIds = ["mode-filter", "search-target", "search-match", "collection-kind-filter", "collection-read-filter"];

function resetSheetFilterValues() {
  elements["mode-filter"].value = "all";
  elements["search-target"].value = "all";
  elements["search-match"].value = "and";
  elements["collection-kind-filter"].value = "all";
  elements["collection-read-filter"].value = "all";
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

// Aa (docs/24 §8.8): the most used reading controls above the dock; 모든 설정 opens the sheet.
const quickSettings = document.querySelector("#quick-settings");
overlays.watch(quickSettings, "popover");
function openQuickSettings() {
  document.querySelector("#quick-size-output").value = String(settings.proseSize);
  renderProfiles();
  quickSettings.showPopover();
}
document.querySelector("#quick-all-settings").addEventListener("click", () => {
  quickSettings.hidePopover();
  openSettings();
});
for (const input of quickSettings.querySelectorAll("[data-quick-setting]")) {
  input.addEventListener("input", () => {
    settings[input.dataset.quickSetting] = Number(input.value);
    applySettings();
    clearTimeout(typographyPersistTimer);
    typographyPersistTimer = setTimeout(() => {
      typographyPersistTimer = null;
      persistUserState();
    }, 250);
  });
}

function openSettings() {
  if (!elements["settings-dialog"].open) elements["settings-dialog"].showModal();
  void renderOfflineStorage();
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
  if (state.query !== current.query || state.boardId !== current.boardId || (state.category ?? "") !== current.category ||
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

function cancelReaderSelection(preserveOverlays = false) {
  if (!preserveOverlays) overlays.closeAll("navigate");
  readerViewId += 1;
  postController?.abort();
  readerSession.cancelPendingWork();
}

function showDestination(destination, navigate = true, view = destination === "bookmarks" ? "bookmarks" : "all", { focusSearch = true, preserveOverlays = false } = {}) {
  if (destination === "library") applyUpdateAtSafePoint();
  if (destination === "settings") {
    openSettings();
    document.title = "읽기 설정 — ReDSTM";
    if (navigate && location.pathname !== "/settings") {
      history.pushState({ redstmSettings: true }, "", "/settings");
    }
    return;
  }
  let textReady;
  const wasText = currentDestination === "text";
  if (wasText && destination !== "text") textLibrary.leave();
  if (currentSummary) persistReadingPosition();
  else if (currentDestination !== "library") persistCatalogState();
  cancelReaderSelection(preserveOverlays);
  setImmersive(false, false);
  const leavingCatalog = ["browse", "search"].includes(currentDestination);
  if (destination !== currentDestination && !catalogConditionsRemembered) rememberCatalogConditions();
  catalogConditionsRemembered = false;
  // Browse has no search field, so no words may filter it unseen (a /browse?q= link included).
  if (destination === "browse") elements["search-input"].value = "";
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
  document.title = `${destination === "library" ? "홈" : destination === "browse" ? `${catalogLabel} 둘러보기` : destination === "search" ? `${catalogLabel} 검색` : destination === "text" ? "텍스트 장서" : "기록"} — ReDSTM`;
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
  closeMobileReader(destination === "search" && navigate && focusSearch);
  if (destination === "text") {
    const params = navigate && !wasText ? new URLSearchParams() : new URLSearchParams(location.search);
    textReady = textLibrary.open(params);
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
  return textReady;
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

// One request/response round trip to the search worker (answered in handleWorkerMessage).
function workerRequest(message) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    searchWorker.postMessage({ ...message, id });
  });
}

function resolvePosts(summaries) {
  const identities = summaries.map(postIdentity).filter(Boolean);
  if (!identities.length) return Promise.resolve([]);
  return workerRequest({ type: "resolve", identities });
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
  // Records only know where they point once the index resolves them; the mini bar can now show.
  miniBar.render(miniBarModel());
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
  const initializedRoute = routeHandled;
  if (!routeHandled) {
    routeHandled = true;
    synthesizeParentEntry();
  }
  closeReaderMore();
  kwic.close();
  if (initializedRoute) personalLibrary?.close();
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
        await showDestination(destination, false, currentView, { preserveOverlays: !initializedRoute });
        if (destination !== "library") syncSearchRoute();
        // The installed app's 이어서 읽기 shortcut (manifest) resumes straight away.
        if (destination === "library" && new URLSearchParams(location.search).has("continue")) {
          history.replaceState(null, "", "/");
          // Reading records only point at archive objects once they are resolved against the index.
          await savedEntriesReady.catch(() => {});
          await renderContinueCard();
          if (!elements["continue-block"].hidden) elements["continue-reading"].click();
        }
      }
    }
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.has("kwic")) await openWorkSearch(searchParams.get("kwic"), searchParams.get("kwicAll") === "1");
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
    else pending.resolve(data.type === "page" || data.type === "discover" ? data : data.type === "categories" ? data.categories : data.summaries);
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
    elements["archive-state"].textContent = readyLabel();
    latestPosts = data.recentPosts;
    publishedAt = data.publishedAt;
    searchSupportsAa = data.hasIsAa;
    searchStats = Boolean(data.hasStats);
    refreshSortChoices();
    elements["mode-filter"].disabled = !searchSupportsAa;
    if (!searchSupportsAa) elements["mode-filter"].value = "all";
    boardById = new Map((data.boardMetadata ?? []).map((board) => [board.board_id, board]));
    populateBoardFilter();
    elements["result-list"].classList.remove("loading");
    // The text library boots on its own (see the end of this module); do not reset it here.
    const textAlreadyOpen = currentDestination === "text";
    if (!textAlreadyOpen) renderCover();
    if (routeSummary()) requestSearch();
    savedEntriesReady = hydrateSavedEntries();
    void savedEntriesReady.then(() => {
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
    category: activeCategory(),
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
  const bookmarkByIdentity = tokens.length ? stateLookup().bookmarks : null;
  return entries
    .map((entry) => entry.summary)
    .filter((post) => !board || post.board_id === board)
    .filter((post) => mode === "all" || (mode === "aa") === Boolean(post.is_aa))
    .filter((post) => {
      if (!tokens.length) return true;
      const bookmark = bookmarkByIdentity.get(postIdentity(post));
      const searchText = target === "title" ? normalized(post.title) : target === "author" ? normalized(post.author) :
        normalized([post.title, post.author, post.category, boardLabel(post.board_id), bookmark?.note, ...(bookmark?.tags ?? [])].join(" "));
      return match === "or"
        ? tokens.some((token) => searchText.includes(token))
        : tokens.every((token) => searchText.includes(token));
    });
}

function renderCurrentView() {
  if (currentDestination === "text") return void textLibrary.searchChanged(elements["search-input"].value);
  if (currentView === "reading") return void renderReadingView();
  if (currentView === "excerpts") return void renderExcerptsView();
  if (currentView === "stats") return void renderStatsView();
  if (currentScope === "collections") return void renderCollectionCatalog();
  if (currentView === "all") return requestSearch();
  const entries = currentView === "history" ? historyEntries : bookmarks;
  const posts = localResults(entries);
  const label = currentView === "history" ? "최근 읽음" : "저장한 글";
  // Saved novel chapters and Arcalive posts live in the text library; list them here too.
  const textSaved = currentView === "bookmarks" ? textLibrary.savedItems(elements["search-input"].value) : [];
  const total = posts.length + textSaved.length;
  renderResults(posts, total
    ? `${label} ${total}건${textSaved.length ? ` (텍스트 ${textSaved.length})` : ""} · 이 브라우저` : `${label}이 없습니다`);
  if (textSaved.length) {
    elements["search-widen"].hidden = true;
    elements["result-list"].append(...textSaved.map((item) => textResultElement(item)));
  }
}

// A text library row in 보관함; it opens through the text library's own routes.
function textResultElement({ title, meta, note = "", badge = "", listRoute, route = "" }) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item text-result";
  button.dataset.textListRoute = listRoute;
  if (route) button.dataset.textRoute = route;
  button.dataset.key = `text:${route || listRoute}`;
  const titleLine = document.createElement("span");
  titleLine.className = "result-title-line";
  const heading = document.createElement("strong");
  heading.className = "result-title";
  heading.textContent = title;
  titleLine.append(heading);
  if (badge) {
    const badges = document.createElement("span");
    badges.className = "result-badges";
    const part = document.createElement("span");
    part.textContent = badge;
    badges.append(part);
    titleLine.append(badges);
  }
  const metaLine = document.createElement("span");
  metaLine.className = "result-meta";
  metaLine.textContent = meta;
  button.append(titleLine, metaLine);
  if (note) {
    const noteLine = document.createElement("span");
    noteLine.className = "bookmark-note";
    noteLine.textContent = note;
    button.append(noteLine);
  }
  item.append(button);
  return item;
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
  const novels = await textLibrary.readingWorks().catch(() => []);
  if (currentView !== "reading") return;
  renderedResults = inProgress;
  renderedCollections = collections;
  resultTotal = inProgress.length + collections.length + novels.length;
  elements["search-empty"].hidden = true;
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const lookup = stateLookup();
  const fragment = document.createDocumentFragment();
  inProgress.forEach((post, index) => { fragment.append(resultItemElement(post, index, lookup)); });
  for (const collection of collections) fragment.append(collectionItemElement(collection));
  for (const work of novels) {
    fragment.append(textResultElement({
      title: work.title, meta: ["소설", work.meta].filter(Boolean).join(" · "),
      badge: work.newCount ? `새 ${work.newCount}화` : "", listRoute: work.listRoute,
    }));
  }
  elements["result-list"].append(fragment);
  const failedNote = collectionProgressFailedBoards.size ? " · 일부 읽기 상태 미확인" : "";
  elements["result-status"].textContent = resultTotal
    ? `읽는 중 ${resultTotal}건 · 이 브라우저${failedNote}`
    : (failedNote ? "읽기 상태를 확인하지 못했습니다" : "읽는 중인 글이나 작품이 없습니다");
  updateLoadMore();
}

function resultItemElement(post, index, lookup) {
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
  const bookmark = lookup.bookmarks.get(identity);
  const history = lookup.history.get(identity);
  const readLabel = postReadingLabel(history?.progress, { seen: Boolean(history) });
  for (const [visible, label] of [[post.is_aa === true, "AA"], [Boolean(readLabel), readLabel]]) {
    if (!visible) continue;
    const badge = document.createElement("span");
    badge.textContent = label;
    badges.append(badge);
  }
  // Every row in 기록 › 저장 is saved; elsewhere the mark says which ones are.
  if (bookmark && currentView !== "bookmarks") badges.append(savedMark());
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
    [popularityLabel(post.views, post.comment_count), "result-stats"],
  ].filter(([node]) => node)) {
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

// Reading and bookmark records by post identity, built once per list render.
function stateLookup() {
  return {
    history: historyByIdentityMap(),
    bookmarks: new Map(bookmarks.map((entry) => [postIdentity(entry.summary), entry])),
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
  const widening = actions.length > 0;
  // The same words may name a novel or an Arcalive work in the text library.
  actions.push(["text:novel", "소설에서 찾기"], ["text:arcalive", "아카라이브 작품에서 찾기"]);
  host.hidden = false;
  const lead = document.createElement("p");
  // Where nothing was found, so 0건 reads as "not here" rather than "not anywhere" (DESIGN §7.10).
  const target = elements["search-target"].value === "all" ? "제목·작성자·분류" : elements["search-target"].selectedOptions[0].textContent.replace(/만$/, "");
  lead.textContent = `${elements["board-dock-name"].textContent || "전체 게시판"} · ${target}에서 찾은 글이 없습니다. `
    + (widening ? "조건을 한 단계 넓혀 보거나 텍스트 장서에서 찾아보세요." : "텍스트 장서에서도 찾아볼 수 있습니다.");
  host.append(lead);
  for (const [key, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.widen = key;
    button.addEventListener("click", () => {
      if (key.startsWith("text:")) searchTextLibrary(key.slice(5));
      else if (key === "reset") resetFilters();
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

// status is the bare count text; catalogStatus() adds the active filter labels on top.
function renderResults(posts, status) {
  renderedResults = posts;
  resultCountText = status;
  elements["search-empty"].hidden = true;
  elements["result-status"].textContent = catalogStatus(status);
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const lookup = stateLookup();
  const fragment = document.createDocumentFragment();
  posts.forEach((post, index) => { fragment.append(resultItemElement(post, index, lookup)); });
  elements["result-list"].append(fragment);
  renderWidenActions(!posts.length);
  updateLoadMore();
  restoreCatalogPosition();
}

// Append the next page in place so paging deeper keeps the already-loaded rows, the reader's
// prev/next-post adjacency, and the current scroll position instead of resetting the list.
function appendResults(posts) {
  const lookup = stateLookup();
  const fragment = document.createDocumentFragment();
  const base = renderedResults.length;
  posts.forEach((post, index) => { fragment.append(resultItemElement(post, base + index, lookup)); });
  elements["result-list"].append(fragment);
  renderedResults = renderedResults.concat(posts);
  resultCountText = `${resultTotal.toLocaleString("ko-KR")}건`;
  elements["result-status"].textContent = catalogStatus(resultCountText);
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
    collectionStats = Boolean(index.hasStats);
    if (refreshSortChoices()) syncSearchRoute();
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
      .sort(collectionComparator(elements["sort-filter"].value));
    collectionProgressById = progress;
    resultTotal = matches.length;
    renderedCollections = matches.slice(0, offset + RESULT_PAGE_SIZE);
    renderCollectionResults();
  } catch (error) {
    if (requestId === collectionSearchId) renderArchiveError(error, "작품 목록을 열 수 없음");
  }
}

function collectionComparator(sort) {
  const byTitle = (left, right) => titleCollator.compare(left.title, right.title) || left.id - right.id;
  const byCount = (key) => (left, right) => (right[key] ?? 0) - (left[key] ?? 0) || byTitle(left, right);
  if (sort === "longest") return byCount("entry_count");
  if (sort === "views") return byCount("views");
  if (sort === "comments") return byCount("comments");
  if (sort === "updated") {
    return (left, right) => (Date.parse(right.latest_created_at) || 0) - (Date.parse(left.latest_created_at) || 0) ||
      byTitle(left, right);
  }
  return byTitle;
}

// "조회 1.2만 · 댓글 340" when the release carries counts.
const compactNumber = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
function popularityLabel(views, comments) {
  if (!Number.isInteger(views) || !Number.isInteger(comments)) return "";
  return `조회 ${compactNumber.format(views)} · 댓글 ${compactNumber.format(comments)}`;
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
    [popularityLabel(collection.views, collection.comments), "result-stats"],
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
    document.querySelector("#collection-classify").onclick = () => void personalLibrary.openWork({ key: workKey({ source: "typemoon", id: collection.id }), title: collection.title, source: "typemoon" }).then((opened) => { if (!opened) showReaderFeedback("이 기기에 기록을 저장할 수 없어요", 2200); });
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
    void showWorkReadingTime(workKey({ source: "typemoon", id: collection.id }), elements["collection-meta"]);
    void showOfflineControl(collection);
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
      state.textContent = entryState === "finished" ? "다 읽음"
        : entryState === "reading" ? postReadingLabel(historyByIdentity.get(postIdentity(entry))?.progress)
        : entry === continueEntry ? "다음" : "";
      button.classList.toggle("read", entryState === "finished");
      button.append(position, title, state);
      item.append(button);
      fragment.append(item);
    }
    elements["collection-entry-list"].replaceChildren(fragment);
    elements["collection-entry-list"].dataset.collectionId = collection.id;
    fillWorkCover(document.querySelector("#collection-cover"), {
      title: collection.title, source: "타입문넷", hueKey: workKey({ source: "typemoon", id: collection.id }),
      progress: available.length ? finishedEntries.length / available.length : null,
    });
    // The barcode picks an episode through its row, so the list's own navigation stays the one path.
    showWorkBarcode(document.querySelector("#collection-barcode"), collection.entries.map((entry) => ({
      position: entry.position, label: `${entry.position}편`, missing: !entry.object_key, current: entry === lastRead,
      finished: postReadingState(historyByIdentity.get(postIdentity(entry))?.progress) === "finished",
    })), (entry) => elements["collection-entry-list"].querySelector(`.collection-entry[data-key="${entry.position}"]`)?.click(), { unit: "편" });
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
          (typeof summary.latest_created_at !== "string" || !Number.isFinite(Date.parse(summary.latest_created_at)))) ||
        ["views", "comments"].some((key) => summary[key] !== undefined &&
          (!Number.isInteger(summary[key]) || summary[key] < 0))) {
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
    // Collection export revision 3 adds view/comment totals to every summary.
    hasStats: summaries.size > 0 && [...summaries.values()].every((summary) =>
      Number.isInteger(summary.views) && Number.isInteger(summary.comments)),
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
  let found = null;
  try {
    found = await onlineCollectionDetail(collectionId);
  } catch (error) {
    const saved = await savedCollection(collectionId);
    if (saved) return saved;
    throw error;
  }
  return found ?? savedCollection(collectionId);
}

async function savedCollection(collectionId) {
  const store = await ownerStore();
  const snapshot = store ? await store.get("offline", workKey({ source: "typemoon", id: collectionId })) : null;
  return snapshot?.descriptor ? validateCollection(snapshot.descriptor) : null;
}

async function onlineCollectionDetail(collectionId) {
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
  // Hold the step buttons until membership decides whether they mean "episode" or "list row";
  // a list refresh that lands first must not release them (typeMoonNavigation reads this).
  collectionPending = true;
  renderReaderNavigation({ ...typeMoonNavigation(), pending: true });
  try {
    const membership = await findCollection(summary);
    if (!samePost(summary, currentSummary)) return;
    collectionPending = false;
    currentCollection = membership;
    if (membership) {
      readerSession.workId = `typemoon:collection:${membership.collection.id}`;
      // The session and a work's own profile follow the work once it is known.
      if (readingSession?.documentId === readerSession.documentKey) readingSession.workKey = readerSession.workId;
      applyWorkProfile();
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
    if (!samePost(summary, currentSummary)) return;
    collectionPending = false;
    updateNavigation();
  }
}

// navigation: "push" enters the Reader from a list or Home, "replace" moves within the same
// reading session (previous/next, another row of a visible side list), "route" follows history.
async function loadPost(summary, navigation = "push", { listHint = "" } = {}) {
  if (navigation === "push") applyUpdateAtSafePoint();
  const viewId = ++readerViewId;
  if (currentSummary) persistReadingPosition();
  readerSession.cancelPendingWork();
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  if (!currentSummary && currentDestination === "library") {
    renderCover("본문을 불러오는 중", "보존 객체를 확인하고 있습니다.", false);
  }
  const requestController = postController;
  readerSession.track(() => requestController.abort());
  try {
    const resolved = summary?.object_key ? summary : (await resolvePosts([summary]))[0];
    if (viewId !== readerViewId) return;
    if (!resolved?.object_key) throw new Error("현재 보존본에서 글을 찾을 수 없습니다");
    const response = await fetch(`/archive/${resolved.object_key}`, { signal: postController.signal });
    requireArchiveResponse(response, response.status === 404 ? "보존 객체가 없습니다" : `본문 응답 ${response.status}`);
    const payload = await responseJsonWithProgress(response, "본문");
    if (viewId !== readerViewId) return;
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
    elements["archive-state"].textContent = readyLabel();
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
  readerDocument = { key: `typemoon:${post.board_id}:${post.external_post_id}`, title: post.title || "제목 없음", workId: continuous.transitioning ? readerSession.workId : "" };
  continuous.prepare(readerDocument);
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
  const nextUrl = `/read/${currentSummary.board_id}/${currentSummary.external_post_id}`;
  // Only entering the Reader adds a history entry. Episode moves replace it, so one Back
  // returns to the list. Commit before the title becomes visible so reload reopens this post.
  if (navigation === "push") {
    history.pushState({ redstmReader: true, redstmParent: currentRoute(), ...(listHint ? { redstmList: listHint } : {}) }, "", nextUrl);
  } else {
    history.replaceState({ ...(history.state ?? {}), redstmReader: true, redstmCollection: false }, "", nextUrl);
  }
  const continuing = readerSource === "typemoon";
  setReaderSource("typemoon");
  resetReaderChrome();
  if (!continuing) collapseCatalogForReading();
  elements["reader-kicker"].textContent = [boardLabel(post.board_id) || post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  document.title = `${post.title || "제목 없음"} — ReDSTM`;
  renderPostMeta(post, payload.comments.length);
  setSourceLink(post.canonical_url);
  renderPostBody();
  beginReaderDocument(`typemoon:${postIdentity(currentSummary)}`, "", currentSummary.object_key?.match(/-([a-f0-9]{64})\.json\.(?:gz|zst)$/)?.[1] || "");
  const joined = continuous.commit(readerDocument);
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  void updateCollection();
  refreshCatalogRows();
  // Reads the parent route from history.state, so it runs after the entry above is written.
  void refreshTypeMoonList();
  openMobileReader();
  updateShellMode();
  readerSession.frame(() => {
    elements["reader-title"].focus({ preventScroll: true });
    if (joined) { syncScrollBaseline(); readerSession.capture(); }
    else restoreReadingPosition(currentSummary);
  });
}

// Author · date · views · comments; a named author is a link to their other posts.
function renderPostMeta(post, commentCount) {
  const meta = elements["reader-meta"];
  meta.replaceChildren();
  if (post.author) {
    const author = document.createElement("button");
    author.type = "button";
    author.className = "reader-author";
    author.textContent = post.author;
    author.title = `${post.author}의 다른 글`;
    author.addEventListener("click", () => searchAuthor(post.author));
    meta.append(author);
  } else meta.append("작성자 없음");
  const rest = [
    formatSourceDate(post.created_at_raw) || post.created_at_raw,
    `조회 ${compactNumber.format(post.views ?? 0)}`,
    commentCount ? `댓글 ${commentCount.toLocaleString("ko-KR")}` : "",
  ].filter(Boolean);
  if (rest.length) meta.append(` · ${rest.join(" · ")}`);
}

function searchAuthor(author) {
  setScope("posts");
  resetSheetFilterValues();
  elements["board-filter"].value = "";
  elements["sort-filter"].value = "latest";
  elements["search-input"].value = author;
  elements["search-target"].value = "author";
  // Results, not typing: keep the phone keyboard down.
  showDestination("search", true, "all", { focusSearch: false });
}

function renderPostBody() {
  const post = currentPayload.post;
  const identity = `${post.board_id}:${post.external_post_id}`;
  const override = settings.viewModes[identity];
  currentMode = override ?? (post.is_aa ? "aa" : "prose");
  if (scrollAdapter) scrollAdapter.mode = currentMode === "aa" ? "aa" : "scroll";
  const isAa = currentMode === "aa";
  elements["archive-body"].classList.toggle("aa", isAa);
  elements["archive-body"].ariaLabel = isAa ? "AA 본문 · 좌우로 이동하거나 두 손가락으로 확대할 수 있습니다" : "글 본문";
  elements["aa-controls"].hidden = !isAa;
  if (!isAa && document.fullscreenElement === elements["aa-host"]) void document.exitFullscreen().catch(() => {});
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
  updateReaderLength();
  if (isAa) restoreAaView();
  else requestAnimationFrame(() => updateAaOverflowCue(true));
  findAaScenes();
  applyReadingMode();
  paintAnnotations();
}

function normalizeReaderTypography(container) {
  for (const element of container.querySelectorAll('font, [style*="font" i], [style*="line-height" i]')) {
    for (const property of ["font-family", "font-size", "line-height"]) {
      element.style.setProperty(property, "inherit", "important");
    }
  }
}

// The gallery over the body's pictures (gallery.js). One instance at a time; closing the dialog
// (닫기, Back, Esc, a drag down) or leaving the document destroys it.
let gallery = null;
let galleryRequest = 0;

async function openImageViewer(target) {
  const dialog = elements["image-viewer"];
  const request = ++galleryRequest;
  gallery?.destroy();
  elements["image-viewer-zoom"].hidden = true;
  elements["image-viewer-source"].href = target.dataset.image ?? target.currentSrc ?? target.src ?? "#";
  if (!dialog.open) dialog.showModal();
  const opened = await openGallery({
    container: elements["archive-body"], target, appendTo: elements["image-viewer-stage"],
    onChange: showGalleryItem,
    onClose: () => {
      if (gallery !== opened) return;
      gallery = null;
      if (dialog.open) dialog.close();
    },
  });
  if (request !== galleryRequest || !dialog.open) return void opened?.destroy();
  if (!opened) {
    dialog.close();
    showReaderFeedback("이미지를 열 수 없습니다", 2200);
    return;
  }
  gallery = opened;
}

// 원본 열기 follows the picture on screen; 실제 크기 only matters for one larger than the screen.
function showGalleryItem(item) {
  if (!item) return;
  elements["image-viewer-source"].href = item.src;
  const stage = elements["image-viewer-stage"];
  elements["image-viewer-zoom"].hidden = item.width <= stage.clientWidth && item.height <= stage.clientHeight;
  elements["image-viewer-zoom"].setAttribute("aria-pressed", "false");
  elements["image-viewer-zoom"].textContent = "실제 크기";
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
    date.textContent = formatSourceDate(comment.created_at_raw) || comment.created_at_raw || "";
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
  elements["end-comments-count"].textContent = elements["comment-count"].textContent;
  // Comments sit right under the text and start unfolded, so the chapter end needs no shortcut.
  elements["end-comments"].hidden = true;
  setCommentsOpen(comments.length > 0);
  applySettings();
}

// Comments are one DOM below the body (docs/24 §8.7 D14), folded with hidden="until-found" so the
// browser's find still reaches them; where that is not supported the value acts as plain hidden
// and the heading button unfolds them.
function setCommentsOpen(open) {
  if (open) elements["comment-list"].hidden = false;
  else elements["comment-list"].setAttribute("hidden", "until-found");
  elements["comments-toggle"].setAttribute("aria-expanded", String(open));
}

function rememberHistory(summary) {
  const previous = historyEntries.find((entry) => samePost(entry.summary, summary));
  historyEntries = historyEntries.filter((entry) => !samePost(entry.summary, summary));
  historyEntries.unshift({ ...previous, summary, readAt: new Date().toISOString(), scroll: previous?.scroll ?? 0, progress: previous?.progress ?? 0 });
  // Newest first: the oldest records go once the cap is passed, so the saved state (rewritten
  // on every scroll pause) cannot grow until localStorage runs out.
  if (historyEntries.length > HISTORY_LIMIT) historyEntries.length = HISTORY_LIMIT;
  persistUserState();
}

function isNarrowScreen() {
  return matchMedia("(max-width: 759px)").matches;
}

// The stored pixel offset. In page mode the pane never scrolls, so it records only whether the
// reader is at the start (0) — restore treats 0 as "the top", not as a sentence to find.
function readingPosition() {
  return paged.active ? paged.page : elements["reader-pane"].scrollTop;
}

function restoreReadingPosition(summary) {
  const entry = historyEntries.find((entry) => samePost(entry.summary, summary));
  const position = entry?.loc ? 0 : entry?.scroll ?? 0;
  lastReaderScroll = position;
  readerScrollDelta = 0;
  elements["reader-pane"].scrollTop = position;
  if (entry?.loc || entry?.anchor) {
    const anchor = { offset: entry.offset, quote: entry.anchor, viewportOffset: entry.anchorTop ?? 0, atStart: entry.scroll === 0, ...(entry.loc ? { loc: entry.loc } : {}) };
    if (!readerSession.restore(anchor) && entry.loc) showReaderFeedback("읽던 문장을 찾지 못했습니다", 2200);
  }
  syncScrollBaseline();
  readerSession.capture();
}

function persistReadingPosition() {
  clearTimeout(scrollTimer);
  if (!currentSummary || !readerSession.canSave) return;
  const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
  if (entry) {
    entry.scroll = readingPosition();
    const anchor = captureReaderPosition();
    if (anchor) Object.assign(entry, {
      offset: anchor.offset, anchor: anchor.quote, anchorTop: Math.round(anchor.viewportOffset), loc: anchor.loc,
      revision: readerSession.rev, documentId: readerSession.documentKey, workId: readerSession.workId,
    });
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
  if (!readerSession.canSave) return;
  scrollTimer = setTimeout(persistReadingPosition, 250);
}

function updateReadingProgress() {
  if (!readerSource) return;
  const progress = bodyProgress();
  elements["reading-progress"].style.width = `${progress * 100}%`;
  elements["reader-topbar-progress"].textContent = `${Math.round(progress * 100)}%`;
  elements["reader-status"].textContent = paged.active ? `${paged.page + 1} / ${paged.pages}쪽` : `${Math.round(progress * 100)}%`;
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
  refreshCatalogRows();
}

// Re-draws the visible catalog rows (active row, read/saved badges) without a new search.
function refreshCatalogRows() {
  if (currentDestination === "text") return;
  if (currentView === "bookmarks" || currentView === "reading") renderCurrentView();
  else if (currentScope === "collections") renderCollectionResults();
  else renderResults(renderedResults, resultCountText);
}

function updateNavigation() {
  if (readerSource === "typemoon") renderReaderNavigation(typeMoonNavigation());
}

// Where this episode sits in its work, for the chapter-end card: only this one is "reading".
function collectionRun(collection, index) {
  const read = historyByIdentityMap();
  return {
    position: index + 1, total: collection.entries.length, unit: "편",
    entries: collection.entries.map((entry, at) => ({
      position: entry.position,
      state: !entry.object_key ? "missing" : at === index ? "reading"
        : postReadingState(read.get(postIdentity(entry))?.progress) === "finished" ? "read" : "unread",
    })),
  };
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
      run: collectionRun(collection, index),
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
    pending: collectionPending || (!located && Boolean(listContext?.loading)),
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
  // Posts found through 오늘의 발견 read on in their own board.
  if (url.pathname === "/" && state.redstmList === "board") return boardOnly(currentSummary.board_id);
  if (url.pathname === "/" && state.redstmList === "recent") {
    return { kind: "items", items: historyEntries.map((entry) => entry.summary), kicker: "홈", title: "최근 읽은 글", qualifier: "현재 목록" };
  }
  if (url.pathname === "/browse" || url.pathname === "/search") {
    const query = url.searchParams;
    const params = {
      query: query.get("q") ?? "",
      boardId: query.get("board") ?? "",
      category: query.get("board") ? query.get("category") ?? "" : "",
      mode: searchSupportsAa && ["aa", "prose"].includes(query.get("mode")) ? query.get("mode") : "all",
      sort: allowedSort("posts", query.get("sort")),
      target: ["title", "author"].includes(query.get("target")) ? query.get("target") : "all",
      match: query.get("match") === "or" ? "or" : "and",
    };
    const sortLabel = params.sort === "latest" ? ""
      : sortChoices("posts").find(([, value]) => value === params.sort)?.[0] ?? "";
    const conditions = [
      params.query && params.boardId ? boardLabel(params.boardId) : "",
      params.category,
      params.mode === "aa" ? "AA" : params.mode === "prose" ? "소설·일반" : "",
      sortLabel,
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
  return workerRequest({ type: "page", pageSize: READER_LIST_PAGE, ...params });
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
  return loadPost(target, "replace");
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
  if (button?.dataset.excerptId) return void openExcerpt(button.dataset.excerptId);
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
    if (button.dataset.textListRoute) {
      const route = button.dataset.textRoute;
      openTextFromHome({ identity: "", listRoute: button.dataset.textListRoute, route, progress: 0 }, { listOnly: !route });
    } else if (button.dataset.collectionId) void openCollectionDetail(Number(button.dataset.collectionId), navigation);
    else loadPost(renderedResults[Number(button.dataset.index)], navigation);
  }
});
// 검색 → 텍스트 장서: the same words in the novel works or Arcalive works list.
function searchTextLibrary(lane) {
  const query = elements["search-input"].value.trim();
  const params = new URLSearchParams({ lane, ...(lane === "arcalive" ? { view: "works" } : {}), ...(query ? { q: query } : {}) });
  history.pushState({ redstmText: true, redstmParent: currentRoute() }, "", `/text?${params}`);
  void handleRoute();
}

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
elements["home-onboarding"].addEventListener("click", (event) => {
  const source = event.target.closest("[data-home-source]")?.dataset.homeSource;
  if (source) {
    openBrowseSource(source);
    return;
  }
  if (event.target.closest("#home-onboarding-import")) {
    showDestination("settings");
    elements["import-state"].focus();
  }
});
elements["discover-shuffle"].addEventListener("click", () => {
  discoverShuffle += 1;
  void renderDiscovery();
});
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
elements["more-link"].addEventListener("click", () => {
  closeReaderMore();
  void copyReaderLink();
});
// Stays in the sheet so the toggle's new state is visible.
elements["more-wake"].addEventListener("click", () => setScreenAwake(!wakeWanted));
elements["more-mark-read"].addEventListener("click", () => {
  const count = textLibrary.markPreviousRead();
  closeReaderMore();
  if (count) showReaderFeedback(`이전 ${count.toLocaleString("ko-KR")}화를 읽음으로 표시했습니다`, 2200);
});
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
  const ratio = Number(elements["more-position"].value) / 100;
  scrubTo(ratio);
  elements["more-position-output"].value = `${Math.round(ratio * 100)}%`;
});
// The body follows the slider once per frame; the first move keeps the place it left.
document.querySelector("#scrubber-position").addEventListener("input", (event) => {
  if (!scrubAnchor) {
    scrubAnchor = readerSession.adapter?.captureVisiblePosition() ?? null;
    rememberReturn(scrubAnchor, "이동 전 위치");
  }
  const ratio = Number(event.target.value) / 1000;
  document.querySelector("#scrubber-output").value = `${Math.round(ratio * 100)}%`;
  cancelAnimationFrame(scrubFrame);
  scrubFrame = requestAnimationFrame(() => scrubTo(ratio));
});
document.querySelector("#scrubber-return").addEventListener("click", () => {
  const target = readerReturn;
  scrubber.close();
  if (target && readerSession.restore(target.anchor)) syncScrollBaseline();
  readerReturn = null;
});
// Focusing the badge would unfold the tools and take it away from under the finger mid-tap.
elements["reader-status"].addEventListener("pointerdown", (event) => event.preventDefault());
elements["reader-status"].addEventListener("click", openScrubber);
document.getElementById("reader-topbar-position").addEventListener("click", openScrubber);
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
// Title suggestions follow every keystroke, even mid-composition; the post search over the whole
// archive waits until the Hangul syllable is composed (docs/24 §8.4).
elements["search-input"].addEventListener("input", (event) => {
  elements["result-more"].hidden = true;
  elements["search-clear"].hidden = !elements["search-input"].value;
  updateSuggestions();
  clearTimeout(searchTimer);
  if (event.isComposing) return;
  scheduleSearch();
});
elements["search-input"].addEventListener("compositionend", () => {
  clearTimeout(searchTimer);
  scheduleSearch();
});
function scheduleSearch() {
  searchTimer = setTimeout(() => {
    if (currentDestination === "text") {
      textLibrary.searchChanged(elements["search-input"].value);
      return;
    }
    syncSearchRoute();
    renderCurrentView();
  }, 250);
}

// Suggestions: TypeMoon works and boards, rebuilt only when the archive's index changes.
let suggestSource = null;
let suggestTextSource = "";
let suggestIndex = null;
const suggester = createSuggester(async () => {
  const index = await collectionIndex().catch(() => null);
  if (!index) return null;
  const textWorks = await textLibrary.metadataWorks();
  const source = JSON.stringify(textWorks.map((work) => [work.key, work.title, work.author]));
  if (suggestSource !== index || suggestTextSource !== source) {
    suggestSource = index;
    suggestTextSource = source;
    suggestIndex = createSuggestIndex([
      ...index.summaries.map((collection) => ({ key: `c:${collection.id}`, title: collection.title, kind: "work", id: collection.id,
        meta: [boardLabel(collection.board_id), `${collection.entry_count ?? collection.entries?.length ?? 0}편`] })),
      ...textWorks.map((work) => ({ key: work.key, title: work.title, kind: "text-work", id: work.route, meta: [work.sourceLabel, work.author] })),
      ...[...boardById.values()].map((board) => ({ key: `b:${board.board_id}`, title: boardDisplayName(board, board.board_id), kind: "board", id: board.board_id,
        meta: ["게시판", boardGroupLabel(board.group_name)] })),
    ], { hangul, UFuzzy });
  }
  return suggestIndex;
});

function updateSuggestions() {
  const panel = elements["search-suggest"];
  const query = elements["search-input"].value.trim();
  if (currentDestination !== "search" || !query) {
    suggester.cancel();
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  void suggester.request(query, renderSuggestions);
}

function suggestionRow(hit) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "suggest-row";
  button.dataset.suggestKind = hit.item.kind;
  button.dataset.suggestId = hit.item.id;
  const title = document.createElement("strong");
  const text = hit.item.title;
  // Ranges are over the normalised title; mark them only when it kept the same characters.
  if (hit.ranges.length && [...text].length === [...text.normalize("NFKC")].length) {
    const characters = [...text];
    let cursor = 0;
    for (const [start, end] of hit.ranges) {
      title.append(characters.slice(cursor, start).join(""));
      const mark = document.createElement("mark");
      mark.textContent = characters.slice(start, end).join("");
      title.append(mark);
      cursor = end;
    }
    title.append(characters.slice(cursor).join(""));
  } else title.textContent = text;
  const meta = document.createElement("span");
  meta.textContent = hit.item.meta.filter(Boolean).join(" · ");
  button.append(title, meta);
  item.append(button);
  return item;
}

function renderSuggestions(result) {
  const panel = elements["search-suggest"];
  const groups = [["작품·게시판", result.exact], ["초성", result.choseong], ["비슷한 제목", result.similar]];
  const nodes = [];
  for (const [label, hits] of groups) {
    if (!hits.length) continue;
    const heading = document.createElement("h3");
    heading.textContent = label;
    const list = document.createElement("ul");
    list.append(...hits.slice(0, 5).map(suggestionRow));
    nodes.push(heading, list);
  }
  if (result.qwerty) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggest-qwerty";
    button.dataset.qwerty = result.qwerty;
    button.textContent = `'${result.qwerty}'(으)로 찾을까요?`;
    nodes.push(button);
  }
  panel.replaceChildren(...nodes);
  panel.hidden = !nodes.length;
}

elements["search-suggest"].addEventListener("click", (event) => {
  const qwerty = event.target.closest("[data-qwerty]")?.dataset.qwerty;
  if (qwerty) {
    elements["search-input"].value = qwerty;
    elements["search-input"].dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const row = event.target.closest("[data-suggest-kind]");
  if (!row) return;
  const id = row.dataset.suggestId;
  if (row.dataset.suggestKind === "work") void openCollectionDetail(/^\d+$/.test(id) ? Number(id) : id);
  else if (row.dataset.suggestKind === "text-work") void openPersonalWork({ route: id });
  else {
    elements["search-input"].value = "";
    updateSuggestions();
    selectBoard(row.dataset.suggestId);
  }
});
// Suggestions are for typing. Submitting (the keyboard's 검색) or scrolling the results puts
// them away with the keyboard so the results get the screen; tapping the field brings them back.
function dismissSuggestions() {
  if (elements["search-suggest"].hidden) return;
  suggester.cancel();
  elements["search-suggest"].hidden = true;
  elements["search-input"].blur();
}
// Gestures, not "scroll": new results reset the list's position while the person is still typing.
for (const type of ["touchmove", "wheel"]) elements["result-list"].addEventListener(type, dismissSuggestions, { passive: true });
elements["search-input"].addEventListener("search", () => {
  clearTimeout(searchTimer);
  dismissSuggestions();
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
elements["category-chips"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  setCategory(button.dataset.category);
  for (const chip of elements["category-chips"].querySelectorAll("[data-category]")) {
    chip.setAttribute("aria-pressed", String(chip === button));
  }
  syncSearchRoute();
  renderCurrentView();
  elements["result-list"].scrollTop = 0;
});
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
  else updateSuggestions();
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
    const tab = currentDestination === "text" ? "browse" : currentDestination;
    if (button.dataset.destination === tab && !readerSource) {
      const scroller = document.body.classList.contains("collection-detail-open") ? elements["reader-pane"] : elements["result-list"];
      if (scroller.scrollTop > 0) {
        scroller.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        return;
      }
    }
    // 둘러보기 returns to the source chosen last (DESIGN §8.3).
    if (button.dataset.destination === "browse" && tab !== "browse" && rememberedBrowseSource() !== "typemoon") {
      openBrowseSource(rememberedBrowseSource());
      return;
    }
    if (["browse", "search"].includes(button.dataset.destination)) {
      setScope("posts");
      if (button.dataset.destination !== tab) restoreCatalogConditions(button.dataset.destination);
    }
    showDestination(button.dataset.destination === "browse" && currentDestination === "text" ? "text" : button.dataset.destination);
  });
}
elements["source-switch"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-source]");
  if (button) openBrowseSource(button.dataset.source);
});
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
  const target = trigger.matches(".media-open") ? trigger.querySelector("img") : trigger;
  if (!target || !(target.dataset.image ?? target.src)) return;
  event.preventDefault();
  void openImageViewer(target);
});
elements["image-viewer"].addEventListener("close", () => {
  galleryRequest += 1;
  gallery?.destroy();
  gallery = null;
});
elements["image-viewer-zoom"].addEventListener("click", () => {
  const slide = gallery?.currSlide;
  if (!slide) return;
  const actual = elements["image-viewer-zoom"].getAttribute("aria-pressed") !== "true";
  slide.zoomTo(actual ? 1 : slide.zoomLevels.initial, undefined, 200);
  elements["image-viewer-zoom"].setAttribute("aria-pressed", String(actual));
  elements["image-viewer-zoom"].textContent = actual ? "화면에 맞춤" : "실제 크기";
});
elements["image-viewer-share"].hidden = !navigator.share;
elements["image-viewer-share"].addEventListener("click", () => {
  const url = gallery?.currSlide?.data.src;
  if (url) navigator.share({ url }).catch(() => { /* dismissed */ });
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

// 화면 탭으로 넘기기 (setting): a still tap in the lower part of the screen scrolls one screen
// down, in the upper part one screen up, keeping two lines of the previous screen for context.
// The middle band still toggles the bars. Returns true when the tap turned a page.
const PAGE_BACK_ZONE = 0.25;
const PAGE_FORWARD_ZONE = 0.6;
let pagingScroll = false;
let pagingTimer;

// A page turn or scene move is not a reading scroll: it must not bring the bars back or hide them.
function holdChromeDuringScroll() {
  pagingScroll = true;
  clearTimeout(pagingTimer);
  pagingTimer = setTimeout(() => { pagingScroll = false; }, 800);
}

function pageByTap(event) {
  const pane = elements["reader-pane"];
  const rect = pane.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  const direction = ratio < PAGE_BACK_ZONE ? -1 : ratio > PAGE_FORWARD_ZONE ? 1 : 0;
  if (!direction) return false;
  readerSession.markUserScroll();
  if (direction > 0) setReaderChromeHidden(true);
  const line = settings.proseSize * settings.lineHeight;
  const bottomBar = document.body.classList.contains("reader-controls-hidden") ? 0
    : document.querySelector(".reader-bottom")?.getBoundingClientRect().height ?? 0;
  const distance = Math.max(line, pane.clientHeight - readerTopInset() - bottomBar - 2 * line);
  holdChromeDuringScroll();
  pane.scrollBy({
    top: direction * distance,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  return true;
}

elements["reader-pane"].addEventListener("scrollend", () => { pagingScroll = false; });
// Progress reads layout; once per frame is enough however many scroll events a fling sends.
let progressFrame = 0;
function scheduleReadingProgress() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    updateReadingProgress();
  });
}

elements["reader-pane"].addEventListener("scroll", () => {
  queueScrollSave();
  scheduleReadingProgress();
  const current = elements["reader-pane"].scrollTop;
  readerSession.observeScroll(current);
  continuous.observeScroll(current);
  scheduleAaScene();
  const delta = current - lastReaderScroll;
  lastReaderScroll = current;
  if (readerSession.keyboardOpen) return;
  if (!document.body.classList.contains("reader-open")) return;
  if (current < 80 || readerAtEnd()) {
    setReaderChromeHidden(false);
    return;
  }
  if (pagingScroll) {
    readerScrollDelta = 0;
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
  lastPointerType = event.pointerType;
  pointerStart = event.isPrimary
    ? { x: event.clientX, y: event.clientY, time: event.timeStamp, scroll: elements["reader-pane"].scrollTop }
    : null;
}, { passive: true });
elements["reader-pane"].addEventListener("pointercancel", () => { pointerStart = null; }, { passive: true });
elements["reader-pane"].addEventListener("pointerup", (event) => {
  const start = pointerStart;
  pointerStart = null;
  if (paged.active && start && finishPageGesture(event, start)) return;
  if (!start || event.pointerType === "mouse" || !document.body.classList.contains("reader-open")) return;
  if (event.target.closest("a, button, input, select, textarea, label, summary, img, [role='button'], .media-figure, .chapter-end, .reader-list, .reader-topbar, .reader-toolbar")) return;
  const still = Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10 &&
    event.timeStamp - start.time <= 500 &&
    Math.abs(elements["reader-pane"].scrollTop - start.scroll) <= 4;
  if (!still || String(getSelection() ?? "")) return;
  if (annotationAtPoint(event.clientX, event.clientY)) return;
  if (currentMode === "aa") return void aaTap(event.timeStamp);
  if (settings.tapPaging === "on" && pageByTap(event)) return;
  setReaderChromeHidden(!document.body.classList.contains("reader-controls-hidden"));
});
elements["reader-pane"].addEventListener("pointermove", (event) => {
  if (paged.active && pointerStart && event.pointerType !== "mouse") followPageGesture(event, pointerStart);
  if (pointerStart && Math.abs(event.clientY - pointerStart.y) > 4) readerSession.markUserScroll();
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
for (const choice of document.querySelectorAll("button[data-reader-surface]")) {
  choice.addEventListener("click", () => {
    settings.readerSurface = choice.dataset.readerSurface;
    saveSettings();
  });
}
// Brightness and warmth are overlays: they never reflow the text, so no anchor is needed.
for (const [id, key] of [["reader-dim", "readerDim"], ["reader-warm", "readerWarm"]]) {
  elements[id].addEventListener("input", () => {
    settings[key] = Number(elements[id].value);
    applySettings();
    clearTimeout(typographyPersistTimer);
    typographyPersistTimer = setTimeout(() => {
      typographyPersistTimer = null;
      persistUserState();
    }, 250);
  });
}
for (const choice of document.querySelectorAll("button[data-aa-auto-fit]")) {
  choice.addEventListener("click", () => {
    settings.aaAutoFit = choice.dataset.aaAutoFit;
    saveSettings();
  });
}
for (const choice of document.querySelectorAll("button[data-reading-mode]")) {
  choice.addEventListener("click", () => {
    settings.readingMode = choice.dataset.readingMode;
    saveSettings();
    applyReadingMode();
  });
}
elements["comments-toggle"].addEventListener("click", () => setCommentsOpen(Boolean(elements["comment-list"].hidden)));
elements["comment-list"].addEventListener("beforematch", () => elements["comments-toggle"].setAttribute("aria-expanded", "true"));
elements["page-hint"].addEventListener("click", () => {
  elements["page-hint"].hidden = true;
  try {
    localStorage.setItem(PAGE_HINT_KEY, "1");
  } catch { /* shown again next time */ }
});
new ResizeObserver(() => relayoutPages()).observe(elements["reader-pane"]);
// Focus or find can scroll a clipped box; in page mode only the transform may move the text.
for (const clipped of [elements.reader, elements["reader-pane"]]) {
  clipped.addEventListener("scroll", () => {
    if (!paged.active) return;
    clipped.scrollLeft = 0;
    clipped.scrollTop = 0;
  }, { passive: true });
}
for (const choice of document.querySelectorAll("button[data-home-quote]")) {
  choice.addEventListener("click", () => {
    settings.homeQuote = choice.dataset.homeQuote;
    saveSettings();
  });
}
for (const choice of document.querySelectorAll("button[data-tap-paging]")) {
  choice.addEventListener("click", () => {
    settings.tapPaging = choice.dataset.tapPaging;
    saveSettings();
  });
}
// 앱으로 설치: offered only when the browser says this page can be installed.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  elements["install-app"].hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  elements["install-app"].hidden = true;
});
elements["install-app"].addEventListener("click", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  elements["install-app"].hidden = true;
  await prompt.prompt().catch(() => {});
});
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
let typographyPersistTimer = null;
function changeTypography(mutate) {
  const keepAnchor = readerSource && currentMode === "prose";
  const anchor = keepAnchor ? readerSession.capture() : null;
  mutate();
  // Sliders fire on every step: apply at once, write the whole state once they settle.
  applySettings();
  clearTimeout(typographyPersistTimer);
  typographyPersistTimer = setTimeout(() => {
    typographyPersistTimer = null;
    persistUserState();
  }, 250);
  if (anchor) {
    readerSession.restore(anchor);
    syncScrollBaseline();
  }
}
for (const [id, key] of [["prose-size", "proseSize"], ["line-height", "lineHeight"], ["prose-width", "proseWidth"], ["prose-margin", "proseMargin"], ["aa-size", "aaSize"],
  ["paragraph-spacing", "paragraphSpacing"], ["text-indent", "textIndent"]]) {
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
for (const choice of document.querySelectorAll("button[data-prose-align]")) {
  choice.addEventListener("click", () => changeTypography(() => {
    settings.proseAlign = choice.dataset.proseAlign;
  }));
}
for (const button of document.querySelectorAll("[data-aa-preset]")) {
  button.addEventListener("click", () => {
    const [size, width] = button.dataset.aaPreset.split(":");
    settings = { ...settings, aaSize: Number(size), aaCanvasWidth: width === "auto" ? null : Number(width), aaZoom: 1 };
    // A preset is a fresh start for the open picture too.
    rememberAaView({ zoom: null });
    aaAutoZoom = null;
    saveSettings();
    showZoomFeedback();
  });
}
for (const button of document.querySelectorAll("[data-aa-zoom-delta]")) {
  // Steps from the zoom on screen (this picture's own, when it has one), not the default zoom.
  button.addEventListener("click", () => setAaZoom(effectiveAaZoom() + Number(button.dataset.aaZoomDelta)));
}
elements["aa-zoom-reset"].addEventListener("click", () => setAaZoom(1));
elements["aa-fit"].addEventListener("click", fitAaZoom);
// The AA tool row's 색 and the settings sheet's 원본색/단색 are one switch.
for (const id of ["aa-source-styles", "aa-color"]) {
  elements[id].addEventListener("click", () => {
    settings.aaPreserveStyles = !settings.aaPreserveStyles;
    saveSettings();
  });
}
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
// Two fingers: AA zooms the picture; prose changes the font size (whole steps, same sentence kept
// on screen), like an e-reader. Prose bodies opt out of browser pinch zoom in CSS for this.
let pinchFont = null;
elements["archive-body"].addEventListener("touchstart", (event) => {
  if (event.touches.length !== 2) return;
  if (currentMode !== "aa" && readerSource) pinchFont = { distance: touchDistance(event), size: settings.proseSize };
}, { passive: true });
elements["archive-body"].addEventListener("touchmove", (event) => {
  if (event.touches.length !== 2) return;
  if (pinchFont) {
    const min = Number(elements["prose-size"].min);
    const max = Number(elements["prose-size"].max);
    const size = Math.max(min, Math.min(max, Math.round(pinchFont.size * touchDistance(event) / pinchFont.distance)));
    if (size === settings.proseSize) return;
    changeTypography(() => { settings.proseSize = size; });
    showReaderFeedback(`글자 ${size}px`);
  }
}, { passive: true });
elements["archive-body"].addEventListener("touchend", () => {
  pinchFont = null;
}, { passive: true });

// AA pinch (docs/24 §8.16): during the gesture only the canvas is scaled (no relayout); on release
// the zoom becomes start × scale through setAaZoom (10–300%, three decimals, no 25% steps) and the
// scroll moves so the point between the fingers stays where it was.
let aaPinch = null;
new PinchGesture(elements["archive-body"], ({ first, last, movement: [scale], origin: [x, y] }) => {
  const body = elements["archive-body"];
  const canvas = body.querySelector(".aa-canvas");
  if (first) {
    aaPinch = null;
    if (currentMode !== "aa" || !canvas) return;
    const box = canvas.getBoundingClientRect();
    aaPinch = { zoom: effectiveAaZoom(), x, y };
    canvas.style.transformOrigin = `${x - box.left}px ${y - box.top}px`;
  }
  if (!aaPinch || !canvas) return;
  const zoom = pinchAaZoom(aaPinch.zoom, scale);
  if (!last) {
    canvas.style.transform = `scale(${zoom / aaPinch.zoom})`;
    return;
  }
  const { zoom: from, x: pointX, y: pointY } = aaPinch;
  aaPinch = null;
  canvas.style.removeProperty("transform");
  canvas.style.removeProperty("transform-origin");
  const before = body.getBoundingClientRect();
  const scroller = aaScroller();
  // The point's place across the visible stage (the scroller's box), where the scroll is counted from.
  const stageLeft = scroller === body ? before.left : scroller.getBoundingClientRect().left;
  const offsetY = pointY - before.top;
  setAaZoom(zoom);
  scroller.scrollLeft = scrollKeepingPoint({ scrollLeft: scroller.scrollLeft, scrollTop: 0, x: pointX - stageLeft, y: 0, from, to: zoom }).left;
  const pane = elements["reader-pane"];
  pane.scrollTop += body.getBoundingClientRect().top + offsetY * (zoom / from) - pointY;
}, { pointer: { touch: true }, pinchOnWheel: false, eventOptions: { passive: true } });

// One tap shows or hides the tools at once; a second tap within 300ms undoes that and switches
// between 맞춤 and 100% (T31).
const aaTap = createTapJudge({
  onTap: () => setReaderChromeHidden(!document.body.classList.contains("reader-controls-hidden")),
  onDoubleTap: () => {
    const key = currentAaKey();
    if (key && aaViews[key]?.fit) setAaZoom(1);
    else fitAaZoom();
  },
});

// Minimap: drag or tap a point to bring that part of the picture to the middle; arrows step.
new DragGesture(elements["aa-minimap"], ({ xy: [x] }) => {
  const box = elements["aa-minimap"].getBoundingClientRect();
  aaScroller().scrollLeft = minimapScroll((x - box.left) / box.width, aaScroller());
}, { pointer: { capture: true } });
elements["aa-minimap"].addEventListener("keydown", (event) => {
  const body = aaScroller();
  const step = { ArrowLeft: -0.25, ArrowRight: 0.25 }[event.key];
  if (step) body.scrollLeft += step * body.clientWidth;
  else if (event.key === "Home") body.scrollLeft = 0;
  else if (event.key === "End") body.scrollLeft = body.scrollWidth;
  else return;
  event.preventDefault();
  event.stopPropagation();
});
new ResizeObserver(() => updateAaOverflowCue()).observe(elements["archive-body"]);

// 가로 전체화면 (docs/24 §8.17): the AA host goes full screen and asks for landscape (a refused
// lock keeps the full screen). Its state follows fullscreenchange alone, so Back, Esc and the
// button agree; leaving restores the zoom and sideways place the picture had before.
let aaFullscreenReturn = null;
elements["aa-fullscreen"].hidden = !document.fullscreenEnabled;
elements["aa-scene-previous"].addEventListener("click", () => moveAaScene(-1));
elements["aa-scene-next"].addEventListener("click", () => moveAaScene(1));
elements["aa-host"].addEventListener("scroll", scheduleAaScene, { passive: true });
elements["aa-fullscreen"].addEventListener("click", async () => {
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  const key = currentAaKey();
  aaFullscreenReturn = {
    key, view: key && aaViews[key] ? { ...aaViews[key] } : null, auto: aaAutoZoom, zoom: settings.aaZoom,
    left: aaScroller().scrollLeft,
  };
  try {
    await elements["aa-host"].requestFullscreen({ navigationUI: "hide" });
  } catch {
    aaFullscreenReturn = null;
    showReaderFeedback("전체화면을 열 수 없습니다", 2200);
    return;
  }
  try {
    await screen.orientation?.lock?.("landscape");
  } catch { /* the full screen stays without turning */ }
});
document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === elements["aa-host"];
  elements["aa-fullscreen"].setAttribute("aria-pressed", String(active));
  // A phone shows only the ⟲ icon (aa.css hides the word); the name stays for screen readers.
  const label = Object.assign(document.createElement("span"), { className: "aa-long-label", textContent: active ? " 나가기" : " 가로 전체화면" });
  elements["aa-fullscreen"].replaceChildren("⟲", label);
  elements["aa-fullscreen"].setAttribute("aria-label", active ? "가로 전체화면 나가기" : "가로 전체화면");
  if (active) return;
  const back = aaFullscreenReturn;
  aaFullscreenReturn = null;
  try {
    screen.orientation?.unlock?.();
  } catch { /* nothing was locked */ }
  if (!back || back.key !== currentAaKey()) return;
  if (back.key && back.view) aaViews[back.key] = back.view;
  else if (back.key) delete aaViews[back.key];
  aaAutoZoom = back.auto;
  settings.aaZoom = back.zoom;
  applySettings();
  persistUserState();
  requestAnimationFrame(() => {
    aaScroller().scrollLeft = back.left;
    updateAaOverflowCue();
  });
});

// ---- Marks and notes (docs/24 §8.13, §12.4) ---------------------------------------------------
// Records live in the owner's IndexedDB namespace (redstm:<ownerHash>, from /api/v1/me). Without a
// verified owner there is no store, and marking says so instead of writing somewhere shared.
let ownerDb = null;
let annotationRecords = [];
let annotationModel = null;
let placedAnnotations = [];

// The verified owner (Access email hash from /api/v1/me), or null when there is none (Basic auth).
// Offline (no answer at all) the last verified owner on this device is used, so its saved works
// open; online, a different owner than last time leaves the old namespace closed (§12.6.3).
const OWNER_KEY = "redstm.owner.v1";
const OTHER_OWNERS_KEY = "redstm.otherOwners.v1";
let ownerRequest = null;
// Owners seen before on this device whose records are still here, until they are deleted.
function otherOwners() {
  try {
    const list = JSON.parse(localStorage.getItem(OTHER_OWNERS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((value) => /^[a-f0-9]{16}$/.test(value)) : [];
  } catch {
    return [];
  }
}
function setOtherOwners(list) {
  try {
    localStorage.setItem(OTHER_OWNERS_KEY, JSON.stringify([...new Set(list)]));
  } catch { /* shown again on the next mismatch */ }
}
function rememberedOwner() {
  try {
    const value = localStorage.getItem(OWNER_KEY);
    return /^[a-f0-9]{16}$/.test(value ?? "") ? value : null;
  } catch {
    return null;
  }
}
function ownerIdentity() {
  ownerRequest ??= fetch("/api/v1/me", { headers: { Accept: "application/json" } })
    .then(async (response) => {
      const me = response.ok ? await response.json().catch(() => null) : null;
      const hash = /^[a-f0-9]{16}$/.test(me?.ownerHash ?? "") ? me.ownerHash : null;
      const previous = rememberedOwner();
      if (!hash && (response.redirected || [401, 403].includes(response.status) ||
          (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html"))) return previous;
      if (hash && previous && previous !== hash) setOtherOwners([...otherOwners(), previous]);
      if (hash) setOtherOwners(otherOwners().filter((value) => value !== hash));
      if (hash) {
        try {
          localStorage.setItem(OWNER_KEY, hash);
        } catch { /* offline starts will not find the owner */ }
      }
      return hash;
    }, () => rememberedOwner())
    .catch(() => null);
  return ownerRequest;
}

// P6-6: localStorage stays the original reading state; the owner's idb keeps a copy of every save.
// A copy newer than an untouched original (its save failed, or localStorage was cleared) is
// restored once at start. Only the latest state per key is written, one write at a time.

function localRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function mirrorState(key, raw) {
  const next = { raw, sourceRaw: localRaw(key) ?? raw };
  const writing = mirrorQueue.has(key);
  mirrorQueue.set(key, next);
  if (writing) return;
  void (async () => {
    await null; // a save during module start runs before the owner store is declared
    const store = await restoreMirroredStates().then(ownerStore);
    for (let pending = mirrorQueue.get(key); pending; pending = mirrorQueue.get(key)) {
      mirrorQueue.set(key, null);
      await store?.writeState(key, pending.raw, pending.sourceRaw)
        .catch((error) => console.warn("Reading state copy could not be saved", error));
    }
    mirrorQueue.delete(key);
  })();
}

function restoreMirroredStates() {
  statesRestored ??= ownerStore().then(async (store) => {
    if (!store) return;
    for (const key of [STATE_KEY, TEXT_STATE_KEY]) {
      const copy = await store.get("meta", `legacy:${key}`);
      const local = localRaw(key);
      if (!copy || copy.raw === local || (local !== null && local !== copy.sourceRaw)) continue;
      try {
        localStorage.setItem(key, copy.raw);
      } catch { /* the copy still applies to this page */ }
      if (key === STATE_KEY) adoptStoredState(copy.raw);
      else textLibrary.adoptState(JSON.parse(copy.raw));
    }
    await store.reconcileLegacy([STATE_KEY, TEXT_STATE_KEY]);
  }).catch((error) => console.warn("Reading state copy could not be restored", error));
  return statesRestored;
}

// Why the owner's store is not open, so 기록 can say what to do: "identity" (the account was not
// confirmed — sign in again) or "storage" (this browser refused IndexedDB).
let ownerStoreProblem = null;
function recordsUnavailableText() {
  return ownerStoreProblem === "identity"
    ? "로그인을 확인하지 못해 기록을 열 수 없습니다. 새로 고침하거나 다시 로그인해 주세요."
    : "이 브라우저가 기록 저장소를 막았습니다. 비공개 창이나 사이트 데이터 차단을 확인해 주세요.";
}

function ownerStore() {
  ownerDb ??= ownerIdentity()
    .then((hash) => {
      if (!hash) ownerStoreProblem = "identity";
      // A newer tab upgraded the schema and closed this connection: the next use opens again.
      return hash ? openStore(hash, { onClosed: () => { ownerDb = null; } }) : null;
    })
    .then(async (store) => {
      if (!store) return null;
      annotationRecords = await store.getAll("annotations");
      // Another tab's change arrives here too.
      store.subscribe(async ({ keys } = {}) => {
        // Mirrored reading states (P6-6) are not records.
        if (keys?.every((key) => key.startsWith("redstm."))) return;
        annotationRecords = await store.getAll("annotations");
        paintAnnotations();
      });
      return store;
    })
    .catch(() => {
      ownerStoreProblem = "storage";
      return null;
    });
  return ownerDb;
}

// Marks are Custom Highlights over ranges resolved from their locators; the body DOM never changes.
function paintAnnotations() {
  const highlights = globalThis.CSS?.highlights;
  highlights?.delete("redstm-mark");
  highlights?.delete("redstm-note");
  annotationModel = null;
  placedAnnotations = [];
  if (!readerSource || currentMode === "aa" || !readerSession.documentKey) return;
  const records = documentAnnotations(annotationRecords, readerSession.documentKey);
  if (!records.length) return;
  annotationModel = createTextModel(elements["archive-body"]);
  placedAnnotations = placeAnnotations(annotationModel, records, readerSession.rev);
  if (!highlights || !globalThis.Highlight) return;
  for (const kind of ["mark", "note"]) {
    const ranges = placedAnnotations.filter((item) => item.range && item.record.kind === kind).map((item) => item.range);
    if (!ranges.length) continue;
    const highlight = new Highlight(...ranges);
    highlight.priority = MARK_PRIORITY;
    highlights.set(`redstm-${kind}`, highlight);
  }
}

function annotationAtPoint(x, y) {
  if (!annotationModel || !placedAnnotations.length) return null;
  const caret = document.caretPositionFromPoint?.(x, y);
  const range = caret ? null : document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? range?.startContainer;
  const at = node ? modelOffset(annotationModel, node, caret?.offset ?? range.startOffset) : null;
  return at === null ? null : annotationAt(placedAnnotations, at);
}

async function saveAnnotation(record, message) {
  const store = await ownerStore();
  if (!store) return void showReaderFeedback("이 기기에 기록을 저장할 수 없어요", 2400);
  try {
    await store.commit([{ store: "annotations", value: record }]);
  } catch {
    return void showReaderFeedback("저장하지 못했어요. 다시 시도해 주세요", 2400);
  }
  annotationRecords = [...annotationRecords.filter((item) => item.id !== record.id), record];
  paintAnnotations();
  if (message) showReaderFeedback(message);
}

function readerSelection({ aa = false } = {}) {
  const selection = getSelection();
  if (!readerSource || (currentMode === "aa" && !aa) || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return elements["archive-body"].contains(range.commonAncestorContainer) ? range : null;
}

// Selection menu: under the selection with Floating UI (kept in place only while open); on a
// touch screen the same four actions take the dock's place (T26).
let selectionStop = null;
let selectionTimer = 0;
function hideSelectionMenu() {
  selectionStop?.();
  selectionStop = null;
  if (elements["selection-menu"].matches(":popover-open")) elements["selection-menu"].hidePopover();
}

function updateSelectionMenu() {
  const range = readerSelection({ aa: true });
  if (!range) return hideSelectionMenu();
  const menu = elements["selection-menu"];
  const aa = currentMode === "aa";
  for (const button of menu.querySelectorAll("button")) button.hidden = (button.id === "sel-image") !== aa;
  const fixed = matchMedia("(pointer: coarse)").matches;
  menu.classList.toggle("fixed", fixed);
  if (!menu.matches(":popover-open")) menu.showPopover();
  selectionStop?.();
  selectionStop = null;
  if (fixed) {
    Object.assign(menu.style, { left: "", top: "", visibility: "" });
    return;
  }
  const reference = { getBoundingClientRect: () => range.getBoundingClientRect(), getClientRects: () => range.getClientRects() };
  selectionStop = autoUpdate(reference, menu, () => {
    void computePosition(reference, menu, {
      placement: "bottom", strategy: "fixed", middleware: [inline(), offset(8), flip(), shift({ padding: 8 }), hide()],
    }).then(({ x, y, middlewareData }) => {
      Object.assign(menu.style, { left: `${x}px`, top: `${y}px`, visibility: middlewareData.hide?.referenceHidden ? "hidden" : "visible" });
    });
  });
}
document.addEventListener("selectionchange", () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionMenu, 300);
});
elements["reader-pane"].addEventListener("pointerup", () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionMenu, 0);
});
// Pressing an action must not take the selection away first.
elements["selection-menu"].addEventListener("pointerdown", (event) => event.preventDefault());

// The selection as a new record, or null (and why) when it cannot become one.
function selectionRecord() {
  const range = readerSelection();
  if (!range) return null;
  const model = createTextModel(elements["archive-body"]);
  const offsets = selectionOffsets(model, range);
  if (!offsets) return null;
  try {
    return annotationRecord({
      model, ...offsets, rev: readerSession.rev, documentId: readerSession.documentKey, workId: readerSession.workId,
      context: {
        title: elements["reader-title"].textContent, work: currentCollection?.collection?.title || elements["reader-kicker"].textContent,
        route: `${location.pathname}${location.search}`,
      },
    });
  } catch {
    showReaderFeedback("선택이 너무 길어요", 2200);
    return null;
  }
}

function clearSelection() {
  getSelection()?.removeAllRanges();
  hideSelectionMenu();
}

let noteRecord = null;
function openNoteEditor(record) {
  noteRecord = record;
  elements["note-quote"].textContent = record.quote;
  elements["note-text"].value = record.note;
  elements["note-dialog"].showModal();
}

document.querySelector("#sel-mark").addEventListener("click", () => {
  const record = selectionRecord();
  clearSelection();
  if (record) void saveAnnotation(record, "표시했어요");
});
document.querySelector("#sel-note").addEventListener("click", () => {
  const record = selectionRecord();
  clearSelection();
  if (record) openNoteEditor(record);
});
document.querySelector("#sel-copy").addEventListener("click", () => {
  const text = readerSelection()?.toString().trim();
  clearSelection();
  if (text) void navigator.clipboard?.writeText(text).then(() => showReaderFeedback("복사했어요"), () => showReaderFeedback("복사하지 못했어요", 2200));
});
let moreQuote = "";
document.querySelector("#sel-more").addEventListener("click", () => {
  const text = readerSelection()?.toString().trim() ?? "";
  hideSelectionMenu();
  if (!text) return;
  moreQuote = text;
  elements["selection-more-quote"].textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  elements["selection-namu"].href = `https://namu.wiki/Search?q=${encodeURIComponent(text.slice(0, 100))}`;
  elements["selection-more"].showModal();
});
elements["note-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const record = noteRecord;
  noteRecord = null;
  elements["note-dialog"].close();
  if (record) void saveAnnotation(withNote(record, elements["note-text"].value), "저장했어요");
});
for (const button of document.querySelectorAll("[data-note-close]")) button.addEventListener("click", () => elements["note-dialog"].close());
elements["note-dialog"].addEventListener("close", () => { noteRecord = null; });

// A marked sentence: its note, 메모, 표시 지우기 (hit-tested against the resolved ranges).
let markMenuRecord = null;
elements["archive-body"].addEventListener("click", (event) => {
  if (String(getSelection() ?? "")) return;
  const item = annotationAtPoint(event.clientX, event.clientY);
  if (!item) return;
  markMenuRecord = item.record;
  const menu = elements["mark-menu"];
  elements["mark-menu-note"].textContent = item.record.note;
  elements["mark-menu-note"].hidden = !item.record.note;
  elements["mark-note"].textContent = item.record.note ? "메모 고치기" : "메모 쓰기";
  menu.showPopover();
  const point = { getBoundingClientRect: () => new DOMRect(event.clientX, event.clientY, 0, 0) };
  void computePosition(point, menu, { placement: "bottom", strategy: "fixed", middleware: [offset(10), flip(), shift({ padding: 8 })] })
    .then(({ x, y }) => Object.assign(menu.style, { left: `${x}px`, top: `${y}px` }));
});
elements["mark-note"].addEventListener("click", () => {
  elements["mark-menu"].hidePopover();
  if (markMenuRecord) openNoteEditor(markMenuRecord);
});
document.querySelector("#mark-delete").addEventListener("click", () => {
  elements["mark-menu"].hidePopover();
  if (markMenuRecord) void saveAnnotation(tombstone(markMenuRecord), "표시를 지웠어요");
  markMenuRecord = null;
});
overlays.watch(elements["mark-menu"], "popover");

// ---- Share images (docs/24 §8.14, T13, T33) ----------------------------------------------------
// Opening the sheet draws the image and makes its PNG at once; 공유 then only hands the ready file
// to navigator.share, so the tap's user activation is still there however long the sheet stayed.
let shareJob = null;
let shareTone = "work";
let shareUrl = "";

function documentHue(key) {
  return workHue(key || readerSession.workId || readerSession.documentKey || "redstm");
}

async function openShare(job) {
  shareJob = { ...job, file: null };
  elements["share-tones"].hidden = job.kind !== "excerpt";
  elements["share-send"].disabled = true;
  elements["share-status"].textContent = "이미지를 만드는 중…";
  if (!elements["share-dialog"].open) elements["share-dialog"].showModal();
  await renderShare();
}

async function renderShare() {
  const job = shareJob;
  if (!job) return;
  const context = elements["share-preview"].getContext("2d");
  try {
    if (job.kind === "excerpt") {
      await Promise.all([
        document.fonts.load("44px MaruBuri", job.quote),
        document.fonts.load('600 32px "Pretendard Variable"', `${job.work}${job.title}ReDSTM이어짐`),
      ]);
      drawExcerptCard(context, { ...job, tone: shareTone });
    } else if (job.kind === "stats") {
      await Promise.all([document.fonts.load("96px MaruBuri", job.totalLabel), document.fonts.load('600 32px "Pretendard Variable"', "이번 주 기록 연속 일 월화수목금토일")]);
      drawStatsCard(context, { days: job.days, total: job.totalLabel, streak: job.streak, finished: job.finished });
    } else {
      await document.fonts.load(`${job.fontSize}px Saitamaar`, job.lines.flat().map((run) => run.text).join(""));
      drawAaScene(context, job);
    }
  } catch {
    elements["share-status"].textContent = "이미지를 만들지 못했어요. 텍스트 복사를 써 주세요";
    return;
  }
  const blob = await canvasBlob(elements["share-preview"]);
  if (shareJob !== job || !blob) return;
  job.file = new File([blob], `redstm-${job.kind}.png`, { type: "image/png" });
  if (shareUrl) URL.revokeObjectURL(shareUrl);
  shareUrl = URL.createObjectURL(blob);
  elements["share-download"].href = shareUrl;
  elements["share-download"].download = job.file.name;
  elements["share-send"].disabled = false;
  elements["share-status"].textContent = "";
}

function shareText() {
  const job = shareJob;
  const where = [job.work, job.title].filter(Boolean).join(" › ");
  const credit = elements["share-credit"].checked ? `\n\n${CREDIT}` : "";
  if (job.kind === "stats") return `이번 주 ${job.totalLabel} 읽음 · 연속 ${job.streak}일 — ReDSTM`;
  return job.kind === "excerpt" ? `“${job.quote}”\n— ${where}${credit}` : `${where}${credit}`.trim();
}

function excerptShare(quote, record = null) {
  void openShare({
    kind: "excerpt", quote,
    work: record?.context?.work ?? (currentCollection?.collection?.title || elements["reader-kicker"].textContent),
    title: record?.context?.title ?? elements["reader-title"].textContent,
    hue: documentHue(record?.workId || record?.documentId),
  });
}

// Whole lines of the selected AA, as runs of text in the colour each one is drawn in on screen.
function aaSceneLines(range) {
  const model = createTextModel(elements["archive-body"]);
  const start = modelOffset(model, range.startContainer, range.startOffset);
  const end = modelOffset(model, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const text = model.text;
  const from = text.lastIndexOf("\n", start - 1) + 1;
  let to = text.indexOf("\n", Math.max(start, end - 1));
  if (to < 0) to = text.length;
  const lines = [[]];
  let cursor = from;
  for (const segment of model.segments) {
    if (segment.end <= from || segment.start >= to) continue;
    for (const character of text.slice(cursor, Math.max(cursor, segment.start))) if (character === "\n") lines.push([]);
    const first = Math.max(from, segment.start);
    const last = Math.min(to, segment.end);
    const color = getComputedStyle(segment.node.parentElement).color;
    text.slice(first, last).split("\n").forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines.at(-1).push({ text: part, color });
    });
    cursor = last;
  }
  return lines.length && lines.length <= 400 ? lines : null;
}

document.querySelector("#sel-image").addEventListener("click", () => {
  const range = readerSelection({ aa: true });
  const lines = range && aaSceneLines(range);
  clearSelection();
  if (!lines) return void showReaderFeedback("이미지로 만들 줄을 골라 주세요", 2200);
  void openShare({
    kind: "aa", lines, background: settings.aaBackground, fontSize: settings.aaSize,
    work: currentCollection?.collection?.title || elements["reader-kicker"].textContent, title: elements["reader-title"].textContent,
  });
});
document.querySelector("#selection-share").addEventListener("click", () => {
  elements["selection-more"].close();
  if (moreQuote) excerptShare(moreQuote);
});
document.querySelector("#mark-share").addEventListener("click", () => {
  elements["mark-menu"].hidePopover();
  if (markMenuRecord) excerptShare(markMenuRecord.quote, markMenuRecord);
});
for (const button of document.querySelectorAll("[data-share-tone]")) {
  button.addEventListener("click", () => {
    shareTone = button.dataset.shareTone;
    for (const choice of document.querySelectorAll("[data-share-tone]")) choice.setAttribute("aria-checked", String(choice === button));
    elements["share-send"].disabled = true;
    void renderShare();
  });
}
elements["share-send"].addEventListener("click", () => {
  const file = shareJob?.file;
  if (!file) return;
  const data = { files: [file], text: shareText() };
  if (navigator.canShare?.(data)) {
    navigator.share(data).catch((error) => {
      if (error?.name !== "AbortError") elements["share-status"].textContent = "공유하지 못했어요. 이미지 저장이나 텍스트 복사를 써 주세요";
    });
    return;
  }
  elements["share-download"].click();
  elements["share-status"].textContent = "이 브라우저는 이미지 공유를 지원하지 않아 저장했어요";
});
document.querySelector("#share-copy").addEventListener("click", () => {
  if (!shareJob) return;
  void navigator.clipboard?.writeText(shareText()).then(
    () => { elements["share-status"].textContent = "텍스트를 복사했어요"; },
    () => { elements["share-status"].textContent = "복사하지 못했어요"; },
  );
});
elements["share-dialog"].addEventListener("close", () => { shareJob = null; });

// 기록 › 발췌 (docs/24 §8.5): every mark and note of this owner, newest first, searched with the
// list's own field. A card opens its document and moves to the sentence; one that no longer
// resolves opens at the reading place and says so instead of jumping to a first match.
let pendingExcerpt = null;
async function renderExcerptsView() {
  const store = await ownerStore();
  if (currentView !== "excerpts") return;
  const records = excerptList(annotationRecords, elements["search-input"].value);
  renderedResults = [];
  renderedCollections = [];
  resultTotal = records.length;
  elements["search-empty"].hidden = true;
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren(...records.map(excerptElement));
  elements["excerpts-export"].disabled = !records.length;
  elements["result-status"].textContent = !store ? recordsUnavailableText()
    : records.length ? `발췌 ${records.length}건 · 이 기기` : elements["search-input"].value ? "찾는 발췌가 없습니다" : "표시하거나 메모한 문장이 여기에 모입니다";
  updateLoadMore();
}

function excerptElement(record) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item excerpt-card";
  button.dataset.excerptId = record.id;
  button.dataset.key = `excerpt:${record.id}`;
  const quote = document.createElement("span");
  quote.className = "excerpt-quote";
  quote.textContent = record.quote;
  button.append(quote);
  if (record.note) {
    const note = document.createElement("span");
    note.className = "excerpt-note";
    note.textContent = record.note;
    button.append(note);
  }
  const meta = document.createElement("span");
  meta.className = "result-meta";
  const where = [record.context?.work, record.context?.title].filter(Boolean).join(" › ");
  meta.textContent = [where || "제목 없음", formatSourceDate(record.createdAt) || record.createdAt.slice(0, 10), record.kind === "note" ? "메모" : "표시",
    record.conflictOf ? "충돌 사본 · 다른 기기에서 고친 내용" : ""].filter(Boolean).join(" · ");
  button.append(meta);
  item.append(button);
  return item;
}

function openExcerpt(id) {
  const record = annotationRecords.find((item) => item.id === id);
  if (!record?.context?.route) return void showReaderFeedback("이 발췌의 원문 위치를 알 수 없어요", 2200);
  pendingExcerpt = { id: record.id, documentId: record.documentId };
  if (record.documentId === readerSession.documentKey && readerSource) return void jumpToPendingExcerpt();
  persistCatalogState();
  history.pushState({ redstmReader: true, redstmParent: currentRoute() }, "", record.context.route);
  void handleRoute();
}

// After the document's own reading place has been restored (two frames on), move to the sentence.
function jumpToPendingExcerpt() {
  const pending = pendingExcerpt;
  if (!pending || pending.documentId !== readerSession.documentKey) return;
  pendingExcerpt = null;
  const item = placedAnnotations.find((placed) => placed.record.id === pending.id);
  readerSession.frame(() => readerSession.frame(() => {
    if (!item?.range) return void showReaderFeedback("원문에서 이 문장을 찾지 못했어요", 2400);
    if (readerSession.restore({ loc: item.record.locator, viewportOffset: Math.round(elements["reader-pane"].clientHeight / 3) })) syncScrollBaseline();
  }));
}

elements["excerpts-export"].addEventListener("click", () => {
  const records = excerptList(annotationRecords, elements["search-input"].value);
  if (!records.length) return;
  const url = URL.createObjectURL(new Blob([excerptsMarkdown(records, location.origin)], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `redstm-excerpts-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// ---- Reading sessions and statistics (DESIGN §9) -----------------------------------------------
// A session is one document on screen: spans of activity (an input keeps it active for a minute,
// leaving the screen stops it), the characters moved through and whether the last preserved
// chapter of a work was reached. It is written to the owner's store when it pauses or ends.
let readingSession = null;
let sessionTimer = 0;

// The work a document belongs to: a TypeMoon post's collection arrives a moment after the post
// (updateCollection sets readerSession.workId), a text chapter knows it from the start.
function sessionWorkKey() {
  return readerSession.workId || readerSession.documentKey;
}

function startReadingSession() {
  if (!readerSource || !readerSession.documentKey) return;
  const progress = bodyProgress();
  readingSession = {
    id: crypto.randomUUID(), workKey: sessionWorkKey(), documentId: readerSession.documentKey, day: localDay(Date.now()),
    start: Date.now(), spans: [], length: elements["archive-body"].textContent.length, from: progress, furthest: progress, endOfWork: false,
  };
}

function noteReadingActivity() {
  const session = readingSession;
  if (!session || document.visibilityState !== "visible" || session.documentId !== readerSession.documentKey) return;
  extendSpans(session.spans, Date.now());
  session.furthest = Math.max(session.furthest, bodyProgress());
  const nav = readerNavigation;
  if (session.furthest >= 0.98 && nav && !nav.pending && !nav.next && (nav.run || nav.hasToc)) session.endOfWork = true;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => void saveReadingSession(session), 30_000);
}

function sessionRecord(session, deviceId, now = Date.now()) {
  const spans = session.spans.map(([start, end]) => [start, Math.min(end, now)]).filter(([start, end]) => end > start);
  return {
    id: session.id, deviceId, workKey: session.workKey, documentId: session.documentId, day: session.day,
    start: session.start, end: spans.at(-1)?.[1] ?? session.start, spans, activeMs: unionLength(spans),
    chars: Math.round(Math.max(0, session.furthest - session.from) * session.length), endOfWork: session.endOfWork,
  };
}

async function saveReadingSession(session) {
  if (!session?.spans.length) return;
  const store = await ownerStore();
  if (!store) return;
  try {
    await store.commit([{ store: "sessions", value: sessionRecord(session, store.deviceId) }]);
  } catch { /* the next pause tries again */ }
}

function finishReadingSession() {
  const session = readingSession;
  readingSession = null;
  clearTimeout(sessionTimer);
  if (!session) return;
  closeSpans(session.spans, Date.now());
  void saveReadingSession(session);
}

for (const type of ["scroll", "pointerdown", "wheel"]) elements["reader-pane"].addEventListener(type, noteReadingActivity, { passive: true });
document.addEventListener("keydown", () => { if (document.body.classList.contains("reader-open")) noteReadingActivity(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" || !readingSession) return;
  closeSpans(readingSession.spans, Date.now());
  void saveReadingSession(readingSession);
});
addEventListener("pagehide", () => {
  if (!readingSession) return;
  closeSpans(readingSession.spans, Date.now());
  void saveReadingSession(readingSession);
});

// Every stored session plus the one being read now.
async function allSessions() {
  const store = await ownerStore();
  if (!store) return null;
  const sessions = await store.getAll("sessions");
  if (readingSession) sessions.push(sessionRecord(readingSession, store.deviceId));
  return sessions;
}

let statsSummary = null;
async function renderStatsView() {
  const sessions = await allSessions();
  if (currentView !== "stats") return;
  renderedResults = [];
  resultTotal = 0;
  elements["search-empty"].hidden = true;
  updateLoadMore();
  if (!sessions) {
    elements["result-status"].textContent = recordsUnavailableText();
    elements["stats-panel"].hidden = true;
    return;
  }
  const now = Date.now();
  const daily = dailyReading(sessions, now);
  const today = localDay(now);
  const date = new Date(now);
  const cells = monthCells(daily, date.getFullYear(), date.getMonth() + 1);
  const best = Math.max(30 * 60_000, ...cells.filter(Boolean).map((cell) => cell.milliseconds));
  const todayMs = daily.get(today) ?? 0;
  elements["stats-today"].textContent = minutesLabel(todayMs);
  requestAnimationFrame(() => elements["stats-ring"].style.setProperty("--ring", String(Math.min(1, todayMs / best))));
  const streak = readingStreak(daily, today);
  const finished = finishedWorks(sessions);
  elements["stats-streak"].textContent = `${streak}일`;
  elements["stats-finished"].textContent = finished.toLocaleString("ko-KR");
  elements["stats-chars"].textContent = `${charactersRead(sessions).toLocaleString("ko-KR")}자`;
  elements["stats-month-title"].textContent = `${date.getMonth() + 1}월`;
  elements["stats-heat"].replaceChildren(...cells.map((cell) => {
    const item = document.createElement("li");
    if (!cell) {
      item.className = "empty";
      item.ariaHidden = "true";
      return item;
    }
    item.className = `level-${cell.level}${cell.day === today ? " today" : ""}`;
    item.ariaLabel = `${date.getMonth() + 1}월 ${cell.date}일 ${minutesLabel(cell.milliseconds)}`;
    return item;
  }));
  statsSummary = { ...weekSummary(daily, today), streak, finished };
  elements["stats-share"].disabled = !statsSummary.total;
  elements["result-status"].textContent = "통계 · 이 기기와 같은 계정 기록";
}

elements["stats-share"].addEventListener("click", () => {
  if (!statsSummary?.total) return;
  void openShare({ kind: "stats", ...statsSummary, totalLabel: minutesLabel(statsSummary.total), work: "", title: "" });
});

// Home: 오늘의 발췌 and 이번 주 기록, each hidden while it has nothing to show.
let homeExcerptOffset = 0;
async function renderHomeRecords() {
  const sessions = await allSessions();
  if (currentDestination !== "library") return;
  const records = excerptList(annotationRecords);
  const today = localDay(Date.now());
  const record = excerptOfTheDay(records, today, homeExcerptOffset);
  elements["home-excerpt"].hidden = !record;
  elements["home-excerpt-list"].replaceChildren(...(record ? [excerptElement(record)] : []));
  document.querySelector("#home-excerpt-next").hidden = records.length < 2;
  const week = sessions ? weekSummary(dailyReading(sessions), today) : null;
  elements["home-week"].hidden = !week || week.total < 60_000;
  if (!week) return;
  elements["home-week-total"].textContent = `${minutesLabel(week.total)} · ${week.activeDays}일 읽음`;
  fillWeekBars(elements["home-week-bars"], week.days);
}
document.querySelector("#home-excerpt-next").addEventListener("click", () => {
  homeExcerptOffset += 1;
  void renderHomeRecords();
});
elements["home-excerpt-list"].addEventListener("click", (event) => {
  const card = event.target.closest("[data-excerpt-id]");
  if (card) openExcerpt(card.dataset.excerptId);
});
document.querySelector("#home-week-all").addEventListener("click", () => {
  history.pushState({ redstmSaved: { view: "stats" } }, "", "/saved?view=stats");
  void handleRoute();
});

// The time spent in a work, added to its header line once the sessions are read.
async function showWorkReadingTime(key, element) {
  const sessions = await allSessions();
  const spent = sessions ? workReading(sessions, key) : 0;
  if (spent < 60_000 || element.dataset.readingTime === key) return;
  element.dataset.readingTime = key;
  element.textContent += ` · 읽은 시간(추정) ${minutesLabel(spent)}`;
}

// ---- 기기에 내려받기 (docs/24 §12.6.2, T08) --------------------------------------------------------
// A saved work is a snapshot in the owner's store (what to draw offline) plus its files in the
// owner's offline cache (the worker downloads them). It needs both a verified owner and a worker.
const OFFLINE_REQUIRES = [
  "/fonts/maruburi@1.000/400.core.woff2", "/fonts/saitamaar@1.0/Saitamaar-Regular.woff2",
  "/vendor/leeoniya-ufuzzy@1.0.19/ufuzzy.js", "/vendor/es-hangul@2.4.0/es-hangul.js", "/vendor/use-gesture-vanilla@10.3.1/use-gesture.js",
  "/vendor/floating-ui-dom@1.8.0/floating-ui.js", "/vendor/idb@8.0.3/idb.js",
];
let offlineWork = null; // the snapshot shown in the open work header
const offlineRuns = new Map(); // workKey → live progress while saving

function collectionSnapshot(collection, owner) {
  const entries = collection.entries.filter((entry) => entry.object_key).map((entry) => ({
    documentId: `typemoon:${entry.board_id}:${entry.external_post_id}`, order: entry.position, title: entry.title,
    url: `/archive/${entry.object_key}`,
  }));
  return {
    workKey: workKey({ source: "typemoon", id: collection.id }), owner, source: "typemoon", textModelVersion: 1,
    title: collection.title, entries,
    descriptor: {
      id: collection.id, board_id: collection.board_id, title: collection.title, kind: collection.kind,
      entries: collection.entries.map(({ position, board_id, external_post_id, title, object_key }) => ({ position, board_id, external_post_id, title, object_key })),
    },
    requires: OFFLINE_REQUIRES, media: "text-only", state: "interrupted", savedAt: new Date().toISOString(), bytes: 0, done: 0, failed: 0,
  };
}

function sizeLabel(bytes) {
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

function renderOfflineControl() {
  const snapshot = offlineWork;
  const run = snapshot && offlineRuns.get(snapshot.workKey);
  const save = elements["offline-save"];
  const remove = elements["offline-delete"];
  const state = elements["offline-state"];
  if (run) {
    save.textContent = "멈추기";
    save.dataset.action = "cancel";
    remove.hidden = true;
    state.textContent = `내려받는 중 ${run.done + run.failed}/${run.total}`;
    return;
  }
  const stored = snapshot?.stored;
  save.dataset.action = "save";
  remove.hidden = !stored;
  if (!stored) {
    save.textContent = "기기에 내려받기";
    state.textContent = "글만 내려받음 · 이미지는 온라인에서";
  } else if (stored.state === "complete") {
    save.hidden = true;
    state.textContent = `이 기기에 내려받음 · ${sizeLabel(stored.bytes)}`;
  } else {
    save.hidden = false;
    save.textContent = "이어서 내려받기";
    state.textContent = stored.failed
      ? `일부만 내려받음 · ${stored.done}/${stored.entries.length}편 (${stored.failed}편 실패)`
      : `내려받기 중단됨 · ${stored.done}/${stored.entries.length}편`;
  }
  if (stored?.state !== "complete") save.hidden = false;
}

async function showOfflineControl(collection) {
  const control = elements["collection-offline"];
  const [store, owner] = await Promise.all([ownerStore(), ownerIdentity()]);
  const usable = store && owner && offline.canSave && featureEnabled("offline", true);
  const stored = store ? await store.get("offline", workKey({ source: "typemoon", id: collection.id })) : null;
  if (activeCollectionId !== collection.id) return;
  // With the offline flag off, a saved work can still be removed; nothing new is saved.
  control.hidden = !usable && !stored;
  if (control.hidden) return;
  offlineWork = { ...collectionSnapshot(collection, owner), stored };
  renderOfflineControl();
  elements["offline-save"].disabled = !usable;
}

async function writeSnapshot(snapshot) {
  const store = await ownerStore();
  if (!store) return false;
  const { stored: _stored, ...value } = snapshot;
  try {
    await store.commit([{ store: "offline", value }]);
    return true;
  } catch {
    showReaderFeedback("내려받기 상태를 기록하지 못했어요", 2400);
    return false;
  }
}

elements["offline-save"].addEventListener("click", async () => {
  const snapshot = offlineWork;
  if (!snapshot) return;
  if (elements["offline-save"].dataset.action === "cancel") return void offline.cancel(snapshot.workKey);
  // Ask once to keep saved works through storage pressure (granted silently or not at all).
  void navigator.storage?.persist?.().catch(() => {});
  const value = { ...snapshot, state: "interrupted", savedAt: new Date().toISOString() };
  elements["offline-save"].disabled = true;
  const recorded = await writeSnapshot(value);
  elements["offline-save"].disabled = false;
  if (!recorded) return;
  offlineRuns.set(snapshot.workKey, { done: 0, failed: 0, total: snapshot.entries.length });
  renderOfflineControl();
  offline.save(snapshot.workKey, snapshot.entries.map((entry) => entry.url), snapshot.requires);
});

elements["offline-delete"].addEventListener("click", async () => {
  const snapshot = offlineWork;
  if (!snapshot?.stored) return;
  offline.remove(snapshot.workKey, snapshot.stored.entries.map((entry) => entry.url));
  const store = await ownerStore();
  try {
    await store?.commit([{ store: "offline", key: snapshot.workKey, value: null }]);
  } catch { /* the files are gone; the record is retried on the next delete */ }
  offlineWork = { ...snapshot, stored: null };
  renderOfflineControl();
  showReaderFeedback("이 기기에서 지웠어요");
  void renderOfflineStorage();
});

// Worker progress: the header follows it; the end (done, partial or stopped) is recorded.
async function offlineProgress(message) {
  const run = offlineRuns.get(message.id);
  if (message.type === "offline-progress" && run) {
    Object.assign(run, { done: message.done, failed: message.failed, total: message.total });
  } else if ((message.type === "offline-done" || message.type === "offline-cancelled") && run) {
    offlineRuns.delete(message.id);
    const store = await ownerStore();
    const stored = await store?.get("offline", message.id);
    if (stored) {
      const finished = { ...stored, done: message.done, failed: message.failed, bytes: message.bytes,
        state: message.type === "offline-done" && !message.failed && message.done === stored.entries.length ? "complete" : message.failed ? "partial" : "interrupted" };
      if (!(await writeSnapshot(finished))) { renderOfflineControl(); return; }
      if (offlineWork?.workKey === message.id) offlineWork = { ...offlineWork, stored: finished };
    }
    showReaderFeedback(message.failed ? `내려받지 못한 편이 ${message.failed}개 있어요` : message.type === "offline-cancelled" ? "내려받기를 멈췄어요" : "이 기기에 내려받았어요", 2400);
    void renderOfflineStorage();
  }
  if (offlineWork?.workKey === message.id) renderOfflineControl();
}

// Settings: how many works this device keeps and the space the browser reports (T08).
async function renderOfflineStorage() {
  const owner = await ownerIdentity();
  elements["other-account"].hidden = !otherOwners().some((value) => value !== owner);
  const store = await ownerStore();
  const works = store ? await store.getAll("offline") : [];
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const line = elements["offline-storage"];
  line.hidden = !works.length && !estimate;
  if (line.hidden) return;
  const used = estimate?.usage ? ` · 사용 ${sizeLabel(estimate.usage)}${estimate.quota ? ` / 가능 ${sizeLabel(estimate.quota)}` : ""}` : "";
  line.textContent = `내려받은 작품 ${works.length}개${used}. 내려받은 글은 이 기기에 평문으로 남고, 권한이 철회돼도 이미 받은 글은 원격에서 지울 수 없습니다.`;
}

// A new version never replaces the running one by itself (no automatic skipWaiting): it is
// applied at a safe point — going to 서재 or opening another document — after the reading place is
// saved, or at once from the toast; the page then reloads, so old and new modules never mix (T23).
let updateReady = false;
function applyUpdateAtSafePoint() {
  if (!updateReady) return false;
  if (currentSummary) persistReadingPosition();
  persistUserState();
  return offline.applyUpdate();
}
document.querySelector("#update-apply").addEventListener("click", () => {
  overlays.hideToast(document.querySelector("#update-ready"));
  applyUpdateAtSafePoint();
});
document.querySelector("#reset-app-cache").addEventListener("click", async () => {
  if (!confirm("앱 캐시와 내려받은 작품 파일을 지우고 다시 불러옵니다. 표시·메모·읽기 기록은 남습니다.")) return;
  try {
    const store = await ownerStore();
    const cachedOwners = (await caches.keys()).map((name) => name.match(/-([a-f0-9]{16})$/)?.[1]);
    for (const owner of new Set([await ownerIdentity(), ...otherOwners(), ...cachedOwners].filter(Boolean))) {
      const target = store?.name === `redstm:${owner}` ? store : await openStore(owner);
      try {
        const works = await target.getAll("offline");
        await target.commit(works.map((work) => ({ store: "offline", value: { ...work, state: "interrupted", done: 0, failed: 0, bytes: 0 } })));
      } finally {
        if (target !== store) target.close();
      }
    }
    await offline.reset();
    location.reload();
  } catch {
    showReaderFeedback("앱 캐시를 지우지 못했어요 · 다시 시도해 주세요", 2400);
  }
});
let authSheetClosed = false;
elements["auth-dialog"].addEventListener("close", () => { authSheetClosed = true; });
document.querySelector("#auth-login").addEventListener("click", () => location.reload());
document.querySelector("#auth-saved").addEventListener("click", () => {
  elements["auth-dialog"].close();
  showDestination("library");
  void renderOfflineWorks(true);
});
document.querySelector("#other-account-delete").addEventListener("click", async () => {
  const owner = await ownerIdentity();
  for (const other of otherOwners()) if (other !== owner) await deleteNamespace(other);
  setOtherOwners([]);
  elements["other-account"].hidden = true;
  showReaderFeedback("다른 계정 기록을 지웠어요");
});
// 이 기기 기록 지우기: this owner's marks, notes, sessions, saved works and their caches. The reading
// state in localStorage (설정·읽은 위치) stays; 기록 내보내기 first keeps a copy.
document.querySelector("#clear-device").addEventListener("click", async () => {
  if (!confirm("이 기기의 표시·메모·독서 기록·내려받은 작품을 지웁니다. 먼저 기록 내보내기로 백업할 수 있어요. 지울까요?")) return;
  const owner = await ownerIdentity();
  const store = await ownerStore();
  store?.close();
  ownerDb = null;
  annotationRecords = [];
  paintAnnotations();
  if (owner) await deleteNamespace(owner);
  showReaderFeedback("이 기기 기록을 지웠어요");
  void renderOfflineStorage();
});

// ---- 다른 기기에서 (docs/24 P5-1) ---------------------------------------------------------------
// The place travels in the address (?at=<short locator>), shown as a QR code: no server is told.
// The receiving page takes it out of the address before routing and moves to that sentence once
// the document has restored its own place.
let pendingHandoff = null;
{
  const params = new URLSearchParams(location.search);
  const at = params.get("at");
  if (at) {
    pendingHandoff = decodeLocator(at);
    params.delete("at");
    const query = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }
}

function jumpToHandoff() {
  const loc = pendingHandoff;
  if (!loc || !readerSource) return;
  pendingHandoff = null;
  readerSession.frame(() => readerSession.frame(() => {
    if (readerSession.restore({ loc, viewportOffset: Math.round(elements["reader-pane"].clientHeight / 3) })) {
      syncScrollBaseline();
      showReaderFeedback("다른 기기에서 읽던 곳이에요", 2400);
    } else showReaderFeedback("넘겨받은 문장을 이 본문에서 찾지 못했어요", 2400);
  }));
}

document.querySelector("#more-handoff").addEventListener("click", () => {
  closeReaderMore();
  const anchor = readerSession.capture();
  const url = new URL(location.href);
  if (anchor?.loc) url.searchParams.set("at", encodeLocator(anchor.loc));
  document.querySelector("#handoff-code").innerHTML = renderSVG(url.href, { border: 1 });
  document.querySelector("#handoff-quote").textContent = anchor?.loc ? `“${anchor.loc.exact.slice(0, 40)}…”` : "이 글의 처음부터 열립니다";
  document.querySelector("#handoff-url").value = url.href;
  document.querySelector("#handoff-dialog").showModal();
});
document.querySelector("#handoff-copy").addEventListener("click", () => {
  void navigator.clipboard?.writeText(document.querySelector("#handoff-url").value).then(() => showReaderFeedback("링크를 복사했어요"));
});

// ---- 읽기 프로필 · 이 작품만 (DESIGN §10, docs/24 P6-2) ------------------------------------------
// A profile is a named copy of the reading settings. Choosing one applies it to every work; with
// 이 작품만 a work opens with its profile while the base settings stay as they were (and come back
// when another work opens). Changes made inside such a work are for that visit only.
let workProfileBase = null;
const pickProfile = () => Object.fromEntries(PROFILE_KEYS.filter((key) => key in settings).map((key) => [key, settings[key]]));
function activeProfileName() {
  const values = pickProfile();
  return (settings.readingProfiles ?? []).find((profile) => Object.entries(profile.values).every(([key, value]) => values[key] === value))?.name ?? "";
}
function currentWorkKey() {
  return readerSource ? sessionWorkKey() : "";
}

function renderProfiles() {
  const list = document.querySelector("#quick-profile-list");
  const active = activeProfileName();
  list.replaceChildren(...(settings.readingProfiles ?? []).map((profile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = profile.name;
    button.dataset.profile = profile.name;
    button.setAttribute("aria-pressed", String(profile.name === active));
    return button;
  }));
  const key = currentWorkKey();
  const workToggle = document.querySelector("#quick-profile-work");
  workToggle.hidden = !key || !active;
  document.querySelector("#quick-profile-work-check").checked = Boolean(key && settings.workProfiles?.[key] === active);
  document.querySelector("#quick-profile-work-label").textContent = `이 작품만 ‘${active}’`;
}

function applyProfile(name, { persist = true } = {}) {
  const profile = (settings.readingProfiles ?? []).find((item) => item.name === name);
  if (!profile) return;
  changeTypography(() => Object.assign(settings, profile.values));
  if (persist) saveSettings();
  renderProfiles();
}

// Opening a work with its own profile puts it on; leaving for one without restores the base.
function applyWorkProfile() {
  const name = settings.workProfiles?.[currentWorkKey()];
  if (name && !workProfileBase) {
    workProfileBase = pickProfile();
    applyProfile(name, { persist: false });
  } else if (name) {
    applyProfile(name, { persist: false });
  } else if (workProfileBase) {
    const base = workProfileBase;
    workProfileBase = null;
    changeTypography(() => Object.assign(settings, base));
  }
}

document.querySelector("#quick-profile-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-profile]");
  if (!button) return;
  if (workProfileBase) {
    // Choosing a profile inside a work with its own one changes the base, not the exception.
    workProfileBase = null;
  }
  applyProfile(button.dataset.profile);
});
document.querySelector("#quick-profile-add").addEventListener("click", () => {
  const name = prompt("프로필 이름 (예: 낮, 밤)", (settings.readingProfiles?.length ?? 0) ? "" : "밤")?.trim().slice(0, 12);
  if (!name) return;
  const profiles = (settings.readingProfiles ?? []).filter((profile) => profile.name !== name);
  if (profiles.length >= 6) return void showReaderFeedback("프로필은 6개까지예요", 2200);
  settings.readingProfiles = [...profiles, { name, values: pickProfile() }];
  saveSettings();
  renderProfiles();
  showReaderFeedback(`‘${name}’ 프로필을 저장했어요`);
});
document.querySelector("#quick-profile-work-check").addEventListener("change", (event) => {
  const key = currentWorkKey();
  const active = activeProfileName();
  if (!key || !active) return;
  const works = { ...(settings.workProfiles ?? {}) };
  if (event.target.checked) works[key] = active;
  else delete works[key];
  settings.workProfiles = works;
  if (!event.target.checked) applyWorkProfile();
  saveSettings();
  renderProfiles();
});

// ---- 자동 스크롤 (DESIGN §8.2, docs/24 P6-2) ------------------------------------------------------
// Speed 1–10 (12–120 px/s). Any touch, wheel or key on the text pauses it; the bar takes the
// dock's place. Page mode turns pages instead of scrolling, so it is not offered there.
let autoScroll = null;
function autoScrollTick(now) {
  const state = autoScroll;
  if (!state || state.paused) return;
  const pane = elements["reader-pane"];
  state.carry += ((now - state.last) / 1000) * (settings.autoScrollSpeed ?? 3) * 12;
  state.last = now;
  const step = Math.floor(state.carry);
  if (step) {
    state.carry -= step;
    pane.scrollTop += step;
  }
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) return void pauseAutoScroll();
  state.frame = requestAnimationFrame(autoScrollTick);
}
function renderAutoScroll() {
  document.querySelector("#autoscroll-speed").value = String(settings.autoScrollSpeed ?? 3);
  const toggle = document.querySelector("#autoscroll-toggle");
  toggle.textContent = autoScroll?.paused ? "▶" : "⏸";
  toggle.ariaLabel = autoScroll?.paused ? "다시 흐르기" : "멈추기";
}
function resumeAutoScroll() {
  if (!autoScroll) return;
  autoScroll.paused = false;
  autoScroll.last = performance.now();
  renderAutoScroll();
  autoScroll.frame = requestAnimationFrame(autoScrollTick);
}
function pauseAutoScroll() {
  if (!autoScroll || autoScroll.paused) return;
  autoScroll.paused = true;
  cancelAnimationFrame(autoScroll.frame);
  renderAutoScroll();
}
function stopAutoScroll() {
  if (!autoScroll) return;
  cancelAnimationFrame(autoScroll.frame);
  autoScroll = null;
  elements["autoscroll-bar"].hidden = true;
  document.body.classList.remove("autoscroll-open");
}
document.querySelector("#more-autoscroll").addEventListener("click", () => {
  closeReaderMore();
  if (paged.active || currentMode === "aa") return void showReaderFeedback(paged.active ? "페이지 모드에서는 자동 스크롤을 쓰지 않아요" : "AA는 직접 움직여 보세요", 2400);
  stopAutoScroll();
  autoScroll = { paused: true, carry: 0, last: 0, frame: 0 };
  elements["autoscroll-bar"].hidden = false;
  document.body.classList.add("autoscroll-open");
  overlays.openBar("autoscroll-bar", stopAutoScroll);
  resumeAutoScroll();
});
document.querySelector("#autoscroll-toggle").addEventListener("click", () => (autoScroll?.paused ? resumeAutoScroll() : pauseAutoScroll()));
document.querySelector("#autoscroll-close").addEventListener("click", () => overlays.closeLayer("autoscroll-bar"));
for (const button of document.querySelectorAll("[data-autoscroll-delta]")) {
  button.addEventListener("click", () => {
    settings.autoScrollSpeed = Math.max(1, Math.min(10, (settings.autoScrollSpeed ?? 3) + Number(button.dataset.autoscrollDelta)));
    saveSettings();
    renderAutoScroll();
  });
}
for (const type of ["pointerdown", "wheel"]) elements["reader-pane"].addEventListener(type, pauseAutoScroll, { passive: true });
elements["reader-pane"].addEventListener("keydown", pauseAutoScroll);
document.addEventListener("visibilitychange", () => { if (document.hidden) pauseAutoScroll(); });

// Leaving search clears its conditions (showDestination), so the words are put back afterwards.
document.querySelector("[data-records-scope]").addEventListener("click", async () => {
  const query = elements["search-input"].value.trim();
  history.pushState({ redstmSaved: { view: "excerpts" } }, "", "/saved?view=excerpts");
  await handleRoute();
  if (!query) return;
  elements["search-input"].value = query;
  elements["search-clear"].hidden = false;
  syncSearchRoute();
  renderCurrentView();
});

// Desktop double click keeps its zoom steps; a touch double tap is the judge's above.
elements["archive-body"].addEventListener("dblclick", () => {
  if (currentMode !== "aa" || lastPointerType === "touch") return;
  const zoom = effectiveAaZoom();
  setAaZoom(zoom < 1.25 ? 1.5 : zoom < 1.75 ? 2 : 1);
});
// The sideways position of a wide AA is kept with its zoom. The pane also scrolls down, so only a
// change of the sideways place counts.
let aaLastLeft = 0;
for (const scroller of [elements["archive-body"], elements["reader-pane"], elements["aa-host"]]) {
  scroller.addEventListener("scroll", () => {
    if (scroller !== aaScroller() || currentMode !== "aa" || scroller.scrollLeft === aaLastLeft) return;
    aaLastLeft = scroller.scrollLeft;
    scheduleAaScrollCue();
    if (!currentAaKey()) return;
    clearTimeout(aaLeftTimer);
    aaLeftTimer = setTimeout(() => {
      rememberAaView({ left: aaScroller().scrollLeft });
      persistUserState();
    }, 300);
  }, { passive: true });
}
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
// Backup v4 (docs/24 §12.4): the reading state, the text library and — when this device has the
// owner's store — marks, notes and reading sessions, gzip-compressed where the browser can.
elements["export-state"].addEventListener("click", async () => {
  persistUserState();
  const store = await ownerStore();
  const records = store ? { annotations: await store.getAll("annotations"), sessions: await store.getAll("sessions"), works: await store.getAll("works"), library: await store.get("meta", "library") } : null;
  const json = exportUserState(userState, textLibrary.exportState(), { records });
  const compressed = typeof CompressionStream === "function";
  const blob = compressed
    ? await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).blob()
    : new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `redstm-state-${new Date().toISOString().slice(0, 10)}.json${compressed ? ".gz" : ""}`;
  link.click();
  // Some browsers start the download after click() returns; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
function resetImportReview() {
  pendingImportPlan = null;
  elements["import-review"].hidden = true;
  elements["import-review"].removeAttribute("data-state");
  for (const id of ["import-apply", "import-merge"]) {
    elements[id].disabled = false;
    elements[id].hidden = false;
  }
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
    // Exports are indented, so a full localStorage state (~5MB) can take several MB on disk.
    if (file.size > 16 * 1_048_576) throw new Error("상태 파일은 16MB 이하여야 합니다");
    pendingImportPlan = planImport(await backupText(file), defaultSettings);
    const summary = pendingImportPlan.summary;
    const defaulted = summary.defaultedSettings.length
      ? ` · 기본값 보정 ${summary.defaultedSettings.map((key) => settingLabels[key] ?? key).join(", ")}` : "";
    const exported = Date.parse(summary.exportedAt ?? "");
    elements["import-review-summary"].textContent =
      (Number.isFinite(exported) ? `${new Date(exported).toLocaleString("ko-KR")} 백업 · ` : "") +
      `읽기 ${summary.history} · 저장 ${summary.bookmarks} · 위치 ${summary.scroll} · 보기 ${summary.viewModes}` +
      (summary.textHistory === null ? " · 텍스트 기록 없음(현재 기록 유지)"
        : ` · 텍스트 읽기 ${summary.textHistory} · 텍스트 저장 ${summary.textBookmarks}`) +
      (summary.shelves ? ` · 분류 ${summary.shelves}` : "") +
      (summary.annotations === null ? "" : ` · 표시·메모 ${summary.annotations} · 독서 기록 ${summary.sessions}(항상 합침)`) + defaulted;
    elements["import-review"].dataset.state = "ready";
    elements["import-review"].hidden = false;
    elements["import-merge"].focus();
  } catch (error) {
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = error.message;
    elements["import-review"].dataset.state = "error";
    elements["import-review"].hidden = false;
    elements["import-apply"].disabled = true;
    elements["import-merge"].disabled = true;
  } finally {
    elements["import-state-file"].value = "";
  }
});
elements["import-cancel"].addEventListener("click", resetImportReview);
// 덮어쓰기 replaces this browser's records and settings; 합쳐서 가져오기 keeps the newer record of
// each post, unites saved items and shelves, and leaves the settings as they are.
async function applyImport(merge) {
  if (!pendingImportPlan) return;
  elements["import-apply"].disabled = true;
  elements["import-merge"].disabled = true;
  try {
    persistUserState();
    applyUserState(merge ? mergeUserStates(userState, pendingImportPlan.state) : pendingImportPlan.state);
    persistUserState();
    if (pendingImportPlan.text) {
      textLibrary.importState(merge ? mergeTextStates(textLibrary.exportState(), pendingImportPlan.text) : pendingImportPlan.text);
    }
    const recordsNote = await importRecords(pendingImportPlan.records);
    await hydrateSavedEntries();
    applySettings();
    renderCurrentView();
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = `${merge ? "기록을 합쳐서 가져왔습니다" : "사용자 상태를 가져왔습니다"}${recordsNote}`;
    elements["import-review"].dataset.state = "success";
    elements["import-apply"].hidden = true;
    elements["import-merge"].hidden = true;
    elements["import-cancel"].textContent = "닫기";
    elements["import-cancel"].focus();
  } catch (error) {
    pendingImportPlan = null;
    elements["import-review-summary"].textContent = error.message;
    elements["import-review"].dataset.state = "error";
  }
}
// A backup is gzip (.json.gz, v4) or plain JSON (v1–v3, or where CompressionStream was missing).
async function backupText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream !== "function") throw new Error("이 브라우저는 압축된 백업을 열 수 없습니다");
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  if (text.length > 64 * 1_048_576) throw new Error("백업을 풀면 64MB를 넘습니다");
  return text;
}

// Marks, notes and sessions are always merged (T22): a deletion stays deleted, the later edit
// wins, and nothing here is removed by 덮어쓰기. One transaction, so a failure changes nothing.
async function importRecords(records) {
  if (!records || (!records.annotations.length && !records.sessions.length && !records.works?.length && !records.library)) return "";
  const store = await ownerStore();
  if (!store) return " · 표시·메모·독서 기록은 이 기기 저장소가 없어 가져오지 못했습니다";
  const annotations = mergeAnnotationRecords(await store.getAll("annotations"), records.annotations);
  const sessions = mergeSessionRecords(await store.getAll("sessions"), records.sessions);
  const works = mergeWorkStyles(await store.getAll("works"), records.works || []);
  const previousLibrary = await store.get("meta", "library");
  const library = records.library ? mergeLibrary(previousLibrary, records.library) : null;
  const libraryChanged = library && JSON.stringify(library) !== JSON.stringify(previousLibrary);
  if (!annotations.length && !sessions.length && !works.length && !libraryChanged) return " · 표시·메모·독서 기록은 이미 같습니다";
  try {
    await store.commit([
      ...annotations.map((value) => ({ store: "annotations", value })),
      ...sessions.map((value) => ({ store: "sessions", value })),
      ...works.map((value) => ({ store: "works", value })),
      ...(libraryChanged ? [{ store: "meta", value: library }] : []),
    ]);
  } catch {
    return " · 표시·메모·독서 기록을 저장하지 못했습니다(이전 기록은 그대로)";
  }
  annotationRecords = await store.getAll("annotations");
  paintAnnotations();
  if (libraryChanged || works.length) await personalLibraryChanged(await loadPersonalLibrary());
  const copies = annotations.filter((record) => record.conflictOf).length;
  return ` · 표시·메모 ${annotations.length - copies}건 · 독서 기록 ${sessions.length}건 반영${works.length ? ` · 작품 정보 ${works.length}건` : ""}${libraryChanged ? " · 스마트 서재 반영" : ""}${copies ? ` · 서로 다르게 고친 ${copies}건은 충돌 사본으로 남김(기록 › 발췌)` : ""}`;
}
elements["import-apply"].addEventListener("click", () => void applyImport(false));
elements["import-merge"].addEventListener("click", () => void applyImport(true));

document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault(); personalLibrary.openPalette(); return;
  }
  if (overlays.handleEscape(event)) return;
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
  // Keys inside an open dialog (the gallery's arrows, a sheet) are not Reader commands.
  if (event.target.closest("dialog[open]")) return;
  // Browser and OS shortcuts (Ctrl+F find, Ctrl+B, Cmd+[ …) are not Reader commands.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "/") {
    event.preventDefault();
    showDestination("search");
    elements["search-input"].focus();
  } else if (pageKeys() && (event.key === "Home" || event.key === "End")) {
    event.preventDefault();
    turnPage(event.key === "Home" ? 0 : paged.pages - 1);
  } else if (pageKeys() && ["ArrowLeft", "ArrowRight", " ", "PageUp", "PageDown"].includes(event.key)) {
    event.preventDefault();
    stepPage(event.key === "ArrowLeft" || event.key === "PageUp" || (event.key === " " && event.shiftKey) ? -1 : 1);
  } else if (event.key === "[" || (event.key === "ArrowLeft" && readerSource && currentMode !== "aa")) {
    readerCommand("previous");
  } else if (event.key === "]" || (event.key === "ArrowRight" && readerSource && currentMode !== "aa")) {
    readerCommand("next");
  } else if (event.key.toLowerCase() === "b") {
    readerCommand("bookmark");
  } else if (event.key.toLowerCase() === "g" && readerSource) {
    event.preventDefault();
    openFind();
  } else if (event.key.toLowerCase() === "f" && readerSource) {
    setImmersive(!document.body.classList.contains("immersive"));
  } else if (event.key === "?" && !isNarrowScreen()) {
    openSettings();
    const keys = document.getElementById("settings-keys");
    keys.open = true;
    requestAnimationFrame(() => keys.scrollIntoView({ block: "nearest" }));
  }
});
document.addEventListener("focusin", () => document.body.classList.remove("reader-controls-hidden"));

history.scrollRestoration = "manual";
window.addEventListener("offline", () => {
  elements["archive-state"].textContent = "오프라인";
  if (!archiveReady) renderArchiveError({ code: "offline" });
  void renderOfflineWorks(true);
});
window.addEventListener("online", () => {
  if (archiveReady) elements["archive-state"].textContent = readyLabel();
  elements["offline-works"].hidden = true;
});
// Started without a network (T07): the saved works show even if cached data let the rest load.
if (!navigator.onLine) void renderOfflineWorks(true);
function flushLifecycleState() {
  if (typographyPersistTimer) {
    clearTimeout(typographyPersistTimer);
    typographyPersistTimer = null;
    persistUserState();
  }
  if (currentSummary) persistReadingPosition();
  else if (readerSource === "text" || currentDestination === "text") textLibrary.flush();
  else persistCatalogState();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushLifecycleState();
  else void acquireWakeLock();
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
  // Without the VirtualKeyboard API the find bar rides above the keyboard by this offset.
  const viewport = window.visualViewport;
  const keyboard = viewport && !navigator.virtualKeyboard ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
  document.documentElement.style.setProperty("--keyboard-offset", `${Math.round(keyboard)}px`);
  readerSession.setKeyboardOpen(editing && shrunk);
}
window.visualViewport?.addEventListener("resize", updateKeyboardState);
document.addEventListener("focusout", () => requestAnimationFrame(updateKeyboardState));
matchMedia("(max-width: 759px)").addEventListener("change", applySettings);
// Late web fonts can reflow the body; re-apply the saved position only if the reader has not
// started scrolling in the meantime.
document.fonts.addEventListener("loading", () => { fontGeneration = readerSession.generation; });
document.fonts.addEventListener("loadingdone", () => {
  relayoutPages();
  if (readerSession.afterLayout(fontGeneration)) syncScrollBaseline();
});
elements["archive-body"].addEventListener("load", (event) => {
  if (!elements["archive-body"].contains(event.target)) return;
  relayoutPages();
  if (readerSession.afterLayout(readerSession.generation)) syncScrollBaseline();
}, { capture: true });
elements["reader-pane"].addEventListener("wheel", () => readerSession.markUserScroll(), { passive: true });
elements["reader-pane"].addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes(event.key) &&
      !event.target.closest("input, textarea, [contenteditable]")) readerSession.markUserScroll();
});
async function personalWorkData() {
  const [index, textWorks] = await Promise.all([collectionIndex().catch(() => null), textLibrary.metadataWorks()]);
  const reading = index ? await collectionReadingProgress(index).catch(() => ({ progress: new Map(), failedBoards: new Set() })) : null;
  return [
    ...(index?.summaries || []).map((item) => {
      const state = reading.progress.get(item.id);
      return {
        key: workKey({ source: "typemoon", id: item.id }), title: item.title, author: item.author, source: "typemoon", sourceLabel: "타입문넷",
        chapters: item.entry_count ?? item.entries?.length ?? 0,
        read: reading.failedBoards.has(item.board_id) ? "unknown" : collectionOccupancy({ availableCount: collectionAvailableCount(item), finishedCount: state?.finished || 0, readingCount: state?.reading || 0 }),
        fresh: hasNewEpisodes(item, state), aa: item.is_aa === true || boardById.get(item.board_id)?.is_aa === true,
        collectionId: item.id,
      };
    }), ...textWorks,
  ];
}
async function loadPersonalLibrary() {
  const store = await ownerStore();
  const legacy = textLibrary.shelfState();
  const raw = store ? await store.get("meta", "library") : null;
  const config = sanitizeLibrary(raw || { shelves: otherOwners().length ? [] : legacy.shelves });
  const records = store ? await store.getAll("works") : [];
  if (!raw && !otherOwners().length) {
    for (const [id, shelfId] of Object.entries(legacy.workShelves || {})) {
      if (!records.some((record) => record.workKey === `novel:${id}`)) records.push({ workKey: `novel:${id}`, shelfId, updatedAt: "1970-01-01T00:00:00.000Z" });
    }
  }
  return { config, styles: new Map(records.map(sanitizeWorkStyle).filter(Boolean).map((record) => [record.workKey, record])), canSave: Boolean(store) };
}
async function personalLibraryChanged(state) {
  textLibrary.applyLibraryShelves(state.config, state.styles);
  if (currentDestination === "library") void personalLibrary.renderHome();
}
async function openPersonalWork(work) {
  if (work.collectionId !== undefined) return openCollectionDetail(work.collectionId);
  persistReadingPosition();
  history.pushState({ redstmText: true, redstmParent: currentRoute() }, "", work.route);
  await handleRoute();
}
const classifyButton = document.createElement("button");
classifyButton.id = "collection-classify"; classifyButton.type = "button"; classifyButton.textContent = "분류·고정";
document.querySelector(".collection-actions").append(classifyButton);
const readerClassify = document.createElement("button"); readerClassify.id = "reader-work-classify"; readerClassify.type = "button";
// A tile like its neighbours in the 더보기 grid: a folder icon over the label.
readerClassify.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z"/><path d="m12 11 .9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2-1.45-1.4 2-.3Z"/></svg><span>분류·고정</span>';
document.querySelector("#reader-work-find").after(readerClassify);
readerClassify.addEventListener("click", async () => {
  closeReaderMore();
  const work = readerSource === "text" ? textLibrary.styleWork() : currentCollection ? {
    key: workKey({ source: "typemoon", id: currentCollection.collection.id }), title: currentCollection.collection.title, source: "typemoon",
  } : null;
  if (!work || !await personalLibrary.openWork(work)) showReaderFeedback("작품 분류를 저장할 수 없어요", 2200);
});
personalLibrary = createPersonalLibrary({
  host: elements["reading-works"], overlays, getData: personalWorkData, load: loadPersonalLibrary,
  async save(config, styles) {
    const store = await ownerStore();
    if (!store) throw new Error("owner_unavailable");
    const changes = new Map();
    if (!await store.get("meta", "library")) for (const value of (await loadPersonalLibrary()).styles.values()) changes.set(value.workKey, value);
    for (const value of styles) changes.set(value.workKey, value);
    await store.commit([{ store: "meta", value: config }, ...[...changes.values()].map((value) => ({ store: "works", value }))]);
  },
  onChanged: personalLibraryChanged, onOpen: openPersonalWork,
  makeCard: (work) => shelfCard({ title: work.title, source: work.sourceLabel, hueKey: work.key, meta: [work.sourceLabel], open: () => void openPersonalWork(work) }),
  libraries: { hangul, UFuzzy }, feedback: (message) => showReaderFeedback(message, 2400), visible: () => currentDestination === "library",
  commands: () => [
    { title: "서재로", run: () => showDestination("library") }, { title: "둘러보기", run: () => showDestination("browse") },
    { title: "검색", run: () => showDestination("search") }, { title: "기록", run: () => showDestination("bookmarks") },
    { title: "설정", run: openSettings },
    ...(readerSource ? [{ title: "본문 찾기", run: openFind }, { title: "작품에서 찾기", run: () => void openWorkSearch() }] : []),
  ],
});

applySettings();
// Text archive routes do not depend on the TypeMoon search index; start them immediately.
if (location.pathname === "/text") {
  // A reload on a body (or a tab Chrome restored) rebuilds the list and the work's chapters before
  // the body; those steps stay hidden so the reader is the first screen that shows (styles/base.css).
  const params = new URLSearchParams(location.search);
  if (params.has("item") || params.has("chapter")) document.body.classList.add("restoring-text");
  void handleRoute().finally(() => document.body.classList.remove("restoring-text"));
}

// Service worker (docs/24 §12.6): registered once the page has settled; its caches are the owner's.
const offline = createOffline({
  // Not a toast that a past answer quietly covers: a sheet, with the saved works as a choice (T09).
  // Once closed it stays closed for this page: later failed requests would only reopen it.
  onAuthExpired: () => {
    if (!authSheetClosed && !elements["auth-dialog"].open) elements["auth-dialog"].showModal();
  },
  onSave: (message) => void offlineProgress(message),
  onUpdateReady: () => {
    updateReady = true;
    overlays.showToast(document.querySelector("#update-ready"));
  },
});
void restoreMirroredStates();
const startOffline = () => void ownerIdentity().then((hash) => {
  offline.setOwner(hash);
  return offline.register();
}).then(async () => {
  if (activeCollectionId === null) return;
  const collection = await loadCollectionDetail(activeCollectionId);
  if (collection) await showOfflineControl(collection);
}).catch(() => {});
if (document.readyState === "complete") startOffline();
else addEventListener("load", startOffline, { once: true });
