import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_KEY,
  defaultUserState,
  exportUserState,
  migrateLegacyState,
  planImport,
  postIdentity,
  samePost,
} from "../public/user-state.js";

const defaults = {
  theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, proseFont: "serif",
  aaSize: 16, aaZoom: 1, aaCanvasWidth: null, aaBackground: "#f5f5f0", aaPreserveStyles: true,
};
const summary = (extension = "zst", hash = "a") => ({
  board_id: "write_free21",
  external_post_id: 62068,
  object_key: `posts/write_free21/62068-${hash.repeat(64)}.json.${extension}`,
});

test("default state follows the v2 stable identity schema", () => {
  assert.equal(STATE_KEY, "redstm.userState.v2");
  assert.deepEqual(defaultUserState(defaults), {
    schema_version: 2,
    settings: defaults,
    history: {},
    bookmarks: {},
    scroll: {},
    viewModes: {},
    lastCatalogState: null,
  });
  assert.equal(postIdentity(summary()), "write_free21:62068");
  assert.equal(samePost(summary("zst", "a"), summary("gz", "b")), true);
  assert.equal(samePost(summary(), null), false);
});

test("migrates validated v1 gz and zst entries and drops object keys", () => {
  const state = migrateLegacyState({
    settings: { ...defaults, theme: "dark", viewModes: {
      "write_free21:62068": "aa", "../bad": "aa", "write:9": "other",
    } },
    history: [
      { summary: summary("zst", "a"), readAt: "2026-07-11T00:00:00Z", scroll: 320 },
      { summary: { ...summary("zst", "b"), board_id: "other" }, readAt: "2026-07-12T00:00:00Z" },
    ],
    bookmarks: [{ summary: summary("gz", "c"), savedAt: "2026-07-11T01:00:00Z" }],
  }, defaults);

  assert.equal(state.settings.theme, "dark");
  assert.deepEqual(state.history, {
    "write_free21:62068": { readAt: "2026-07-11T00:00:00Z" },
  });
  assert.deepEqual(state.bookmarks, {
    "write_free21:62068": { savedAt: "2026-07-11T01:00:00Z" },
  });
  assert.deepEqual(state.scroll, { "write_free21:62068": 320 });
  assert.deepEqual(state.viewModes, { "write_free21:62068": "aa" });
  assert.equal(JSON.stringify(state).includes("object_key"), false);
});

test("exports only normalized v2 state", () => {
  const state = defaultUserState(defaults);
  state.history["write_free21:62068"] = {
    readAt: "2026-07-11T00:00:00Z", object_key: summary().object_key,
  };
  state.bookmarks["write_free21:62068"] = { savedAt: "2026-07-11T01:00:00Z" };
  state.scroll["write_free21:62068"] = 81;
  state.viewModes["write_free21:62068"] = "prose";
  state.lastCatalogState = { query: "달빛", scrollTop: 120, nested: { object_key: "forbidden" } };

  const exported = exportUserState(state);
  const payload = JSON.parse(exported);
  assert.equal(payload.schema_version, 2);
  assert.deepEqual(payload.history["write_free21:62068"], { readAt: "2026-07-11T00:00:00Z" });
  assert.deepEqual(payload.lastCatalogState, { query: "달빛", scrollTop: 120, nested: {} });
  assert.equal(exported.includes("object_key"), false);
});

test("plans v2 import with counts without applying it", () => {
  const state = defaultUserState(defaults);
  state.history["aa_19:12"] = { readAt: "2026-07-11T00:00:00Z" };
  state.bookmarks["aa_19:12"] = { savedAt: "2026-07-11T01:00:00Z" };
  state.scroll["aa_19:12"] = 40;
  state.viewModes["aa_19:12"] = "aa";

  const plan = planImport(exportUserState(state), defaults);
  assert.deepEqual(plan.state, state);
  assert.deepEqual(plan.summary, {
    history: 1, bookmarks: 1, scroll: 1, viewModes: 1, defaultedSettings: [],
  });
});

test("keeps setting ranges and rejects unknown schemas", () => {
  const plan = planImport(JSON.stringify({
    schema_version: 2,
    settings: {
      ...defaults, proseFont: "sans", aaSize: 25, aaZoom: 3, aaCanvasWidth: 800,
      aaBackground: "#ABCDEF", aaPreserveStyles: false,
    },
    history: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  }), defaults);
  assert.deepEqual(plan.state.settings, {
    ...defaults, proseFont: "sans", aaZoom: 3, aaCanvasWidth: 800,
    aaBackground: "#abcdef", aaPreserveStyles: false,
  });
  assert.deepEqual(plan.summary.defaultedSettings, ["aaSize"]);
  assert.throws(() => planImport(JSON.stringify({ schema_version: 3 }), defaults),
    /지원하지 않는 상태 파일 형식/);
});
