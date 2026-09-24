const controls = [...document.querySelectorAll(".lane")];
const list = document.querySelector("#items");
const reader = document.querySelector("#reader");
const status = document.querySelector("#status");
const search = document.querySelector("#search");
const title = document.querySelector("#section-title");
const label = document.querySelector("#lane-label");
const releaseDate = document.querySelector("#release-date");

let lane = "novel";
let catalog = [];
let activeWork = null;
let firstLoad = true;

function reportError(error) {
  status.textContent = error instanceof Error ? `열지 못했습니다 · ${error.message}` : "열지 못했습니다.";
}

async function json(path) {
  const response = await fetch(path, { credentials: "same-origin", redirect: "error" });
  if (!response.ok) throw new Error(`request_${response.status}`);
  return response.json();
}

function itemButton(text, metadata, onSelect, current = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "item-button";
  button.setAttribute("aria-current", String(current));
  const primary = document.createElement("span");
  primary.className = "item-title";
  primary.textContent = text || "제목 정보 없음";
  const secondary = document.createElement("span");
  secondary.className = "item-meta";
  secondary.textContent = metadata || "";
  button.append(primary, secondary);
  button.addEventListener("click", () => void Promise.resolve().then(onSelect).catch(reportError));
  return button;
}

function paintCatalog() {
  list.replaceChildren();
  const query = search.value.trim().toLocaleLowerCase();
  const shown = catalog.filter((item) =>
    `${item.title ?? item.category ?? ""} ${item.author ?? ""}`.toLocaleLowerCase().includes(query),
  );
  if (!shown.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = catalog.length ? "검색 결과가 없습니다." : "아직 게시된 자료가 없습니다.";
    list.append(empty);
    return;
  }
  for (const item of shown) {
    const row = document.createElement("li");
    const display = item.title ?? item.category ?? item.identity;
    const meta = lane === "novel"
      ? `${item.author || "작가 미상"} · ${item.chapter_count}화`
      : `${item.board} · ${item.post_id} · ${item.content_lane}`;
    row.append(itemButton(display, meta, () => selectItem(item), activeWork?.work_id === item.work_id));
    list.append(row);
  }
}

function showReader(heading, metadata, body) {
  reader.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = heading || "본문";
  const meta = document.createElement("p");
  meta.className = "reader-meta";
  meta.textContent = metadata || "";
  const pre = document.createElement("pre");
  pre.textContent = body;
  reader.append(h, meta, pre);
}

async function selectItem(item) {
  if (lane === "novel") {
    const hash = item.detail_key?.match(/\/([a-f0-9]{64})\.json$/)?.[1];
    if (!hash) throw new Error("work_index_invalid");
    const detail = await json(`/api/v1/index/novel/${hash}.json`);
    activeWork = item;
    title.textContent = item.title || "작품 회차";
    list.replaceChildren();
    const backRow = document.createElement("li");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "back-button";
    back.textContent = "← 작품 목록";
    back.addEventListener("click", () => {
      activeWork = null;
      title.textContent = "작품";
      paintCatalog();
    });
    backRow.append(back);
    list.append(backRow);
    for (const chapter of detail.chapters ?? []) {
      const row = document.createElement("li");
      row.append(itemButton(
        chapter.label || "회차",
        `${chapter.kind} · ${chapter.source_site}`,
        async () => {
          const body = await fetch(`/api/v1/object/${chapter.sha256}`, {
            credentials: "same-origin",
            redirect: "error",
          });
          if (!body.ok) throw new Error(`request_${body.status}`);
          showReader(item.title, chapter.label, await body.text());
        },
      ));
      list.append(row);
    }
    showReader(item.title, `${item.author || "작가 미상"} · ${detail.chapters?.length ?? 0}화`, "회차를 선택하세요.");
    return;
  }
  activeWork = item;
  const response = await fetch(`/api/v1/object/${item.sha256}`, {
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`request_${response.status}`);
  showReader(`${item.category || "아카라이브"} · ${item.post_id}`, `${item.board} · ${item.content_lane}`, await response.text());
  paintCatalog();
}

async function loadLane(nextLane) {
  lane = nextLane;
  activeWork = null;
  catalog = [];
  list.replaceChildren();
  reader.replaceChildren();
  search.value = "";
  status.textContent = "목록을 불러오는 중…";
  label.textContent = nextLane === "novel" ? "NOVEL INDEX" : "ARCALIVE TEXT";
  title.textContent = nextLane === "novel" ? "작품" : "글";
  try {
    let pointer;
    try {
      pointer = await json(`/api/v1/release/${nextLane}`);
    } catch (error) {
      if (firstLoad && lane === "novel" && error instanceof Error && error.message === "request_404") {
        firstLoad = false;
        controls.find((button) => button.dataset.lane === "arcalive")?.click();
        return;
      }
      throw error;
    }
    firstLoad = false;
    if (pointer.schema !== 1 || pointer.lane !== nextLane || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
      throw new Error("release_pointer_invalid");
    }
    const release = await json(`/api/v1/release-manifest/${nextLane}/${pointer.sha256}.json`);
    if (release.schema !== 1 || release.lane !== nextLane || !Array.isArray(release.catalog_pages)) {
      throw new Error("release_manifest_invalid");
    }
    releaseDate.textContent = `${release.generated_at || ""} · ${release.item_count || 0}개`;
    for (const ref of release.catalog_pages) {
      const hash = ref.key?.match(new RegExp(`^published/indexes/${nextLane}/([a-f0-9]{64})\\.json$`))?.[1];
      if (!hash || ref.sha256 !== hash) throw new Error("catalog_reference_invalid");
      const page = await json(`/api/v1/index/${nextLane}/${hash}.json`);
      if (page.schema !== 1 || page.lane !== nextLane || !Array.isArray(page.items)) {
        throw new Error("catalog_page_invalid");
      }
      catalog.push(...page.items);
    }
    status.textContent = `${catalog.length.toLocaleString()}개 자료`;
    paintCatalog();
  } catch (error) {
    status.textContent = error instanceof Error ? `불러오지 못했습니다 · ${error.message}` : "불러오지 못했습니다.";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "게시된 목록을 확인할 수 없습니다.";
    list.append(empty);
  }
}

for (const button of controls) {
  button.addEventListener("click", () => {
    for (const control of controls) {
      const active = control === button;
      control.classList.toggle("is-active", active);
      control.setAttribute("aria-pressed", String(active));
    }
    void loadLane(button.dataset.lane);
  });
}
search.addEventListener("input", paintCatalog);
void loadLane(lane);
