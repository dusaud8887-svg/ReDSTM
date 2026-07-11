import { exportUserState, importUserState, samePost } from "/user-state.js";

const storageKeys = {
  settings: "redstm.settings.v1",
  history: "redstm.history.v1",
  bookmarks: "redstm.bookmarks.v1",
};
const defaultSettings = { theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, aaSize: 16 };
const elements = Object.fromEntries(
  [
    "archive-count", "archive-state", "search-input", "board-filter", "result-status", "result-list",
    "reader-pane", "empty-reader", "empty-count", "reader", "reader-kicker", "reader-title", "reader-meta",
    "archive-body", "comment-count", "comment-list", "previous-post", "next-post", "bookmark-post", "source-link",
    "theme-toggle", "reader-settings", "settings-dialog", "prose-size", "line-height", "prose-width", "aa-size",
    "prose-size-output", "line-height-output", "prose-width-output", "aa-size-output", "reset-settings",
    "export-state", "import-state", "import-state-file",
  ].map((id) => [id, document.getElementById(id)]),
);

let settings = readJson(storageKeys.settings, defaultSettings);
let historyEntries = readJson(storageKeys.history, []);
let bookmarks = readJson(storageKeys.bookmarks, []);
let searchResults = [];
let renderedResults = [];
let currentSummary = null;
let currentView = "all";
let requestId = 0;
let scrollTimer;
let searchTimer;
let postController;

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
  root.style.setProperty("--aa-size", `${settings.aaSize}px`);
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
}

function handleWorkerMessage({ data }) {
  if (data.type === "error") {
    elements["archive-state"].textContent = "연결 오류";
    elements["result-status"].textContent = data.message;
    return;
  }
  if (data.type === "ready") {
    elements["archive-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["empty-count"].textContent = `${data.count.toLocaleString("ko-KR")}건`;
    elements["archive-state"].textContent = "보존본";
    for (const board of data.boards) elements["board-filter"].add(new Option(board, board));
    requestSearch();
    return;
  }
  if (data.type === "results" && data.id === requestId) {
    searchResults = data.posts;
    renderResults(searchResults, `${data.posts.length}건 · ${data.elapsedMs.toFixed(1)}ms`);
    const directKey = decodeURIComponent(location.hash.slice(1));
    if (directKey.startsWith("posts/") && !currentSummary) loadPost({ object_key: directKey });
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

async function loadPost(summary) {
  if (!summary?.object_key) return;
  postController?.abort();
  postController = new AbortController();
  elements["reader-pane"].setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`/archive/${summary.object_key}`, { signal: postController.signal });
    if (!response.ok) throw new Error(`본문 응답 ${response.status}`);
    const payload = await response.json();
    if (payload.schema_version !== 1 || !payload.post?.body_html) throw new Error("지원하지 않는 본문 형식");
    showPost(payload, summary);
  } catch (error) {
    if (error.name !== "AbortError") {
      elements["empty-reader"].hidden = false;
      elements["empty-reader"].querySelector("strong").textContent = "본문을 열 수 없음";
      elements["empty-reader"].querySelector("span").textContent = error.message;
    }
  } finally {
    elements["reader-pane"].removeAttribute("aria-busy");
  }
}

function showPost(payload, suppliedSummary) {
  const post = payload.post;
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
  elements["empty-reader"].hidden = true;
  elements.reader.hidden = false;
  elements["reader-kicker"].textContent = [post.board_id, post.category].filter(Boolean).join(" · ");
  elements["reader-title"].textContent = post.title || "제목 없음";
  elements["reader-meta"].textContent = [post.author || "작성자 없음", post.created_at_raw, `조회 ${post.views ?? 0}`].filter(Boolean).join(" · ");
  elements["source-link"].href = post.canonical_url;
  elements["archive-body"].classList.toggle("aa", Boolean(post.is_aa));
  elements["archive-body"].innerHTML = post.body_html;
  decorateImages(elements["archive-body"]);
  renderComments(payload.comments);
  rememberHistory(currentSummary);
  updateBookmarkButton();
  updateNavigation();
  renderResults(renderedResults, elements["result-status"].textContent);
  history.replaceState(null, "", `#${encodeURIComponent(currentSummary.object_key)}`);
  requestAnimationFrame(() => restoreReadingPosition(currentSummary));
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

function usesWindowScroll() {
  return matchMedia("(max-width: 760px)").matches;
}

function readingPosition() {
  return usesWindowScroll() ? window.scrollY : elements["reader-pane"].scrollTop;
}

function restoreReadingPosition(summary) {
  const position = historyEntries.find((entry) => samePost(entry.summary, summary))?.scroll ?? 0;
  if (usesWindowScroll()) window.scrollTo(0, position);
  else elements["reader-pane"].scrollTop = position;
}

function queueScrollSave() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const entry = historyEntries.find((item) => samePost(item.summary, currentSummary));
    if (entry) { entry.scroll = readingPosition(); store(storageKeys.history, historyEntries); }
  }, 250);
}

function updateBookmarkButton() {
  const active = bookmarks.some((entry) => samePost(entry.summary, currentSummary));
  elements["bookmark-post"].textContent = active ? "★" : "☆";
  elements["bookmark-post"].setAttribute("aria-pressed", active);
}

function updateNavigation() {
  const index = renderedResults.findIndex((post) => samePost(post, currentSummary));
  elements["previous-post"].disabled = index <= 0;
  elements["next-post"].disabled = index < 0 || index >= renderedResults.length - 1;
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
  const index = renderedResults.findIndex((post) => samePost(post, currentSummary));
  if (index > 0) loadPost(renderedResults[index - 1]);
});
elements["next-post"].addEventListener("click", () => {
  const index = renderedResults.findIndex((post) => samePost(post, currentSummary));
  if (index >= 0 && index < renderedResults.length - 1) loadPost(renderedResults[index + 1]);
});
elements["reader-pane"].addEventListener("scroll", queueScrollSave, { passive: true });
window.addEventListener("scroll", queueScrollSave, { passive: true });

elements["theme-toggle"].addEventListener("click", () => {
  settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  store(storageKeys.settings, settings);
  applySettings();
});
elements["reader-settings"].addEventListener("click", () => elements["settings-dialog"].showModal());
for (const [id, key] of [["prose-size", "proseSize"], ["line-height", "lineHeight"], ["prose-width", "proseWidth"], ["aa-size", "aaSize"]]) {
  elements[id].addEventListener("input", () => {
    settings[key] = Number(elements[id].value);
    store(storageKeys.settings, settings);
    applySettings();
  });
}
elements["reset-settings"].addEventListener("click", () => {
  settings = { ...defaultSettings };
  store(storageKeys.settings, settings);
  applySettings();
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

applySettings();
