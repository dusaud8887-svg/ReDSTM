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

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();
}

export function prepareSearch(payload) {
  const hasIsAa = JSON.stringify(payload?.fields) === JSON.stringify(SEARCH_FIELDS_WITH_AA);
  if (
    payload?.schema_version !== 1 ||
    (!hasIsAa && JSON.stringify(payload.fields) !== JSON.stringify(SEARCH_FIELDS)) ||
    !Array.isArray(payload.posts)
  ) {
    throw new Error("Unsupported search index schema");
  }

  const terms = [];
  const categories = [];
  const modes = [];
  const boards = new Set();
  const identities = new Map();
  for (const row of payload.posts) {
    if (
      !Array.isArray(row) ||
      row.length !== payload.fields.length ||
      typeof row[0] !== "string" ||
      !Number.isInteger(row[1]) ||
      !/^[0-9a-f]{64}$/.test(row[6]) ||
      (hasIsAa && typeof row[7] !== "boolean" && row[7] !== 0 && row[7] !== 1)
    ) {
      throw new Error("Invalid search index row");
    }
    boards.add(row[0]);
    terms.push(normalize([row[0], row[2], row[3], row[4]].join(" ")));
    categories.push(normalize(row[4]));
    modes.push(hasIsAa ? Boolean(row[7]) : null);
    identities.set(`${row[0]}:${row[1]}`, row);
  }
  return {
    rows: payload.posts,
    terms,
    categories,
    modes,
    boards: [...boards].sort(),
    hasIsAa,
    identities,
  };
}

function result(row, hasIsAa) {
  return {
    ...Object.fromEntries(SEARCH_FIELDS.map((field, index) => [field, row[index]])),
    is_aa: hasIsAa ? Boolean(row[7]) : undefined,
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
  if (!new Set(["latest", "oldest"]).has(sort)) {
    throw new Error("Unsupported search sort");
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
  const start = sort === "latest" ? 0 : index.rows.length - 1;
  const end = sort === "latest" ? index.rows.length : -1;
  const step = sort === "latest" ? 1 : -1;
  for (let position = start; position !== end; position += step) {
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
    if (total >= offset && posts.length < limit) posts.push(result(row, index.hasIsAa));
    total += 1;
  }
  return { posts, total };
}

export function findPost(index, boardId, externalPostId) {
  if (typeof boardId !== "string" || !Number.isInteger(externalPostId)) return null;
  const row = index.identities.get(`${boardId}:${externalPostId}`);
  return row ? result(row, index.hasIsAa) : null;
}
