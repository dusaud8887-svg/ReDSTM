import {
  STATE_KEY,
  defaultUserState,
  exportUserState,
  migrateLegacyState,
  planImport,
  postIdentity,
  samePost,
} from "/user-state.js";

const postObjectKeyPattern = /^posts\/([a-z0-9_]+)\/([1-9]\d*)-[a-f0-9]{64}\.json\.(?:gz|zst)$/;
const collectionObjectKeyPattern = /^collections\/[a-z0-9_/-]+-[a-f0-9]{64}\.json\.zst$/;
const titleCollator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
const storageKeys = {
  settings: "redstm.settings.v1",
  history: "redstm.history.v1",
  bookmarks: "redstm.bookmarks.v1",
};
const defaultSettings = {
  theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, proseFont: "serif",
  aaSize: 16, aaZoom: 1, aaCanvasWidth: null, aaBackground: "#f5f5f0", aaPreserveStyles: true,
  viewModes: {},
};
const settingLabels = {
  theme: "테마", proseSize: "본문 크기", lineHeight: "줄 간격", proseWidth: "본문 너비",
  proseFont: "본문 서체", aaSize: "AA 크기", aaZoom: "AA 확대", aaCanvasWidth: "AA 폭",
  aaBackground: "AA 배경", aaPreserveStyles: "AA 원본색",
};
const elements = Object.fromEntries(
  [
    "archive-count", "archive-state", "search-input", "board-filter", "mode-filter", "sort-filter", "result-status", "result-list", "result-more",
    "reader-pane", "empty-reader", "empty-count", "reader", "reader-kicker", "reader-title", "reader-meta", "collection-context",
    "scope-tabs", "collection-view", "collection-back", "collection-title", "collection-meta", "collection-entry-list",
    "archive-body", "comment-count", "comment-list", "previous-post", "next-post", "bookmark-post", "source-link",
    "theme-toggle", "reader-settings", "settings-dialog", "prose-size", "line-height", "prose-width", "aa-size",
    "prose-size-output", "line-height-output", "prose-width-output", "aa-size-output", "reset-settings",
    "export-state", "import-state", "import-state-file", "continue-reading", "continue-title",
    "continue-meta", "catalog-back", "prose-font", "aa-controls", "aa-inline-size",
    "aa-source-styles", "aa-background", "aa-zoom-output", "aa-zoom-reset", "aa-zoom-indicator",
    "reading-progress", "immersive-toggle", "end-previous", "end-next",
    "end-previous-title", "end-next-title", "mode-toggle", "mode-reset", "theme-select",
    "home-title", "home-freshness", "latest-list", "recent-list", "browse-all",
    "reader-bottom-list", "reader-bottom-previous", "reader-bottom-bookmark", "reader-bottom-next", "reader-bottom-settings",
    "post-settings-actions", "settings-bookmark", "settings-source", "settings-mode", "settings-mode-reset", "settings-immersive",
    "catalog-toggle", "catalog-title", "catalog-subtitle", "home-action", "immersive-exit", "import-review", "import-review-summary", "import-apply", "import-cancel",
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
let currentScope = "posts";
let collectionSearchId = 0;
let currentView = "all";
let currentDestination = "library";
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
let immersiveOpener = null;
const workerRequests = new Map();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

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
      postIdentity(entry.summary), { savedAt: entry.savedAt },
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

function applySettings() {
  const root = document.documentElement;
  const dark = settings.theme === "dark" ||
    (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--prose-size", `${settings.proseSize}px`);
  root.style.setProperty("--prose-line", settings.lineHeight);
  root.style.setProperty("--prose-width", `${settings.proseWidth}px`);
  root.style.setProperty("--prose-font", settings.proseFont === "sans" ? "var(--font-ui)" : "var(--font-reading)");
  root.style.setProperty("--aa-effective-size", `${settings.aaSize * settings.aaZoom}px`);
  root.style.setProperty("--aa-effective-line", `${settings.aaSize * 1.125 * settings.aaZoom}px`);
  root.style.setProperty("--aa-background", settings.aaBackground);
  root.style.setProperty("--aa-ink", readableAaInk(settings.aaBackground));
  elements["theme-toggle"].ariaLabel = dark ? "밝은 테마로 전환" : "어두운 테마로 전환";
  elements["theme-toggle"].title = elements["theme-toggle"].ariaLabel;
  elements["theme-select"].value = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0b0d12" : "#ffffff";
  for (const [id, value, suffix] of [
    ["prose-size", settings.proseSize, "px"],
    ["line-height", settings.lineHeight, ""],
    ["prose-width", settings.proseWidth, "px"],
    ["aa-size", settings.aaSize, "px"],
  ]) {
    elements[id].value = value;
    elements[`${id}-output`].value = `${value}${suffix}`;
  }
  const fitWidth = isNarrowScreen();
  elements["prose-width"].disabled = fitWidth;
  elements["prose-width-output"].value = fitWidth ? "화면 맞춤" : `${settings.proseWidth}px`;
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

function renderHomeList(element, posts, emptyText) {
  element.replaceChildren();
  if (!posts.length) {
    const empty = document.createElement("li");
    empty.className = "home-empty";
    empty.textContent = emptyText;
    element.append(empty);
    return;
  }
  for (const post of posts.slice(0, 6)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    button.type = "button";
    button.className = "home-item";
    title.textContent = post.title || "제목 없음";
    meta.textContent = [post.board_id, post.author, post.created_at_raw].filter(Boolean).join(" · ");
    button.append(title, meta);
    button.addEventListener("click", () => loadPost(post));
    item.append(button);
    element.append(item);
  }
}

function renderCover(
  title = "내 장서",
  description = "새로 보존된 글과 최근 기록을 확인하세요.",
  showContinue = true,
  actionLabel = "",
) {
  document.body.classList.remove("collection-detail-open");
  elements.reader.hidden = true;
  elements["collection-view"].hidden = true;
  elements["empty-reader"].hidden = false;
  elements["home-title"].textContent = title;
  elements["empty-reader"].querySelector(".cover-copy").textContent = description;
  const published = publishedAt && !Number.isNaN(Date.parse(publishedAt))
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(publishedAt))
    : null;
  const newest = latestPosts[0]?.created_at_raw;
  elements["home-freshness"].textContent = published
    ? `마지막 보존 ${published}${newest ? ` · 최신 기록 ${newest}` : ""}`
    : "마지막 갱신 확인 중";
  elements["home-action"].hidden = !actionLabel;
  elements["home-action"].textContent = actionLabel;
  const latestEntry = historyEntries.find((entry) => entry.summary?.object_key && (entry.progress ?? 0) < 0.95);
  const latest = latestEntry?.summary;
  elements["continue-reading"].hidden = !latest || !showContinue;
  if (latest) {
    const progress = latestEntry.progress > 0 ? `${Math.round(latestEntry.progress * 100)}% 읽음` : "처음부터";
    elements["continue-title"].textContent = latest.title || "제목 없음";
    elements["continue-meta"].textContent = [latest.board_id, latest.author, progress].filter(Boolean).join(" · ");
  }
  renderHomeList(elements["latest-list"], latestPosts, "새로 보존된 글이 없습니다.");
  renderHomeList(elements["recent-list"], historyEntries.map((entry) => entry.summary), "아직 읽은 기록이 없습니다.");
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
  document.body.classList.remove("home-open");
  document.body.classList.add("reader-open");
}

function closeMobileReader(focusSearch = currentDestination !== "library") {
  document.body.classList.remove("reader-open");
  document.body.classList.remove("collection-detail-open");
  document.body.classList.remove("reader-controls-hidden");
  document.body.classList.toggle("home-open", currentDestination === "library");
  if (focusSearch) elements["search-input"].focus({ preventScroll: true });
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
  const options = collectionScope
    ? [["가나다순", "title"], ["편수 많은순", "longest"]]
    : [["최신순", "latest"], ["오래된순", "oldest"]];
  elements["sort-filter"].replaceChildren(...options.map(([label, value]) => new Option(label, value)));
  elements["mode-filter"].closest("label").hidden = collectionScope;
  elements["search-input"].placeholder = collectionScope ? "작품 제목 검색" : "제목, 작성자, 분류 검색";
}

function currentSearchState() {
  return {
    query: elements["search-input"].value,
    boardId: elements["board-filter"].value,
    mode: elements["mode-filter"].value,
    sort: elements["sort-filter"].value,
  };
}

function searchUrl(state = currentSearchState()) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.boardId) params.set("board", state.boardId);
  if (currentScope === "posts" && state.mode !== "all") params.set("mode", state.mode);
  const defaultSort = currentScope === "collections" ? "title" : "latest";
  if (state.sort !== defaultSort) params.set("sort", state.sort);
  const query = params.toString();
  const path = currentScope === "collections" ? "/collections" : "/search";
  return query ? `${path}?${query}` : path;
}

function savedUrl(state = currentSearchState(), view = currentView) {
  const params = new URLSearchParams();
  if (view === "history") params.set("view", "recent");
  if (state.query) params.set("q", state.query);
  if (state.boardId) params.set("board", state.boardId);
  if (state.mode !== "all") params.set("mode", state.mode);
  const query = params.toString();
  return query ? `/saved?${query}` : "/saved";
}

function applyCatalogRoute(destination) {
  const params = new URLSearchParams(location.search);
  setScope(destination === "search" && location.pathname.startsWith("/collections") ? "collections" : "posts");
  elements["search-input"].value = params.get("q") ?? "";
  elements["board-filter"].value = params.get("board") ?? "";
  const mode = params.get("mode");
  elements["mode-filter"].value = searchSupportsAa && (mode === "aa" || mode === "prose") ? mode : "all";
  const sort = params.get("sort");
  elements["sort-filter"].value = currentScope === "collections"
    ? (sort === "longest" ? sort : "title")
    : (destination === "search" && sort === "oldest" ? sort : "latest");
  currentView = destination === "bookmarks" && params.get("view") === "recent" ? "history" :
    destination === "bookmarks" ? "bookmarks" : "all";
}

function syncSearchRoute() {
  const state = currentSearchState();
  if (location.pathname === "/search" || location.pathname === "/collections") {
    history.replaceState({ redstmSearch: state }, "", searchUrl(state));
  } else if (location.pathname === "/saved") {
    history.replaceState({ redstmSaved: { ...state, view: currentView } }, "", savedUrl(state));
  }
}

function updateDestinationLayout() {
  const home = currentDestination === "library";
  const saved = currentDestination === "bookmarks";
  document.body.classList.toggle("home-open", home);
  document.body.classList.toggle("saved-open", saved);
  elements["scope-tabs"].hidden = currentDestination !== "search";
  document.querySelector(".saved-tabs").hidden = !saved;
  document.querySelector(".sort-field").hidden = saved;
  elements["mode-filter"].closest("label").hidden = saved || currentScope === "collections";
  elements["catalog-title"].textContent = saved ? "내 보관함" : currentScope === "collections" ? "작품 탐색" : "글 탐색";
  elements["catalog-subtitle"].textContent = saved
    ? (currentView === "history" ? "최근 읽은 글" : "저장한 글")
    : currentScope === "collections" ? "연재·번역·AA 목차" : "전체 보존본";
}

function openSettings() {
  if (!elements["settings-dialog"].open) elements["settings-dialog"].showModal();
  elements["settings-dialog"].querySelector("form").scrollTop = 0;
}

function persistCatalogState() {
  const search = currentSearchState();
  if (currentDestination === "bookmarks") search.sort = "latest";
  const focused = document.activeElement?.closest?.(".result-item");
  userState.lastCatalogState = {
    destination: currentDestination,
    view: currentView,
    ...search,
    scrollTop: elements["result-list"].scrollTop,
    focusedPost: focused ? postIdentity(renderedResults[Number(focused.dataset.index)]) : "",
  };
  pendingCatalogRestore = userState.lastCatalogState;
  persistUserState();
}

function restoreCatalogPosition() {
  const state = pendingCatalogRestore;
  if (currentSummary || !state || state.destination !== currentDestination || state.view !== currentView) return;
  const current = currentSearchState();
  if (state.query !== current.query || state.boardId !== current.boardId ||
      (state.mode ?? "all") !== current.mode ||
      (currentDestination !== "bookmarks" && state.sort !== current.sort)) return;
  requestAnimationFrame(() => {
    elements["result-list"].scrollTop = Math.max(0, state.scrollTop ?? 0);
    const index = renderedResults.findIndex((post) => postIdentity(post) === state.focusedPost);
    if (index < 0 && state.focusedPost && currentView === "all" && renderedResults.length < resultTotal) {
      requestSearch(renderedResults.length);
      return;
    }
    pendingCatalogRestore = null;
    if (index >= 0) elements["result-list"].querySelector(`[data-index="${index}"]`)?.focus({ preventScroll: true });
  });
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
  if (currentSummary) persistReadingPosition();
  else if (currentDestination !== "library" && currentScope === "posts") persistCatalogState();
  setImmersive(false, false);
  if (destination !== "search") setScope("posts");
  currentDestination = destination;
  currentView = view;
  document.title = `${destination === "library" ? "홈" : destination === "search" ? (currentScope === "collections" ? "작품 탐색" : "글 탐색") : "내 보관함"} — ReDSTM`;
  currentSummary = null;
  currentPayload = null;
  document.body.classList.remove("catalog-collapsed", "reader-controls-hidden");
  elements["catalog-toggle"].setAttribute("aria-expanded", "true");
  elements["post-settings-actions"].hidden = true;
  updateDestinationLayout();
  if (destination === "library") renderCover();
  else if (destination === "search" && currentScope === "collections") renderCover("작품을 선택하세요", "작품별 목차에서 이어서 읽을 수 있습니다.", false);
  else if (destination === "search") renderCover("탐색에서 글을 선택하세요", "검색하거나 목록에서 읽을 글을 고르세요.", false);
  else renderCover("보관함에서 글을 선택하세요", "저장한 글이나 최근 읽은 글을 고르세요.", false);
  closeMobileReader(destination === "search");
  if (destination === "bookmarks") {
    updateTabs();
    renderCurrentView();
  } else {
    currentView = "all";
    updateTabs();
    if (currentScope === "collections") void renderCollectionCatalog();
    else requestSearch();
  }
  updateDestinationButtons();
  const path = destination === "library" ? "/" : destination === "bookmarks" ? savedUrl() : searchUrl();
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
  elements["settings-immersive"].textContent = active ? "집중 종료" : "집중";
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

async function handleRoute() {
  const summary = routeSummary();
  if (!summary) {
    const collectionId = routeCollectionId();
    const settingsRoute = location.pathname === "/settings";
    const destination = location.pathname === "/saved" ? "bookmarks" :
      (location.pathname === "/search" || location.pathname.startsWith("/collections")) ? "search" : "library";
    if (destination !== "library") applyCatalogRoute(destination);
    showDestination(destination, false, currentView);
    if (collectionId !== null) await openCollectionDetail(collectionId, false);
    else if (destination !== "library") syncSearchRoute();
    if (settingsRoute) {
      openSettings();
      document.title = "읽기 설정 — ReDSTM";
    }
    else if (!settingsRoute && elements["settings-dialog"].open) elements["settings-dialog"].close();
    return;
  }
  if (elements["settings-dialog"].open) elements["settings-dialog"].close();
  if (!samePost(summary, currentSummary)) await loadPost(summary, false);
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
    else pending.resolve(data.summaries);
    return;
  }
  if (data.type === "error") {
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
    for (const board of data.boardMetadata) {
      const name = board.name === board.board_id ? board.name : `${board.name} · ${board.board_id}`;
      const label = [board.group_name, name].filter(Boolean).join(" · ");
      elements["board-filter"].add(new Option(label, board.board_id));
    }
    renderCover();
    requestSearch();
    void hydrateSavedEntries().then(() => {
      if (!currentSummary) renderCover();
      if (currentView !== "all") renderCurrentView();
    }).catch((error) => { elements["result-status"].textContent = error.message; });
    void handleRoute();
    return;
  }
  if (data.type === "results" && data.id === searchRequestId && currentView === "all" && currentScope === "posts") {
    resultTotal = data.total;
    if (searchAppend) appendResults(data.posts);
    else {
      const count = data.posts.length < data.total
        ? `${data.total.toLocaleString("ko-KR")}건 중 ${data.posts.length.toLocaleString("ko-KR")}건`
        : `${data.total.toLocaleString("ko-KR")}건`;
      renderResults(data.posts, `${count} · ${data.elapsedMs.toFixed(1)}ms`);
    }
  }
}

function requestSearch(offset = 0) {
  if (currentScope === "collections") {
    void renderCollectionCatalog(offset);
    return;
  }
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
  const query = normalized(elements["search-input"].value).trim();
  const board = elements["board-filter"].value;
  const mode = elements["mode-filter"].value;
  return entries
    .map((entry) => entry.summary)
    .filter((post) => !board || post.board_id === board)
    .filter((post) => mode === "all" || (mode === "aa") === Boolean(post.is_aa))
    .filter((post) => !query || normalized([post.title, post.author, post.category, post.board_id].join(" ")).includes(query));
}

function renderCurrentView() {
  if (currentScope === "collections") return void renderCollectionCatalog();
  if (currentView === "all") return requestSearch();
  const entries = currentView === "history" ? historyEntries : bookmarks;
  const posts = localResults(entries);
  const label = currentView === "history" ? "최근 읽은 글" : "저장한 글";
  renderResults(posts, `${label} ${posts.length}건 · 이 브라우저`);
}

function resultItemElement(post, index, readIdentities, savedIdentities) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "result-item";
  button.dataset.index = index;
  button.classList.toggle("active", samePost(post, currentSummary));
  const title = document.createElement("strong");
  title.className = "result-title";
  title.textContent = post.title || "제목 없음";
  const titleLine = document.createElement("span");
  titleLine.className = "result-title-line";
  const badges = document.createElement("span");
  badges.className = "result-badges";
  const identity = postIdentity(post);
  for (const [visible, label] of [
    [post.is_aa === true, "AA"], [savedIdentities.has(identity), "저장"], [readIdentities.has(identity), "읽음"],
  ]) {
    if (!visible) continue;
    const badge = document.createElement("span");
    badge.textContent = label;
    badges.append(badge);
  }
  titleLine.append(title);
  if (badges.childElementCount) titleLine.append(badges);
  const meta = document.createElement("span");
  meta.className = "result-meta";
  for (const [text, className] of [
    [post.board_id, "result-board"], [post.author || "작성자 없음", ""], [post.created_at_raw || "날짜 없음", ""],
  ]) {
    const part = document.createElement("span");
    part.className = className;
    part.textContent = text;
    meta.append(part);
  }
  button.append(titleLine, meta);
  item.append(button);
  return item;
}

function stateIdentities() {
  return {
    read: new Set(historyEntries.map((entry) => postIdentity(entry.summary)).filter(Boolean)),
    saved: new Set(bookmarks.map((entry) => postIdentity(entry.summary)).filter(Boolean)),
  };
}

function renderResults(posts, status) {
  renderedResults = posts;
  elements["result-status"].textContent = status;
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const { read, saved } = stateIdentities();
  const fragment = document.createDocumentFragment();
  posts.forEach((post, index) => fragment.append(resultItemElement(post, index, read, saved)));
  elements["result-list"].append(fragment);
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
  elements["result-status"].textContent = `${resultTotal.toLocaleString("ko-KR")}건`;
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
    if (requestId !== collectionSearchId || currentScope !== "collections") return;
    const query = normalized(elements["search-input"].value).trim();
    const boardId = elements["board-filter"].value;
    const matches = index.summaries
      .filter((collection) => !boardId || collection.board_id === boardId)
      .filter((collection) => !query || normalized(collection.title).includes(query))
      .sort(elements["sort-filter"].value === "longest"
        ? (left, right) => right.entry_count - left.entry_count || titleCollator.compare(left.title, right.title)
        : (left, right) => titleCollator.compare(left.title, right.title) || left.id - right.id);
    resultTotal = matches.length;
    renderedCollections = matches.slice(0, offset + RESULT_PAGE_SIZE);
    renderCollectionResults();
  } catch (error) {
    if (requestId === collectionSearchId) renderArchiveError(error, "작품 목록을 열 수 없음");
  }
}

function renderCollectionResults() {
  elements["result-list"].classList.remove("loading");
  elements["result-list"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const collection of renderedCollections) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.dataset.collectionId = collection.id;
    button.classList.toggle("active", collection.id === activeCollectionId);
    const title = document.createElement("strong");
    title.className = "result-title";
    title.textContent = collection.title;
    const meta = document.createElement("span");
    meta.className = "result-meta";
    for (const text of [collection.board_id, `${collection.entry_count.toLocaleString("ko-KR")}편`]) {
      const part = document.createElement("span");
      part.textContent = text;
      meta.append(part);
    }
    button.append(title, meta);
    item.append(button);
    fragment.append(item);
  }
  elements["result-list"].append(fragment);
  const shown = renderedCollections.length;
  elements["result-status"].textContent = shown < resultTotal
    ? `${resultTotal.toLocaleString("ko-KR")}개 작품 중 ${shown.toLocaleString("ko-KR")}개`
    : `${resultTotal.toLocaleString("ko-KR")}개 작품`;
  updateLoadMore();
}

async function openCollectionDetail(collectionId, navigate = true) {
  elements["reader-pane"].setAttribute("aria-busy", "true");
  try {
    const collection = await loadCollectionDetail(collectionId);
    if (!collection) throw new Error("현재 보존본에서 작품을 찾을 수 없습니다");
    currentSummary = null;
    currentPayload = null;
    currentCollection = null;
    activeCollectionId = collection.id;
    setScope("collections");
    currentDestination = "search";
    updateDestinationLayout();
    updateDestinationButtons();
    elements["empty-reader"].hidden = true;
    elements.reader.hidden = true;
    elements["collection-view"].hidden = false;
    document.body.classList.add("collection-detail-open");
    elements["collection-title"].textContent = collection.title;
    const unavailable = collection.entries.filter((entry) => !entry.object_key).length;
    elements["collection-meta"].textContent = [
      collection.board_id,
      `${collection.entries.length.toLocaleString("ko-KR")}편`,
      unavailable ? `${unavailable.toLocaleString("ko-KR")}편 보존 불가` : "전체 보존",
    ].join(" · ");
    const fragment = document.createDocumentFragment();
    for (const entry of collection.entries) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "collection-entry";
      button.disabled = !entry.object_key;
      button.dataset.position = entry.position;
      const position = document.createElement("span");
      position.className = "collection-entry-position";
      position.textContent = `${entry.position}편`;
      const title = document.createElement("span");
      title.className = "collection-entry-title";
      title.textContent = entry.title || "제목 없음";
      button.append(position, title);
      item.append(button);
      fragment.append(item);
    }
    elements["collection-entry-list"].replaceChildren(fragment);
    elements["collection-entry-list"].dataset.collectionId = collection.id;
    document.title = `${collection.title} — ReDSTM`;
    if (navigate) history.pushState({ redstmCollection: true }, "", `/collections/${collection.id}`);
    openMobileReader();
    requestAnimationFrame(() => elements["collection-title"].focus({ preventScroll: true }));
  } catch (error) {
    renderArchiveError(error, "작품 목차를 열 수 없음");
  } finally {
    elements["reader-pane"].removeAttribute("aria-busy");
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
        ({ id, board_id, kind, title, entry_count: entries.length })),
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
        !Number.isInteger(summary.entry_count) || summary.entry_count < 0 || summaries.has(summary.id)) {
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
            member.some((value) => !Number.isInteger(value) || value <= 0) || memberships.has(member[0])) {
          throw new Error("잘못된 컬렉션 소속 글");
        }
        memberships.set(member[0], { collectionId: member[1], position: member[2] });
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
  elements["previous-post"].disabled = true;
  elements["next-post"].disabled = true;
  elements["end-previous"].disabled = true;
  elements["end-next"].disabled = true;
  try {
    const membership = await findCollection(summary);
    if (!samePost(summary, currentSummary)) return;
    currentCollection = membership;
    if (membership) {
      activeCollectionId = membership.collection.id;
      const unavailable = membership.collection.entries.filter((entry) => !entry.object_key).length;
      const label = `${membership.collection.title} · ${membership.index + 1}/${membership.collection.entries.length}` +
        (unavailable ? ` · ${unavailable}건 보존 불가` : "");
      elements["collection-context"].textContent = label;
      elements["collection-context"].title = label;
      elements["collection-context"].hidden = false;
    }
    updateNavigation();
  } catch {
    if (samePost(summary, currentSummary)) updateNavigation();
  }
}

async function loadPost(summary, navigate = true) {
  if (currentSummary) persistReadingPosition();
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  if (!currentSummary) renderCover("본문을 불러오는 중", "보존 객체를 확인하고 있습니다.", false);
  try {
    const resolved = summary?.object_key ? summary : (await resolvePosts([summary]))[0];
    if (!resolved?.object_key) throw new Error("현재 보존본에서 글을 찾을 수 없습니다");
    const response = await fetch(`/archive/${resolved.object_key}`, { signal: postController.signal });
    requireArchiveResponse(response, response.status === 404 ? "보존 객체가 없습니다" : `본문 응답 ${response.status}`);
    const payload = await responseJsonWithProgress(response, "본문");
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
    elements["archive-state"].textContent = "보존본";
    showPost(payload, resolved, navigate);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderArchiveError(error, "본문을 열 수 없음");
      if (error.code !== "access_expired" && navigator.onLine) elements["archive-state"].textContent = "본문 오류";
    }
  } finally {
    elements["reader-pane"].removeAttribute("aria-busy");
  }
}

function showPost(payload, suppliedSummary, navigate) {
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
  elements["reading-progress"].style.width = "0%";
  lastReaderScroll = 0;
  readerScrollDelta = 0;
  document.body.classList.remove("reader-controls-hidden");
  const collapseCatalog = matchMedia("(min-width: 760px) and (max-width: 899px)").matches;
  document.body.classList.toggle("catalog-collapsed", collapseCatalog);
  elements["catalog-toggle"].setAttribute("aria-expanded", String(!collapseCatalog));
  elements["empty-reader"].hidden = true;
  elements["collection-view"].hidden = true;
  elements.reader.hidden = false;
  document.body.classList.remove("collection-detail-open");
  elements["reader-kicker"].textContent = [post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  document.title = `${post.title || "제목 없음"} — ReDSTM`;
  elements["reader-meta"].textContent = [post.author || "작성자 없음", post.created_at_raw, `조회 ${post.views ?? 0}`].filter(Boolean).join(" · ");
  elements["source-link"].href = post.canonical_url;
  elements["settings-source"].href = post.canonical_url;
  elements["post-settings-actions"].hidden = false;
  renderPostBody();
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  void updateCollection();
  if (currentScope === "collections") renderCollectionResults();
  else renderResults(renderedResults, elements["result-status"].textContent);
  const nextUrl = `/read/${currentSummary.board_id}/${currentSummary.external_post_id}`;
  if (navigate) {
    const previousDepth = history.state?.redstmReaderDepth;
    const readerDepth = previousDepth === undefined ? 1 : previousDepth > 0 ? previousDepth + 1 : 0;
    history.pushState({ redstmReader: true, redstmReaderDepth: readerDepth }, "", nextUrl);
  } else {
    const readerDepth = Number(history.state?.redstmReaderDepth) || 0;
    history.replaceState({ redstmReader: readerDepth > 0, redstmReaderDepth: readerDepth }, "", nextUrl);
  }
  openMobileReader();
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
  elements["settings-mode"].textContent = elements["mode-toggle"].textContent;
  elements["mode-reset"].hidden = !override;
  elements["settings-mode-reset"].hidden = !override;
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
  requestAnimationFrame(() => updateAaOverflowCue(true));
}

function normalizeReaderTypography(container) {
  for (const element of container.querySelectorAll('font, [style*="font" i], [style*="line-height" i]')) {
    for (const property of ["font-family", "font-size", "line-height"]) {
      element.style.setProperty(property, "inherit", "important");
    }
  }
}

function decorateImages(container) {
  for (const image of container.querySelectorAll("img")) {
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      const link = document.createElement("a");
      link.className = "image-fallback";
      link.href = image.src;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = image.alt || "이미지 링크";
      image.replaceWith(link);
    }, { once: true });
  }
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
  historyEntries = historyEntries.slice(0, 500);
  persistUserState();
}

function isNarrowScreen() {
  return matchMedia("(max-width: 759px)").matches;
}

function readingPosition() {
  return elements["reader-pane"].scrollTop;
}

function restoreReadingPosition(summary) {
  const position = historyEntries.find((entry) => samePost(entry.summary, summary))?.scroll ?? 0;
  lastReaderScroll = position;
  readerScrollDelta = 0;
  elements["reader-pane"].scrollTop = position;
}

function persistReadingPosition() {
  clearTimeout(scrollTimer);
  const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
  if (entry) {
    entry.scroll = readingPosition();
    const maximum = elements["reader-pane"].scrollHeight - elements["reader-pane"].clientHeight;
    entry.progress = maximum > 0 ? Math.min(1, entry.scroll / maximum) : 0;
  }
  persistUserState();
}

function queueScrollSave() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(persistReadingPosition, 250);
}

function updateReadingProgress() {
  const maximum = elements["reader-pane"].scrollHeight - elements["reader-pane"].clientHeight;
  const progress = maximum > 0 ? Math.min(1, elements["reader-pane"].scrollTop / maximum) : 0;
  elements["reading-progress"].style.width = `${progress * 100}%`;
  elements["reading-progress"].setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function updateBookmarkButton() {
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  elements["bookmark-post"].setAttribute("aria-pressed", active);
  elements["reader-bottom-bookmark"].setAttribute("aria-pressed", active);
  elements["settings-bookmark"].setAttribute("aria-pressed", active);
  elements["settings-bookmark"].textContent = active ? "저장 취소" : "저장";
  elements["bookmark-post"].ariaLabel = active ? "저장 취소" : "저장";
  elements["bookmark-post"].title = elements["bookmark-post"].ariaLabel;
  elements["reader-bottom-bookmark"].ariaLabel = elements["bookmark-post"].ariaLabel;
}

function updateNavigation() {
  const previous = adjacentPost(-1);
  const next = adjacentPost(1);
  if (currentCollection) {
    elements["previous-post"].disabled = !previous;
    elements["next-post"].disabled = !next;
  } else {
    const index = renderedResults.findIndex((post) => samePost(post, currentSummary));
    elements["previous-post"].disabled = index <= 0;
    elements["next-post"].disabled = index < 0 || index >= renderedResults.length - 1;
  }
  elements["end-previous"].disabled = !previous;
  elements["end-next"].disabled = !next && !currentCollection;
  elements["reader-bottom-previous"].disabled = elements["previous-post"].disabled;
  elements["reader-bottom-next"].disabled = elements["next-post"].disabled;
  elements["end-previous-title"].textContent = previous?.title || (previous ? "이전 글 열기" : "이전 글이 없습니다");
  elements["end-next-title"].textContent = next
    ? next.title || "다음 글 열기"
    : currentCollection ? "작품 목차로 돌아가기" : "다음 글이 없습니다";
}

function collectionAdjacent(offset) {
  if (!currentCollection) return null;
  const entries = currentCollection.collection.entries;
  for (let index = currentCollection.index + offset; entries[index]; index += offset) {
    if (entries[index].object_key) return entries[index];
  }
  return null;
}

function adjacentPost(offset) {
  if (currentCollection) return collectionAdjacent(offset);
  const index = renderedResults.findIndex((post) => samePost(post, currentSummary));
  return renderedResults[index + offset];
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
  const button = event.target.closest(".result-item");
  if (button) {
    if (button.dataset.collectionId) void openCollectionDetail(Number(button.dataset.collectionId));
    else {
      persistCatalogState();
      loadPost(renderedResults[Number(button.dataset.index)]);
    }
  }
});
elements["continue-reading"].addEventListener("click", () => {
  const latest = historyEntries.find((entry) => entry.summary?.object_key && (entry.progress ?? 0) < 0.95)?.summary;
  if (latest) loadPost(latest);
});
elements["browse-all"].addEventListener("click", () => showDestination("search"));
elements["home-action"].addEventListener("click", () => location.reload());
elements["catalog-toggle"].addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("catalog-collapsed");
  elements["catalog-toggle"].setAttribute("aria-expanded", String(!collapsed));
  elements["catalog-toggle"].ariaLabel = collapsed ? "목록 펼치기" : "목록 접기";
});
elements["catalog-back"].addEventListener("click", () => {
  const readerDepth = Number(history.state?.redstmReaderDepth) || 0;
  if (readerDepth > 0) history.go(-readerDepth);
  else {
    const destination = currentDestination;
    const view = currentView;
    const path = destination === "library" ? "/" : destination === "bookmarks" ? savedUrl() : searchUrl();
    history.replaceState(null, "", path);
    showDestination(destination, false, view);
  }
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
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    syncSearchRoute();
    renderCurrentView();
  }, 250);
});
elements["search-input"].addEventListener("focus", () => {
  if (currentDestination === "library") showDestination("search");
});
for (const filter of [elements["board-filter"], elements["mode-filter"], elements["sort-filter"]]) {
  filter.addEventListener("change", () => {
    syncSearchRoute();
    renderCurrentView();
  });
}
for (const button of document.querySelectorAll("[data-scope]")) {
  button.addEventListener("click", () => {
    if (button.dataset.scope === currentScope) return;
    setScope(button.dataset.scope);
    showDestination("search");
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
    if (button.dataset.destination === "search") setScope("posts");
    showDestination(button.dataset.destination);
  });
}
elements["collection-context"].addEventListener("click", () => {
  if (currentCollection) void openCollectionDetail(currentCollection.collection.id);
});
elements["collection-entry-list"].addEventListener("click", async (event) => {
  const button = event.target.closest(".collection-entry");
  if (!button || button.disabled) return;
  const collection = await loadCollectionDetail(Number(elements["collection-entry-list"].dataset.collectionId));
  const entry = collection?.entries[Number(button.dataset.position) - 1];
  if (entry?.object_key) loadPost(entry);
});
elements["collection-back"].addEventListener("click", () => {
  if (history.state?.redstmCollection) history.back();
  else {
    history.replaceState(null, "", "/collections");
    setScope("collections");
    showDestination("search", false);
  }
});
elements["bookmark-post"].addEventListener("click", () => {
  if (!currentSummary) return;
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  bookmarks = active
    ? bookmarks.filter((entry) => !samePost(entry.summary, currentSummary))
    : [{ summary: currentSummary, savedAt: new Date().toISOString() }, ...bookmarks];
  persistUserState();
  updateBookmarkButton();
  if (currentView === "bookmarks") renderCurrentView();
  else if (currentScope === "collections") renderCollectionResults();
  else renderResults(renderedResults, elements["result-status"].textContent);
});
elements["previous-post"].addEventListener("click", () => {
  const post = adjacentPost(-1);
  if (post) loadPost(post);
});
elements["next-post"].addEventListener("click", () => {
  const post = adjacentPost(1);
  if (post) loadPost(post);
});
for (const [id, offset] of [["end-previous", -1], ["end-next", 1]]) {
  elements[id].addEventListener("click", () => {
    const post = adjacentPost(offset);
    if (post) loadPost(post);
    else if (offset > 0 && currentCollection) void openCollectionDetail(currentCollection.collection.id);
  });
}
elements["reader-pane"].addEventListener("scroll", () => {
  queueScrollSave();
  updateReadingProgress();
  const current = elements["reader-pane"].scrollTop;
  const delta = current - lastReaderScroll;
  if (delta && !reducedMotion.matches && isNarrowScreen() && document.body.classList.contains("reader-open")) {
    readerScrollDelta = Math.sign(readerScrollDelta) === Math.sign(delta)
      ? readerScrollDelta + delta
      : delta;
    if (readerScrollDelta >= 50) {
      document.body.classList.add("reader-controls-hidden");
      readerScrollDelta = 0;
    } else if (readerScrollDelta <= -30) {
      document.body.classList.remove("reader-controls-hidden");
      readerScrollDelta = 0;
    }
  }
  lastReaderScroll = current;
}, { passive: true });
elements["reader-pane"].addEventListener("pointerup", (event) => {
  if (document.body.classList.contains("reader-controls-hidden") &&
      !event.target.closest("a, button, input, select, textarea")) {
    document.body.classList.remove("reader-controls-hidden");
  }
});

elements["theme-toggle"].addEventListener("click", () => {
  settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  saveSettings();
});
elements["theme-select"].addEventListener("change", () => {
  settings.theme = elements["theme-select"].value;
  saveSettings();
});
elements["reader-settings"].addEventListener("click", openSettings);
elements["reader-bottom-list"].addEventListener("click", () => elements["catalog-back"].click());
elements["reader-bottom-previous"].addEventListener("click", () => elements["previous-post"].click());
elements["reader-bottom-bookmark"].addEventListener("click", () => elements["bookmark-post"].click());
elements["reader-bottom-next"].addEventListener("click", () => elements["next-post"].click());
elements["reader-bottom-settings"].addEventListener("click", openSettings);
elements["immersive-exit"].addEventListener("click", () => setImmersive(false));
elements["settings-bookmark"].addEventListener("click", () => elements["bookmark-post"].click());
elements["settings-mode"].addEventListener("click", () => elements["mode-toggle"].click());
elements["settings-mode-reset"].addEventListener("click", () => elements["mode-reset"].click());
elements["settings-immersive"].addEventListener("click", () => {
  elements["immersive-toggle"].click();
  if (document.body.classList.contains("immersive") && elements["settings-dialog"].open) {
    immersiveOpener = isNarrowScreen() ? elements["reader-bottom-settings"] : elements["reader-settings"];
    elements["settings-dialog"].close();
  }
});
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
for (const [id, key] of [["prose-size", "proseSize"], ["line-height", "lineHeight"], ["prose-width", "proseWidth"], ["aa-size", "aaSize"]]) {
  elements[id].addEventListener("input", () => {
    settings[key] = Number(elements[id].value);
    saveSettings();
  });
}
elements["prose-font"].addEventListener("change", () => {
  settings.proseFont = elements["prose-font"].value;
  saveSettings();
});
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
  } else if (event.key === "[") {
    elements["previous-post"].click();
  } else if (event.key === "]") {
    elements["next-post"].click();
  } else if (event.key.toLowerCase() === "b") {
    elements["bookmark-post"].click();
  } else if (event.key.toLowerCase() === "f") {
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (currentSummary) persistReadingPosition();
    else persistCatalogState();
  }
});
window.addEventListener("pagehide", () => {
  if (currentSummary) persistReadingPosition();
  else persistCatalogState();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});
window.visualViewport?.addEventListener("resize", () => {
  document.body.classList.toggle("keyboard-open", window.visualViewport.height < innerHeight * 0.75);
});
matchMedia("(max-width: 759px)").addEventListener("change", applySettings);
reducedMotion.addEventListener("change", () => document.body.classList.remove("reader-controls-hidden"));
document.fonts.ready.then(() => {
  if (currentSummary) restoreReadingPosition(currentSummary);
});
applySettings();
