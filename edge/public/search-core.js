export const SEARCH_FIELDS = [
  "board_id",
  "external_post_id",
  "title",
  "author",
  "category",
  "created_at_raw",
  "payload_sha256",
];

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR");
}

export function prepareSearch(payload) {
  if (
    payload?.schema_version !== 1 ||
    JSON.stringify(payload.fields) !== JSON.stringify(SEARCH_FIELDS) ||
    !Array.isArray(payload.posts)
  ) {
    throw new Error("Unsupported search index schema");
  }

  const terms = [];
  const boards = new Set();
  for (const row of payload.posts) {
    if (
      !Array.isArray(row) ||
      row.length !== SEARCH_FIELDS.length ||
      typeof row[0] !== "string" ||
      !Number.isInteger(row[1]) ||
      !/^[0-9a-f]{64}$/.test(row[6])
    ) {
      throw new Error("Invalid search index row");
    }
    boards.add(row[0]);
    terms.push(normalize([row[0], row[2], row[3], row[4]].join(" ")));
  }
  return { rows: payload.posts, terms, boards: [...boards].sort() };
}

function result(row) {
  return {
    ...Object.fromEntries(SEARCH_FIELDS.map((field, index) => [field, row[index]])),
    object_key: `posts/${row[0]}/${row[1]}-${row[6]}.json.gz`,
  };
}

export function searchPosts(index, { query = "", boardId = "", limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Search result limit must be between 1 and 200");
  }
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matches = [];
  for (let position = 0; position < index.rows.length; position += 1) {
    const row = index.rows[position];
    if (boardId && row[0] !== boardId) continue;
    if (tokens.some((token) => !index.terms[position].includes(token))) continue;
    matches.push(result(row));
    if (matches.length === limit) break;
  }
  return matches;
}
