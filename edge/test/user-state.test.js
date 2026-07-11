import assert from "node:assert/strict";
import test from "node:test";

import { exportUserState, importUserState, samePost } from "../public/user-state.js";

const defaults = { theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, aaSize: 16 };
const summary = (hash) => ({
  board_id: "write_free21",
  external_post_id: 62068,
  object_key: `posts/write_free21/62068-${hash.repeat(64)}.json.gz`,
});

test("user state follows stable post identity and imports the newest entry", () => {
  assert.equal(samePost(summary("a"), summary("b")), true);
  assert.equal(samePost(summary("a"), null), false);

  const current = {
    history: [{ summary: summary("a"), readAt: "2026-07-10T00:00:00Z", scroll: 10 }],
    bookmarks: [],
  };
  const imported = importUserState(
    exportUserState(
      { ...defaults, theme: "dark" },
      [{ summary: summary("b"), readAt: "2026-07-11T00:00:00Z", scroll: 20 }],
      [],
    ),
    current,
    defaults,
  );

  assert.equal(imported.settings.theme, "dark");
  assert.equal(imported.history.length, 1);
  assert.equal(imported.history[0].summary.object_key, summary("b").object_key);
  assert.equal(imported.history[0].scroll, 20);

  const mismatched = { ...summary("c"), board_id: "other_board" };
  const rejected = importUserState(
    exportUserState(defaults, [{ summary: mismatched, readAt: "2026-07-12T00:00:00Z" }], []),
    { history: [], bookmarks: [] },
    defaults,
  );
  assert.equal(rejected.history.length, 0);
});
