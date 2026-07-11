import { exportUserState, importUserState, samePost } from "/user-state.js";

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
    "end-previous-title", "end-next-title", "mode-toggle", "mode-reset",
  ].map((id) => [id, document.getElementById(id)]),
);

const storedSettings = readJson(storageKeys.settings, defaultSettings);
let settings = {
  ...defaultSettings, ...storedSettings,
  viewModes: { ...defaultSettings.viewModes, ...storedSettings.viewModes },
};
let historyEntries = readJson(storageKeys.history, []);
let bookmarks = readJson(storageKeys.bookmarks, []);
let renderedResults = [];
let currentSummary = null;
let currentPayload = null;
let currentMode = "prose";
let currentCollection = null;
let activeCollectionId = null;
let collectionPromise;
let currentView = "all";
let requestId = 0;
let scrollTimer;
let searchTimer;
let postController;
let pinchDistance = 0;
let zoomFeedbackTimer;
let zoomPersistTimer;

const searchWorker = new Worker("/search-worker.js", { type: "module" });
searchWorker.addEventListener("message", handleWorkerMessage);
searchWorker.postMessage({ type: "init", id: ++requestId });

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function saveSettings() {
  store(storageKeys.settings, settings);
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
  elements["theme-toggle"].textContent = dark ? "☀" : "◐";
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
  if (debounce) zoomPersistTimer = setTimeout(() => store(storageKeys.settings, settings), 250);
  else store(storageKeys.settings, settings);
}

function renderCover(title = "월광 장서", description = "사라질 수 있는 이야기와 AA를 원형에 가깝게 보존한 개인 서고입니다.", showContinue = true) {
  elements.reader.hidden = true;
  elements["empty-reader"].hidden = false;
  elements["empty-reader"].querySelector(":scope > strong").textContent = title;
  elements["empty-reader"].querySelector(".cover-copy").textContent = description;
  const latest = historyEntries[0]?.summary;
  elements["continue-reading"].hidden = !latest || !showContinue;
  if (latest) {
    elements["continue-title"].textContent = latest.title || "제목 없음";
    elements["continue-meta"].textContent = [latest.board_id, latest.author].filter(Boolean).join(" · ");
  }
}

function openMobileReader() {
  document.body.classList.add("reader-open");
}

function closeMobileReader() {
  document.body.classList.remove("reader-open");
  elements["search-input"].focus({ preventScroll: true });
}

function setImmersive(active) {
  document.body.classList.toggle("immersive", active);
  elements["immersive-toggle"].setAttribute("aria-pressed", active);
  elements["immersive-toggle"].textContent = active ? "집중 종료" : "집중";
}

function handleWorkerMessage({ data }) {
  if (data.type === "error") {
    elements["archive-state"].textContent = "연결 오류";
    elements["result-status"].textContent = data.message;
    renderCover("아카이브를 열 수 없음", data.message, false);
    return;
  }
  if (data.type === "ready") {
    elements["archive-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["empty-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["archive-state"].textContent = "보존본";
    for (const board of data.boards) elements["board-filter"].add(new Option(board, board));
    renderCover();
    requestSearch();
    return;
  }
  if (data.type === "results" && data.id === requestId) {
    renderResults(data.posts, `${data.posts.length}건 · ${data.elapsedMs.toFixed(1)}ms`);
    const directKey = decodeURIComponent(location.hash.slice(1));
    if (directKey.startsWith("posts/") && !currentSummary) loadPost({ object_key: directKey }, false);
  }
}

function requestSearch() {
  currentView = "all";
  updateTabs();
  const id = ++requestId;
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
  if (!releaseResponse.ok) throw new Error(`release 응답 ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  const objectKey = release?.collections?.object_key;
  if (release.schema_version !== 1 || typeof objectKey !== "string") {
    throw new Error("지원하지 않는 컬렉션 release 형식");
  }
  const response = await fetch(`/archive/${objectKey}`);
  if (!response.ok) throw new Error(`컬렉션 응답 ${response.status}`);
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
  if (!summary?.object_key) return;
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  if (!currentSummary) renderCover("본문을 불러오는 중", "보존 객체를 확인하고 있습니다.", false);
  try {
    const response = await fetch(`/archive/${summary.object_key}`, { signal: postController.signal });
    if (!response.ok) throw new Error(response.status === 404 ? "보존 객체가 없습니다" : `본문 응답 ${response.status}`);
    const payload = await response.json();
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
    showPost(payload, summary, navigate);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderCover("본문을 열 수 없음", error.message, false);
      elements["archive-state"].textContent = "본문 오류";
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
  const pushReaderState = isNarrowScreen() && navigate && !document.body.classList.contains("reader-open");
  elements["reading-progress"].style.width = "0%";
  elements["empty-reader"].hidden = true;
  elements.reader.hidden = false;
  elements["reader-kicker"].textContent = [post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  elements["reader-meta"].textContent = [post.author || "작성자 없음", post.created_at_raw, `조회 ${post.views ?? 0}`].filter(Boolean).join(" · ");
  elements["source-link"].href = post.canonical_url;
  renderPostBody();
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  void updateCollection();
  renderResults(renderedResults, elements["result-status"].textContent);
  const nextUrl = `#${encodeURIComponent(currentSummary.object_key)}`;
  if (pushReaderState) history.pushState({ redstmReader: true }, "", nextUrl);
  else history.replaceState(history.state, "", nextUrl);
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
  elements["mode-reset"].hidden = !override;
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
  store(storageKeys.history, historyEntries);
}

function isNarrowScreen() {
  return matchMedia("(max-width: 760px)").matches;
}

function readingPosition() {
  return elements["reader-pane"].scrollTop;
}

function restoreReadingPosition(summary) {
  const position = historyEntries.find((entry) => samePost(entry.summary, summary))?.scroll ?? 0;
  elements["reader-pane"].scrollTop = position;
}

function queueScrollSave() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
    if (entry) { entry.scroll = readingPosition(); store(storageKeys.history, historyEntries); }
  }, 250);
}

function updateReadingProgress() {
  const maximum = elements["reader-pane"].scrollHeight - elements["reader-pane"].clientHeight;
  const progress = maximum > 0 ? Math.min(1, elements["reader-pane"].scrollTop / maximum) : 0;
  elements["reading-progress"].style.width = `${progress * 100}%`;
}

function updateBookmarkButton() {
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  elements["bookmark-post"].textContent = active ? "★" : "☆";
  elements["bookmark-post"].setAttribute("aria-pressed", active);
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

elements["result-list"].addEventListener("click", (event) => {
  const button = event.target.closest(".result-item");
  if (button) loadPost(renderedResults[Number(button.dataset.index)]);
});
elements["continue-reading"].addEventListener("click", () => {
  const latest = historyEntries[0]?.summary;
  if (latest) loadPost(latest);
});
elements["catalog-back"].addEventListener("click", () => {
  if (history.state?.redstmReader) history.back();
  else {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    closeMobileReader();
  }
});
window.addEventListener("popstate", () => {
  if (!location.hash) closeMobileReader();
});
elements["search-input"].addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderCurrentView, 250);
});
elements["board-filter"].addEventListener("change", renderCurrentView);
for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => { currentView = tab.dataset.view; updateTabs(); renderCurrentView(); });
}
elements["bookmark-post"].addEventListener("click", () => {
  if (!currentSummary) return;
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  bookmarks = active
    ? bookmarks.filter((entry) => !samePost(entry.summary, currentSummary))
    : [{ summary: currentSummary, savedAt: new Date().toISOString() }, ...bookmarks];
  store(storageKeys.bookmarks, bookmarks);
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
}, { passive: true });

elements["theme-toggle"].addEventListener("click", () => {
  settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  saveSettings();
});
elements["reader-settings"].addEventListener("click", () => elements["settings-dialog"].showModal());
elements["immersive-toggle"].addEventListener("click", () => setImmersive(!document.body.classList.contains("immersive")));
elements["mode-toggle"].addEventListener("click", () => {
  if (!currentPayload) return;
  const identity = `${currentSummary.board_id}:${currentSummary.external_post_id}`;
  settings.viewModes[identity] = currentMode === "aa" ? "prose" : "aa";
  store(storageKeys.settings, settings);
  renderPostBody();
});
elements["mode-reset"].addEventListener("click", () => {
  if (!currentPayload) return;
  delete settings.viewModes[`${currentSummary.board_id}:${currentSummary.external_post_id}`];
  store(storageKeys.settings, settings);
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
  const blob = new Blob([exportUserState(settings, historyEntries, bookmarks)], {
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
    ({ settings, history: historyEntries, bookmarks } = importUserState(
      await file.text(), { history: historyEntries, bookmarks }, defaultSettings,
    ));
    store(storageKeys.settings, settings);
    store(storageKeys.history, historyEntries);
    store(storageKeys.bookmarks, bookmarks);
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
  if (event.target.closest("input, select, textarea, button, [contenteditable]")) return;
  if (event.key === "/") {
    event.preventDefault();
    if (isNarrowScreen()) closeMobileReader();
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

applySettings();
