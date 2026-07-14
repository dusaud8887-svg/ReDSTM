import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";

import { prepareSearch, searchPosts } from "../public/search-core.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/benchmark-search.mjs <search-index.json.gz>");

const compressed = await readFile(path);
const before = process.memoryUsage().rss;
const started = performance.now();
const payload = JSON.parse(gunzipSync(compressed));
const index = prepareSearch(payload);
const prepareMs = performance.now() - started;

const titleRow = index.rows.find((row) => /[가-힣]{2}/.test(row[2] ?? ""));
if (!titleRow) throw new Error("No Korean title was found in the sample");
const titleQuery = titleRow[2].match(/[가-힣]{2}/)[0];
const titleResults = searchPosts(index, { query: titleQuery, boardId: titleRow[0], limit: 200 });
const otherBoard = index.boards.find((board) => board !== titleRow[0]);
const wrongBoardResults = searchPosts(index, {
  query: titleQuery,
  boardId: otherBoard,
  limit: 200,
});

const authorRow = index.rows.find((row) => /[가-힣]{2}/.test(row[3] ?? ""));
const authorQuery = authorRow?.[3].match(/[가-힣]{2}/)?.[0];
const authorResults = authorQuery
  ? searchPosts(index, { query: authorQuery, limit: 200 }).posts
  : [];

const timings = [];
for (let run = 0; run < 30; run += 1) {
  const scanStarted = performance.now();
  searchPosts(index, { query: `없는검색어${run}`, limit: 100 });
  timings.push(performance.now() - scanStarted);
}
timings.sort((left, right) => left - right);

console.log(
  JSON.stringify(
    {
      rows: index.rows.length,
      boards: index.boards.length,
      compressed_bytes: compressed.length,
      prepare_ms: Number(prepareMs.toFixed(3)),
      rss_increase_bytes: process.memoryUsage().rss - before,
      title_query_characters: titleQuery.length,
      title_match_found: titleResults.posts.some((post) => post.external_post_id === titleRow[1]),
      wrong_board_excluded: !wrongBoardResults.posts.some(
        (post) => post.board_id === titleRow[0] && post.external_post_id === titleRow[1],
      ),
      author_query_checked: Boolean(authorQuery),
      author_match_found:
        !authorRow || authorResults.some((post) => post.external_post_id === authorRow[1]),
      missing_query_p95_ms: Number(timings[Math.ceil(timings.length * 0.95) - 1].toFixed(3)),
    },
    null,
    2,
  ),
);
