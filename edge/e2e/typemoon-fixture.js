// A TypeMoon archive with one long series on board_a, served through page.route. Shared by the
// reader flow and accessibility specs.

export const hashFor = (id) => id.toString(16).padStart(64, "0");
export const postKey = (id) => `posts/board_a/${id}-${hashFor(id)}.json.zst`;
export const collectionIndexKey = `collections/index-v2-${"4".repeat(64)}.json.zst`;

export function postPayload(id) {
  return {
    schema_version: 1,
    post: {
      board_id: "board_a", external_post_id: id, canonical_url: `https://example.test/${id}`,
      title: `${id}편 제목`, author: "작성자", category: null, created_at_raw: "2026-07-11", views: 1,
      body_html: Array.from({ length: 40 }, (_, index) => `<p>${id}편 본문 ${index + 1}</p>`).join(""),
      is_aa: false,
    },
    comments: [],
  };
}

export async function useLongCollection(page, count) {
  const entries = Array.from({ length: count }, (_, index) => ({
    position: index + 1, board_id: "board_a", external_post_id: index + 1,
    title: `${index + 1}편 제목`, object_key: postKey(index + 1),
  }));
  const payloads = new Map([
    ["release.json", {
      schema_version: 1,
      search: { object_key: "search/e2e.json.zst" },
      collections: { object_key: collectionIndexKey },
      boards: [{ board_id: "board_a", name: "자유게시판", group_name: "창작", post_count: count }],
    }],
    ["search/e2e.json.zst", {
      schema_version: 1,
      fields: ["board_id", "external_post_id", "title", "author", "category", "created_at_raw", "payload_sha256", "is_aa"],
      posts: entries.map((entry) => ["board_a", entry.external_post_id, entry.title, "작성자", null, "2026-07-11", hashFor(entry.external_post_id), false]),
    }],
    [collectionIndexKey, { schema_version: 1, collections: [{ id: 1, board_id: "board_a", kind: "series", title: "긴 연재", entries }] }],
  ]);
  await page.route("**/archive/**", (route) => {
    const key = new URL(route.request().url()).pathname.slice("/archive/".length);
    const post = /^posts\/board_a\/(\d+)-/.exec(key);
    const payload = post ? postPayload(Number(post[1])) : payloads.get(key);
    if (!payload) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}
