export const SEARCH_FIELDS = [
  "board_id",
  "external_post_id",
  "title",
  "author",
  "category",
  "created_at_raw",
  "payload_sha256",
];
const SEARCH_FIELDS_WITH_AA = [...SEARCH_FIELDS, "is_aa"];
// Newer releases append popularity signals; 7- and 8-field indexes remain valid.
const SEARCH_FIELDS_WITH_STATS = [...SEARCH_FIELDS_WITH_AA, "views", "comment_count"];
export const SEARCH_SORTS = ["latest", "oldest", "views", "comments"];

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();
}

export function prepareSearch(payload) {
  const fields = JSON.stringify(payload?.fields);
  const hasStats = fields === JSON.stringify(SEARCH_FIELDS_WITH_STATS);
  const hasIsAa = hasStats || fields === JSON.stringify(SEARCH_FIELDS_WITH_AA);
  if (
    payload?.schema_version !== 1 ||
    (!hasIsAa && fields !== JSON.stringify(SEARCH_FIELDS)) ||
    !Array.isArray(payload.posts)
  ) {
    throw new Error("Unsupported search index schema");
  }

  const terms = [];
  const categories = [];
  const modes = [];
  const boards = new Set();
  const identities = new Map();
  const boardAaSeen = new Map();
  for (const row of payload.posts) {
    if (
      !Array.isArray(row) ||
      row.length !== payload.fields.length ||
      typeof row[0] !== "string" ||
      !Number.isInteger(row[1]) ||
      !/^[0-9a-f]{64}$/.test(row[6]) ||
      (hasIsAa && typeof row[7] !== "boolean" && row[7] !== 0 && row[7] !== 1) ||
      (hasStats && (!isCount(row[8]) || !isCount(row[9])))
    ) {
      throw new Error("Invalid search index row");
    }
    boards.add(row[0]);
    terms.push(normalize([row[0], row[2], row[3], row[4]].join(" ")));
    categories.push(normalize(row[4]));
    const isAa = hasIsAa ? Boolean(row[7]) : null;
    modes.push(isAa);
    identities.set(`${row[0]}:${row[1]}`, row);
    if (hasIsAa) {
      const seen = boardAaSeen.get(row[0]) ?? { aa: false, prose: false };
      if (isAa) seen.aa = true;
      else seen.prose = true;
      boardAaSeen.set(row[0], seen);
    }
  }
  const boardAa = new Map();
  for (const [boardId, seen] of boardAaSeen) {
    boardAa.set(boardId, seen.aa === seen.prose ? null : seen.aa);
  }
  return {
    rows: payload.posts,
    terms,
    categories,
    modes,
    boards: [...boards].sort(),
    boardAa,
    hasIsAa,
    hasStats,
    identities,
    popularity: new Map(),
  };
}

// Row positions ordered by a popularity column (most first; the newer post wins a tie). Built
// once per column, then filtered in order like the date sorts, so typing stays cheap.
function popularityOrder(index, sort) {
  let order = index.popularity.get(sort);
  if (!order) {
    const column = sort === "views" ? 8 : 9;
    order = Uint32Array.from(index.rows.keys());
    order.sort((left, right) => index.rows[right][column] - index.rows[left][column] || left - right);
    index.popularity.set(sort, order);
  }
  return order;
}

function result(row, index) {
  return {
    ...Object.fromEntries(SEARCH_FIELDS.map((field, position) => [field, row[position]])),
    is_aa: index.hasIsAa ? Boolean(row[7]) : undefined,
    ...(index.hasStats ? { views: row[8], comment_count: row[9] } : {}),
    object_key: `posts/${row[0]}/${row[1]}-${row[6]}.json.zst`,
  };
}

export function searchPosts(
  index,
  {
    query = "",
    boardId = "",
    category = "",
    mode = "all",
    sort = "latest",
    target = "all",
    match = "and",
    limit = 100,
    offset = 0,
    collect = null,
  } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Search result limit must be between 1 and 200");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Search result offset must be a non-negative safe integer");
  }
  if (!new Set(["all", "aa", "prose"]).has(mode)) {
    throw new Error("Unsupported search mode");
  }
  if (mode !== "all" && !index.hasIsAa) {
    throw new Error("Search mode is unavailable for this release");
  }
  if (!SEARCH_SORTS.includes(sort)) {
    throw new Error("Unsupported search sort");
  }
  if ((sort === "views" || sort === "comments") && !index.hasStats) {
    throw new Error("Popularity sort is unavailable for this release");
  }
  if (!new Set(["all", "title", "author"]).has(target)) {
    throw new Error("Unsupported search target");
  }
  if (!new Set(["and", "or"]).has(match)) {
    throw new Error("Unsupported search match");
  }
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  const normalizedCategory = normalize(category);
  const posts = [];
  let total = 0;
  // Rows are stored newest first; popularity sorts walk a prebuilt order instead.
  const order = sort === "views" || sort === "comments" ? popularityOrder(index, sort) : null;
  const count = index.rows.length;
  for (let step = 0; step < count; step += 1) {
    const position = order ? order[step] : sort === "latest" ? step : count - 1 - step;
    const row = index.rows[position];
    if (boardId && row[0] !== boardId) continue;
    if (normalizedCategory && index.categories[position] !== normalizedCategory) continue;
    const isAa = index.modes[position];
    if ((mode === "aa" && !isAa) || (mode === "prose" && isAa)) continue;
    const searchText = target === "title" ? normalize(row[2]) : target === "author" ? normalize(row[3]) : index.terms[position];
    const tokenMatches = match === "or"
      ? tokens.some((token) => searchText.includes(token))
      : tokens.every((token) => searchText.includes(token));
    if (tokens.length && !tokenMatches) continue;
    // `total` is the running match index; collect the window [offset, offset + limit).
    if (collect) collect.push(row);
    else if (total >= offset && posts.length < limit) posts.push(result(row, index));
    total += 1;
  }
  return { posts, total };
}

// One page of a result list plus the neighbours of a given post, so the Reader can show "the
// list you came from" around the current post and step through it in the same order.
// around: "board:id" to open the page containing that post; page: explicit 0-based page.
// The board's own 분류 (TypeMoon's category tabs: 장편·단편·칼럼, or per-work tags on AA boards),
// most used first. Spellings that normalise alike ("Ori", "ori") count as one, under the most
// used spelling. Posts without a category are left out.
export function boardCategories(index, { boardId, mode = "all" } = {}) {
  if (!boardId) return [];
  const found = new Map();
  for (let position = 0; position < index.rows.length; position += 1) {
    const row = index.rows[position];
    const key = index.categories[position];
    if (row[0] !== boardId || !key.trim()) continue;
    const isAa = index.modes[position];
    if ((mode === "aa" && !isAa) || (mode === "prose" && isAa)) continue;
    const entry = found.get(key) ?? { key, count: 0, spellings: new Map() };
    entry.count += 1;
    entry.spellings.set(row[4], (entry.spellings.get(row[4]) ?? 0) + 1);
    found.set(key, entry);
  }
  return [...found.values()]
    .map(({ key, count, spellings }) => ({
      label: [...spellings].sort((left, right) => right[1] - left[1])[0][0], key, count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "ko"));
}

export function searchPage(index, { around = "", page = null, pageSize = 10, ...filters } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("Search page size must be between 1 and 50");
  }
  const matches = [];
  searchPosts(index, { ...filters, limit: 1, offset: 0, collect: matches });
  const aroundRow = around ? index.identities.get(around) : null;
  const found = aroundRow ? matches.indexOf(aroundRow) : -1;
  const lastPage = Math.max(0, Math.ceil(matches.length / pageSize) - 1);
  const pageIndex = Number.isInteger(page) ? Math.min(Math.max(0, page), lastPage)
    : found >= 0 ? Math.floor(found / pageSize) : 0;
  const offset = pageIndex * pageSize;
  const summary = (row) => (row ? result(row, index) : null);
  return {
    posts: matches.slice(offset, offset + pageSize).map((row) => result(row, index)),
    total: matches.length,
    offset,
    found,
    previous: found > 0 ? summary(matches[found - 1]) : null,
    next: found >= 0 ? summary(matches[found + 1]) : null,
  };
}

const SOURCE_DATE = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/;
const HOT_WINDOW = 2000;

// Home discovery lists, cheap enough to compute on every Home visit.
// onThisDay: posts written on today's month/day in earlier years (most discussed first when the
//   release has counts, otherwise the most recent year first).
// hot: the most discussed of the newest HOT_WINDOW posts; empty without counts.
export function discoverPosts(index, { year, month, day, limit = 6 } = {}) {
  const onThisDay = [];
  for (let position = 0; position < index.rows.length; position += 1) {
    const date = SOURCE_DATE.exec(String(index.rows[position][5] ?? ""));
    if (!date || Number(date[2]) !== month || Number(date[3]) !== day || Number(date[1]) >= year) continue;
    onThisDay.push(position);
  }
  const byDiscussion = (left, right) =>
    index.rows[right][9] - index.rows[left][9] || index.rows[right][8] - index.rows[left][8] || left - right;
  if (index.hasStats) onThisDay.sort(byDiscussion);
  const hot = index.hasStats
    ? [...index.rows.keys()].slice(0, HOT_WINDOW).filter((position) => index.rows[position][9] > 0)
      .sort(byDiscussion).slice(0, limit)
    : [];
  return {
    onThisDay: onThisDay.slice(0, limit).map((position) => result(index.rows[position], index)),
    onThisDayTotal: onThisDay.length,
    hot: hot.map((position) => result(index.rows[position], index)),
  };
}

export function findPost(index, boardId, externalPostId) {
  if (typeof boardId !== "string" || !Number.isInteger(externalPostId)) return null;
  const row = index.identities.get(`${boardId}:${externalPostId}`);
  return row ? result(row, index) : null;
}
