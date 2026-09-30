// A small published text archive (novel + Arcalive lanes) served through page.route, shared by
// the text library specs. Content hashes are derived from ids so every object is addressable.

const hex = (seed, fill) => seed.toString(16).padStart(64, fill);

export function novelWork({ id, title, author = "작가", chapters = 5, site = "toki", updated = "2026-09-01T00:00:00Z", latest = null }) {
  const workId = `novel:${site}:${id}`;
  return {
    item: {
      work_id: workId, source_site: site, source_work_id: String(id), title, author, chapter_count: chapters,
      latest_label: latest ?? `${chapters}화`, last_imported_at: updated,
      detail_key: `published/indexes/novel/${hex(id, "d")}.json`,
    },
    detail: {
      schema: 1, lane: "novel", work: { work_id: workId, title, author },
      chapters: Array.from({ length: chapters }, (_, index) => ({
        chapter_id: `${id}-${index + 1}`, label: `${index + 1}화`, kind: "main", reading_order: index,
        source_site: site, source_chapter_id: String(index + 1), source_url: `https://novel.example/${id}/${index + 1}`,
        sha256: hex(id * 10_000 + index + 1, "a"),
      })),
    },
  };
}

export function arcalivePost({ board = "novel", category = "소설", id, title, author = "작성자" }) {
  return {
    identity: `arcalive:${board}:${id}:text`, board, category, post_id: id, title, author,
    content_lane: "text", sha256: hex(id, "b"), bytes: 1200,
  };
}

export function arcaliveWork({ key, title, author = "작성자", board = "novel", category = "소설", posts }) {
  return {
    item: {
      work_id: `arcalive:${key}`, title, author, board, category, chapter_count: posts.length,
      post_ids: posts.map((post) => post.post_id),
      last_imported_at: "2026-09-01T00:00:00Z", detail_key: `published/indexes/arcalive/${hex(key.length * 7919, "e")}.json`,
    },
    detail: {
      schema: 1, lane: "arcalive", work: { work_id: `arcalive:${key}`, title, author },
      chapters: posts.map((post, index) => ({ ...post, label: post.title, reading_order: index })),
    },
  };
}

export async function useTextArchive(page, { novels = [], posts = [], works = [] } = {}) {
  const release = { novel: "1".repeat(64), arcalive: "2".repeat(64) };
  const catalog = { novel: "3".repeat(64), arcalive: "4".repeat(64), works: "5".repeat(64) };
  const bodies = new Map();
  for (const work of novels) {
    for (const chapter of work.detail.chapters) {
      bodies.set(chapter.sha256, `# ${work.item.title}-${chapter.label}\n# ${chapter.source_url}\n\n${chapter.label} 첫 줄\n${"본문 줄\n".repeat(60)}`);
    }
  }
  for (const post of posts) bodies.set(post.sha256, `# ${post.title}\n\n- url: https://arca.live/b/${post.board}/${post.post_id}\n\n---\n\n${post.title} 본문\n${"본문 줄\n".repeat(40)}`);
  const indexes = new Map([
    [catalog.novel, { schema: 1, lane: "novel", items: novels.map((work) => work.item) }],
    [catalog.arcalive, { schema: 1, lane: "arcalive", items: posts }],
    [catalog.works, { schema: 1, lane: "arcalive", view: "works", items: works.map((work) => work.item) }],
  ]);
  for (const work of [...novels, ...works]) indexes.set(/([a-f0-9]{64})\.json$/.exec(work.item.detail_key)[1], work.detail);
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload) => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (path.endsWith("/release/novel")) return novels.length ? json({ schema: 1, lane: "novel", sha256: release.novel }) : route.fulfill({ status: 404, body: "" });
    if (path.endsWith("/release/arcalive")) return json({ schema: 1, lane: "arcalive", sha256: release.arcalive });
    if (path.endsWith(`/release-manifest/novel/${release.novel}.json`)) {
      return json({ schema: 1, lane: "novel", generated_at: "2026-09-02T00:00:00Z", catalog_pages: [{ key: `published/indexes/novel/${catalog.novel}.json`, sha256: catalog.novel }] });
    }
    if (path.endsWith(`/release-manifest/arcalive/${release.arcalive}.json`)) {
      return json({
        schema: 1, lane: "arcalive", generated_at: "2026-09-02T00:00:00Z",
        catalog_pages: [{ key: `published/indexes/arcalive/${catalog.arcalive}.json`, sha256: catalog.arcalive }],
        work_catalog_pages: [{ key: `published/indexes/arcalive/${catalog.works}.json`, sha256: catalog.works }],
      });
    }
    const index = /\/index\/(?:novel|arcalive)\/([a-f0-9]{64})\.json$/.exec(path);
    if (index && indexes.has(index[1])) return json(indexes.get(index[1]));
    const object = /\/object\/([a-f0-9]{64})$/.exec(path);
    if (object && bodies.has(object[1])) return route.fulfill({ contentType: "text/markdown", body: bodies.get(object[1]) });
    return route.fulfill({ status: 404, body: "" });
  });
}
