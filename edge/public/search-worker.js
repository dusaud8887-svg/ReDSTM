import { findPost, prepareSearch, searchPosts } from "./search-core.js";

let indexPromise;

async function loadIndex() {
  const releaseResponse = await fetch("/archive/release.json");
  if (!releaseResponse.ok) throw new Error("Release manifest could not be loaded");
  const release = await releaseResponse.json();
  if (release.schema_version !== 1 || !release.search?.object_key) {
    throw new Error("Release manifest has no supported search index");
  }

  const searchResponse = await fetch(`/archive/${release.search.object_key}`);
  if (!searchResponse.ok) throw new Error("Search index could not be loaded");
  const index = prepareSearch(await searchResponse.json());
  const lastModified = releaseResponse.headers.get("Last-Modified");
  const publishedAt = lastModified && !Number.isNaN(Date.parse(lastModified))
    ? new Date(lastModified).toISOString()
    : null;
  const releaseBoards = new Map(
    (Array.isArray(release.boards) ? release.boards : []).map((board) => [board.board_id, board]),
  );
  const boardMetadata = index.boards.map((boardId) => {
    const board = releaseBoards.get(boardId) ?? {};
    return {
      board_id: boardId,
      name: typeof board.name === "string" ? board.name : boardId,
      group_name: typeof board.group_name === "string" ? board.group_name : "",
      post_count: Number.isInteger(board.post_count) ? board.post_count : null,
    };
  });
  return { index, publishedAt, boardMetadata };
}

self.addEventListener("message", async ({ data }) => {
  const id = data?.id;
  try {
    indexPromise ??= loadIndex();
    const { index, publishedAt, boardMetadata } = await indexPromise;
    if (data?.type === "init") {
      self.postMessage({
        type: "ready",
        id,
        boards: index.boards,
        boardMetadata,
        count: index.rows.length,
        hasIsAa: index.hasIsAa,
        recentPosts: searchPosts(index, { limit: 6 }).posts,
        publishedAt,
      });
      return;
    }
    if (data?.type === "search") {
      const started = performance.now();
      const { posts, total } = searchPosts(index, data);
      self.postMessage({
        type: "results",
        id,
        posts,
        total,
        elapsedMs: performance.now() - started,
      });
      return;
    }
    if (data?.type === "resolve") {
      if (!Array.isArray(data.identities) || data.identities.length > 500) {
        throw new Error("Resolve identities must be an array of at most 500 items");
      }
      const summaries = data.identities.map((identity) => {
        const match = /^([a-z0-9_]+):([1-9]\d*)$/.exec(identity);
        if (!match) throw new Error("Invalid stable post identity");
        return findPost(index, match[1], Number(match[2]));
      });
      self.postMessage({ type: "resolved", id, summaries });
      return;
    }
    throw new Error("Unsupported search worker message");
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : "Search worker failed",
    });
  }
});
