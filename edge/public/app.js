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
const elements = Object.fromEntries(
  [
    "archive-count", "archive-state", "search-input", "board-filter", "result-status", "result-list",
    "reader-pane", "empty-reader", "empty-count", "reader", "reader-kicker", "reader-title", "reader-meta", "collection-context",
    "archive-body", "comment-count", "comment-list", "previous-post", "next-post", "bookmark-post", "source-link",
    "theme-toggle", "reader-settings", "settings-dialog", "prose-size", "line-height", "prose-width", "aa-size",
    "prose-size-output", "line-height-output", "prose-width-output", "aa-size-output", "reset-settings",
    "export-state", "import-state", "import-state-file", "continue-reading", "continue-title",
    "continue-meta", "catalog-back", "prose-font", "aa-controls", "aa-inline-size",
    "aa-source-styles", "aa-background", "aa-zoom-output", "aa-zoom-reset", "aa-zoom-indicator",
    "reading-progress", "immersive-toggle", "end-previous", "end-next",
    "end-previous-title", "end-next-title", "mode-toggle", "mode-reset", "theme-select",
    "home-title", "home-freshness", "latest-list", "recent-list", "browse-all",
    "reader-bottom-list", "reader-bottom-previous", "reader-bottom-next", "reader-bottom-settings",
    "post-settings-actions", "settings-bookmark", "settings-source", "settings-mode", "settings-mode-reset", "settings-immersive",
    "catalog-toggle", "home-action",
  ].map((id) => [id, document.getElementById(id)]),
);

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
let collectionPromise;
let currentView = "all";
let currentDestination = "library";
let messageId = 0;
let searchRequestId = 0;
let scrollTimer;
let searchTimer;
let postController;
let pinchDistance = 0;
let zoomFeedbackTimer;
let zoomPersistTimer;
let lastReaderScroll = 0;
let latestPosts = [];
let publishedAt = null;
const workerRequests = new Map();

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
        ...(timestampKey === "readAt" ? { scroll: userState.scroll[identity] ?? 0 } : {}),
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
      postIdentity(entry.summary), { readAt: entry.readAt },
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
  localStorage.setItem(STATE_KEY, exportUserState(userState));
  for (const key of Object.values(storageKeys)) localStorage.removeItem(key);
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
  elements["theme-toggle"].ariaLabel = dark ? "밝은 테마로 전환" : "어두운 테마로 전환";
  elements["theme-toggle"].title = elements["theme-toggle"].ariaLabel;
  elements["theme-select"].value = settings.theme;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0b0d12" : "#f5f6f8";
  for (const [id, value, suffix] of [
    ["prose-size", settings.proseSize, "px"],
    ["line-height", settings.lineHeight, ""],
    ["prose-width", settings.proseWidth, "px"],
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
  elements["archive-body"].classList.toggle("normalize-source-styles", !settings.aaPreserveStyles);
  const canvas = elements["archive-body"].querySelector(".aa-canvas");
  if (canvas) canvas.dataset.width = settings.aaCanvasWidth ?? "auto";
  for (const button of document.querySelectorAll("[data-aa-preset]")) {
    const [size, width] = button.dataset.aaPreset.split(":");
    button.classList.toggle("active", settings.aaSize === Number(size) &&
      settings.aaCanvasWidth === (width === "auto" ? null : Number(width)) && settings.aaZoom === 1);
  }
  for (const button of document.querySelectorAll("[data-aa-background]")) {
    button.classList.toggle("active", button.dataset.aaBackground === settings.aaBackground);
  }
}

function showZoomFeedback() {
  clearTimeout(zoomFeedbackTimer);
  elements["aa-zoom-indicator"].textContent = `${Math.round(settings.aaZoom * 100)}%`;
  elements["aa-zoom-indicator"].hidden = false;
  zoomFeedbackTimer = setTimeout(() => { elements["aa-zoom-indicator"].hidden = true; }, 1200);
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
  title = "다시 읽고 싶은 기록을 한곳에서 찾으세요.",
  description = "사라질 수 있는 이야기와 AA를 원형에 가깝게 보존합니다.",
  showContinue = true,
  actionLabel = "",
) {
  elements.reader.hidden = true;
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
  const latest = historyEntries[0]?.summary;
  elements["continue-reading"].hidden = !latest || !showContinue;
  if (latest) {
    elements["continue-title"].textContent = latest.title || "제목 없음";
    elements["continue-meta"].textContent = [latest.board_id, latest.author].filter(Boolean).join(" · ");
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

function renderArchiveError(error, fallbackTitle = "아카이브를 열 수 없음") {
  const offline = error?.code === "offline" || !navigator.onLine;
  const expired = error?.code === "access_expired";
  const title = offline ? "오프라인입니다" : expired ? "로그인이 만료되었습니다" : fallbackTitle;
  const message = offline
    ? "네트워크 연결을 확인한 뒤 다시 시도하세요."
    : expired ? "보호된 장서를 계속 보려면 다시 로그인하세요." : error?.message ?? "알 수 없는 오류";
  elements["archive-state"].textContent = offline ? "오프라인" : expired ? "로그인 필요" : "연결 오류";
  elements["result-status"].textContent = message;
  renderCover(title, message, false, expired ? "다시 로그인" : "다시 시도");
}

function openMobileReader() {
  document.body.classList.remove("home-open");
  document.body.classList.add("reader-open");
}

function closeMobileReader(focusSearch = currentDestination !== "library") {
  document.body.classList.remove("reader-open");
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

function showDestination(destination, navigate = true) {
  if (destination === "settings") {
    elements["settings-dialog"].showModal();
    return;
  }
  currentDestination = destination;
  currentSummary = null;
  currentPayload = null;
  document.body.classList.remove("catalog-collapsed", "reader-controls-hidden");
  elements["catalog-toggle"].setAttribute("aria-expanded", "true");
  elements["post-settings-actions"].hidden = true;
  renderCover();
  closeMobileReader(destination === "search");
  if (destination === "bookmarks") {
    currentView = "bookmarks";
    updateTabs();
    renderCurrentView();
  } else {
    currentView = "all";
    updateTabs();
    requestSearch();
  }
  updateDestinationButtons();
  const path = destination === "library" ? "/" : destination === "bookmarks" ? "/saved" : "/search";
  if (navigate && location.pathname !== path) history.pushState(null, "", path);
}

function setImmersive(active) {
  document.body.classList.toggle("immersive", active);
  elements["immersive-toggle"].setAttribute("aria-pressed", active);
  elements["immersive-toggle"].textContent = active ? "집중 종료" : "집중";
  elements["settings-immersive"].textContent = active ? "집중 종료" : "집중";
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

async function handleRoute() {
  const summary = routeSummary();
  if (!summary) {
    const destination = location.pathname === "/saved" ? "bookmarks" : location.pathname === "/search" ? "search" : "library";
    showDestination(destination, false);
    if (location.pathname === "/settings") elements["settings-dialog"].showModal();
    return;
  }
  if (!samePost(summary, currentSummary)) await loadPost(summary, false);
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
    elements["archive-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["empty-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["archive-state"].textContent = "보존본";
    latestPosts = data.recentPosts;
    publishedAt = data.publishedAt;
    for (const board of data.boardMetadata) {
      const label = board.name === board.board_id ? board.name : `${board.name} · ${board.board_id}`;
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
  if (data.type === "results" && data.id === searchRequestId && currentView === "all") {
    renderResults(data.posts, `${data.total.toLocaleString("ko-KR")}건 · ${data.elapsedMs.toFixed(1)}ms`);
  }
}

function requestSearch() {
  currentView = "all";
  updateTabs();
  const id = ++messageId;
  searchRequestId = id;
  searchWorker.postMessage({
    type: "search",
    id,
    query: elements["search-input"].value,
    boardId: elements["board-filter"].value,
    limit: 100,
  });
}

function localResults(entries) {
  const query = normalized(elements["search-input"].value).trim();
  const board = elements["board-filter"].value;
  return entries
    .map((entry) => entry.summary)
    .filter((post) => !board || post.board_id === board)
    .filter((post) => !query || normalized([post.title, post.author, post.category, post.board_id].join(" ")).includes(query));
}

function renderCurrentView() {
  if (currentView === "all") return requestSearch();
  const entries = currentView === "history" ? historyEntries : bookmarks;
  const posts = localResults(entries);
  renderResults(posts, `${posts.length}건 · 이 브라우저`);
}

function renderResults(posts, status) {
  renderedResults = posts;
  elements["result-status"].textContent = status;
  elements["result-list"].replaceChildren();
  const fragment = document.createDocumentFragment();
  posts.forEach((post, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.dataset.index = index;
    button.classList.toggle("active", samePost(post, currentSummary));
    const title = document.createElement("strong");
    title.className = "result-title";
    title.textContent = post.title || "제목 없음";
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
    button.append(title, meta);
    item.append(button);
    fragment.append(item);
  });
  elements["result-list"].append(fragment);
}

async function loadCollections() {
  const releaseResponse = await fetch("/archive/release.json");
  requireArchiveResponse(releaseResponse, `release 응답 ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  const objectKey = release?.collections?.object_key;
  if (release.schema_version !== 1 || typeof objectKey !== "string") {
    throw new Error("지원하지 않는 컬렉션 release 형식");
  }
  const response = await fetch(`/archive/${objectKey}`);
  requireArchiveResponse(response, `컬렉션 응답 ${response.status}`);
  const payload = await response.json();
  if (payload?.schema_version !== 1 || !Array.isArray(payload.collections)) {
    throw new Error("지원하지 않는 컬렉션 형식");
  }
  for (const collection of payload.collections) {
    if (!Number.isInteger(collection.id) || typeof collection.title !== "string" ||
        !Array.isArray(collection.entries)) throw new Error("잘못된 컬렉션");
    collection.entries.forEach((entry, index) => {
      const match = postObjectKeyPattern.exec(entry?.object_key ?? "");
      const invalidObject = entry?.object_key !== null &&
        (!match || match[1] !== entry.board_id || Number(match[2]) !== entry.external_post_id);
      if (entry?.position !== index + 1 || invalidObject) throw new Error("잘못된 컬렉션 글");
    });
  }
  return payload.collections;
}

function collections() {
  collectionPromise ??= loadCollections().catch((error) => {
    collectionPromise = undefined;
    throw error;
  });
  return collectionPromise;
}

function findCollection(collectionList, summary) {
  const candidates = activeCollectionId === null
    ? collectionList
    : [...collectionList.filter((item) => item.id === activeCollectionId),
      ...collectionList.filter((item) => item.id !== activeCollectionId)];
  for (const collection of candidates) {
    const index = collection.entries.findIndex((entry) => samePost(entry, summary));
    if (index >= 0) return { collection, index };
  }
  return null;
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
    const membership = findCollection(await collections(), summary);
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
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  if (!currentSummary) renderCover("본문을 불러오는 중", "보존 객체를 확인하고 있습니다.", false);
  try {
    const resolved = summary?.object_key ? summary : (await resolvePosts([summary]))[0];
    if (!resolved?.object_key) throw new Error("현재 보존본에서 글을 찾을 수 없습니다");
    const response = await fetch(`/archive/${resolved.object_key}`, { signal: postController.signal });
    requireArchiveResponse(response, response.status === 404 ? "보존 객체가 없습니다" : `본문 응답 ${response.status}`);
    const payload = await response.json();
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
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
  document.body.classList.remove("reader-controls-hidden");
  const collapseCatalog = matchMedia("(min-width: 760px) and (max-width: 899px)").matches;
  document.body.classList.toggle("catalog-collapsed", collapseCatalog);
  elements["catalog-toggle"].setAttribute("aria-expanded", String(!collapseCatalog));
  elements["empty-reader"].hidden = true;
  elements.reader.hidden = false;
  elements["reader-kicker"].textContent = [post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  elements["reader-meta"].textContent = [post.author || "작성자 없음", post.created_at_raw, `조회 ${post.views ?? 0}`].filter(Boolean).join(" · ");
  elements["source-link"].href = post.canonical_url;
  elements["settings-source"].href = post.canonical_url;
  elements["post-settings-actions"].hidden = false;
  renderPostBody();
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  void updateCollection();
  renderResults(renderedResults, elements["result-status"].textContent);
  const nextUrl = `/read/${currentSummary.board_id}/${currentSummary.external_post_id}`;
  if (navigate) history.pushState({ redstmReader: true }, "", nextUrl);
  else history.replaceState({ redstmReader: false }, "", nextUrl);
  openMobileReader();
  requestAnimationFrame(() => restoreReadingPosition(currentSummary));
}

function renderPostBody() {
  const post = currentPayload.post;
  const identity = `${post.board_id}:${post.external_post_id}`;
  const override = settings.viewModes[identity];
  currentMode = override ?? (post.is_aa ? "aa" : "prose");
  const isAa = currentMode === "aa";
  elements["archive-body"].classList.toggle("aa", isAa);
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
  applySettings();
  decorateImages(elements["archive-body"]);
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
    body.classList.toggle("aa-comment", /AA_Text|saitamaar/i.test(comment.content_html));
    header.append(author, date);
    item.append(header, body);
    fragment.append(item);
  }
  elements["comment-list"].append(fragment);
}

function rememberHistory(summary) {
  const previous = historyEntries.find((entry) => samePost(entry.summary, summary));
  historyEntries = historyEntries.filter((entry) => !samePost(entry.summary, summary));
  historyEntries.unshift({ summary, readAt: new Date().toISOString(), scroll: previous?.scroll ?? 0 });
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
  elements["reader-pane"].scrollTop = position;
}

function queueScrollSave() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
    if (entry) { entry.scroll = readingPosition(); persistUserState(); }
  }, 250);
}

function updateReadingProgress() {
  const maximum = elements["reader-pane"].scrollHeight - elements["reader-pane"].clientHeight;
  const progress = maximum > 0 ? Math.min(1, elements["reader-pane"].scrollTop / maximum) : 0;
  elements["reading-progress"].style.width = `${progress * 100}%`;
}

function updateBookmarkButton() {
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  elements["bookmark-post"].setAttribute("aria-pressed", active);
  elements["settings-bookmark"].setAttribute("aria-pressed", active);
  elements["settings-bookmark"].textContent = active ? "저장 취소" : "저장";
  elements["bookmark-post"].ariaLabel = active ? "저장 취소" : "저장";
  elements["bookmark-post"].title = elements["bookmark-post"].ariaLabel;
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
  elements["end-next"].disabled = !next;
  elements["reader-bottom-previous"].disabled = elements["previous-post"].disabled;
  elements["reader-bottom-next"].disabled = elements["next-post"].disabled;
  elements["end-previous-title"].textContent = previous?.title || (previous ? "이전 글 열기" : "이전 글이 없습니다");
  elements["end-next-title"].textContent = next?.title || (next ? "다음 글 열기" : "다음 글이 없습니다");
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
  if (button) loadPost(renderedResults[Number(button.dataset.index)]);
});
elements["continue-reading"].addEventListener("click", () => {
  const latest = historyEntries[0]?.summary;
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
  if (history.state?.redstmReader) history.back();
  else {
    history.replaceState(null, "", "/");
    showDestination("library", false);
  }
});
window.addEventListener("popstate", () => { void handleRoute(); });
elements["search-input"].addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderCurrentView, 250);
});
elements["board-filter"].addEventListener("change", renderCurrentView);
for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => {
    currentView = tab.dataset.view;
    currentDestination = currentView === "bookmarks" ? "bookmarks" : "search";
    document.body.classList.remove("home-open");
    updateDestinationButtons();
    updateTabs();
    renderCurrentView();
  });
}
for (const button of document.querySelectorAll("[data-destination]")) {
  button.addEventListener("click", () => showDestination(button.dataset.destination));
}
elements["bookmark-post"].addEventListener("click", () => {
  if (!currentSummary) return;
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  bookmarks = active
    ? bookmarks.filter((entry) => !samePost(entry.summary, currentSummary))
    : [{ summary: currentSummary, savedAt: new Date().toISOString() }, ...bookmarks];
  persistUserState();
  updateBookmarkButton();
  if (currentView === "bookmarks") renderCurrentView();
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
  });
}
elements["reader-pane"].addEventListener("scroll", () => {
  queueScrollSave();
  updateReadingProgress();
  const current = elements["reader-pane"].scrollTop;
  const delta = current - lastReaderScroll;
  if (isNarrowScreen() && document.body.classList.contains("reader-open")) {
    if (current > 120 && delta > 8) document.body.classList.add("reader-controls-hidden");
    else if (delta < -8) document.body.classList.remove("reader-controls-hidden");
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
elements["reader-settings"].addEventListener("click", () => elements["settings-dialog"].showModal());
elements["reader-bottom-list"].addEventListener("click", () => elements["catalog-back"].click());
elements["reader-bottom-previous"].addEventListener("click", () => elements["previous-post"].click());
elements["reader-bottom-next"].addEventListener("click", () => elements["next-post"].click());
elements["reader-bottom-settings"].addEventListener("click", () => elements["settings-dialog"].showModal());
elements["settings-bookmark"].addEventListener("click", () => elements["bookmark-post"].click());
elements["settings-mode"].addEventListener("click", () => elements["mode-toggle"].click());
elements["settings-mode-reset"].addEventListener("click", () => elements["mode-reset"].click());
elements["settings-immersive"].addEventListener("click", () => elements["immersive-toggle"].click());
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
elements["import-state"].addEventListener("click", () => elements["import-state-file"].click());
elements["import-state-file"].addEventListener("change", async () => {
  const [file] = elements["import-state-file"].files;
  if (!file) return;
  try {
    if (file.size > 1_048_576) throw new Error("상태 파일은 1MB 이하여야 합니다");
    const planned = planImport(await file.text(), defaultSettings);
    const summary = planned.summary;
    const approved = confirm(
      `읽기 기록 ${summary.history}건, 북마크 ${summary.bookmarks}건, 위치 ${summary.scroll}건, 보기 설정 ${summary.viewModes}건을 가져올까요?`,
    );
    if (!approved) return;
    applyUserState(planned.state);
    persistUserState();
    await hydrateSavedEntries();
    applySettings();
    renderCurrentView();
    elements["result-status"].textContent = "사용자 상태를 가져왔습니다";
  } catch (error) {
    elements["result-status"].textContent = error.message;
  } finally {
    elements["import-state-file"].value = "";
  }
});

document.addEventListener("keydown", (event) => {
  const catalogArrow = event.target === elements["search-input"] || event.target.closest(".result-item");
  if (catalogArrow && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    focusResult(event.key === "ArrowDown" ? 1 : -1);
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
  } else if (event.key === "Escape" && document.body.classList.contains("immersive")) {
    setImmersive(false);
  }
});
document.addEventListener("focusin", () => document.body.classList.remove("reader-controls-hidden"));

history.scrollRestoration = "manual";
window.addEventListener("offline", () => renderArchiveError({ code: "offline" }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistUserState();
});
window.addEventListener("pagehide", persistUserState);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});
window.visualViewport?.addEventListener("resize", () => {
  document.body.classList.toggle("keyboard-open", window.visualViewport.height < innerHeight * 0.75);
});
document.fonts.ready.then(() => {
  if (currentSummary) restoreReadingPosition(currentSummary);
});
applySettings();
