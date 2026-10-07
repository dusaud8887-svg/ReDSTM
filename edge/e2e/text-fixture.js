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

// A published Tunaground lane (docs/34): one work of two threads, each served in segments.
export async function useTunaArchive(page) {
  const hex = (seed, fill) => seed.toString(16).padStart(64, fill);
  const segment = (thread, first, last) => Array.from({ length: last - first + 1 }, (_, offset) => {
    const seq = first + offset;
    return `──── #${seq} 릴리아◆mMF3WSPttu · 2026-10-07 20:${String(seq % 60).padStart(2, "0")}\n`
      + `　　　 ／ヘ　　 스레드 ${thread} 레스 ${seq}\n　　 ／　[⌒ ＼＿${"　".repeat(80)}끝\n`;
  }).join("\n");
  const chapters = [[1, 0, 0, 99], [1, 1, 100, 101], [2, 0, 0, 3]].map(([thread, part, first, last], order) => ({
    chapter_id: `tuna:anchor:${thread}:${part}`, reading_order: order, label: `[AA/역극] 별의 노래 (${thread}) · #${first}–${last}`,
    thread_id: thread, segment: part, source_url: `https://bbs2.tunaground.net/trace/anchor/${thread}/${part * 100}/${part * 100 + 99}`,
    sha256: hex(9000 + order, "c"), body: segment(thread, first, last),
  }));
  const work = {
    work_id: "tuna:00000000000000aa", title: "별의 노래", author: "릴리아◆mMF3WSPttu", tags: "[AA/역극]",
    thread_count: 2, chapter_count: chapters.length, latest_label: "[AA/역극] 별의 노래 (2)",
    last_imported_at: "2026-10-07T00:00:00Z", ended: false, detail_key: `published/indexes/tuna/${hex(77, "d")}.json`,
  };
  const release = "8".repeat(64);
  const catalog = "9".repeat(64);
  await page.route("**/api/v1/text/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload) => route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
    if (path.endsWith("/release/tuna")) return json({ schema: 1, lane: "tuna", sha256: release });
    if (path.endsWith(`/release-manifest/tuna/${release}.json`)) {
      return json({ schema: 1, lane: "tuna", generated_at: "2026-10-07T00:00:00Z",
        catalog_pages: [{ key: `published/indexes/tuna/${catalog}.json`, sha256: catalog }] });
    }
    if (path.endsWith(`/index/tuna/${catalog}.json`)) return json({ schema: 1, lane: "tuna", items: [work] });
    if (path.endsWith(`/index/tuna/${hex(77, "d")}.json`)) {
      return json({ schema: 1, lane: "tuna", work: { work_id: work.work_id, title: work.title, author: work.author },
        chapters: chapters.map(({ body, ...chapter }) => chapter) });
    }
    const object = /\/object\/([a-f0-9]{64})$/.exec(path);
    const found = object && chapters.find((chapter) => chapter.sha256 === object[1]);
    if (found) return route.fulfill({ contentType: "text/markdown", body: found.body });
    return route.fulfill({ status: 404, body: "" });
  });
  return { work, chapters };
}
