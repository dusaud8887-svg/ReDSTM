import { prepareSearch, searchPosts } from "./search-core.js";

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
  return prepareSearch(await searchResponse.json());
}

self.addEventListener("message", async ({ data }) => {
  const id = data?.id;
  try {
    indexPromise ??= loadIndex();
    const index = await indexPromise;
    if (data?.type === "init") {
      self.postMessage({ type: "ready", id, boards: index.boards, count: index.rows.length });
      return;
    }
    if (data?.type === "search") {
      const started = performance.now();
      const posts = searchPosts(index, data);
      self.postMessage({
        type: "results",
        id,
        posts,
        elapsedMs: performance.now() - started,
      });
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
