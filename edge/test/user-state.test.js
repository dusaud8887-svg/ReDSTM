import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_KEY,
  defaultUserState,
  exportUserState,
  migrateLegacyState,
  planImport,
  postIdentity,
  sanitizeBookmarkMetadata,
  mergeTextStates,
  mergeUserStates,
  samePost,
  serializeUserState,
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
    aaViews: {},
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

test("exports a v3 backup with only normalized TypeMoon state", () => {
  const state = defaultUserState(defaults);
  state.history["write_free21:62068"] = {
    readAt: "2026-07-11T00:00:00Z", progress: 0.42, object_key: summary().object_key,
  };
  state.bookmarks["write_free21:62068"] = {
    savedAt: "2026-07-11T01:00:00Z", note: "  다시 볼 장면  ", tags: ["마술", "마술", "AA"],
  };
  state.scroll["write_free21:62068"] = 81;
  state.viewModes["write_free21:62068"] = "prose";
  state.lastCatalogState = { query: "달빛", scrollTop: 120, nested: { object_key: "forbidden" } };

  const exported = exportUserState(state, null, { exportedAt: "2026-09-30T00:00:00.000Z" });
  const backup = JSON.parse(exported);
  assert.equal(backup.format, "redstm-backup");
  assert.equal(backup.schema_version, 3);
  assert.equal(backup.exported_at, "2026-09-30T00:00:00.000Z");
  assert.equal(backup.text, undefined);
  const payload = backup.typemoon;
  assert.equal(payload.schema_version, undefined);
  assert.deepEqual(payload.history["write_free21:62068"], { readAt: "2026-07-11T00:00:00Z", progress: 0.42 });
  assert.deepEqual(payload.bookmarks["write_free21:62068"], {
    savedAt: "2026-07-11T01:00:00Z", note: "다시 볼 장면", tags: ["마술", "AA"],
  });
  assert.deepEqual(payload.lastCatalogState, { query: "달빛", scrollTop: 120, nested: {} });
  assert.equal(exported.includes("object_key"), false);
});

test("bounds bookmark notes and tags at the import boundary", () => {
  const metadata = sanitizeBookmarkMetadata(` ${"메".repeat(1002)} `, [
    " 태그 ", "ＴＡＧ", "tag", ...Array.from({ length: 12 }, (_, index) => `분류${index}`), 3,
  ]);
  assert.equal(metadata.note.length, 1000);
  assert.deepEqual(metadata.tags.slice(0, 2), ["태그", "ＴＡＧ"]);
  assert.equal(metadata.tags.includes("tag"), false);
  assert.equal(metadata.tags.length, 10);

  const state = planImport(JSON.stringify({
    schema_version: 2, settings: defaults, history: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
    bookmarks: { "write_free21:62068": {
      savedAt: "2026-07-11T01:00:00Z", note: metadata.note, tags: metadata.tags,
    } },
  }), defaults).state;
  assert.deepEqual(state.bookmarks["write_free21:62068"], {
    savedAt: "2026-07-11T01:00:00Z", note: metadata.note, tags: metadata.tags,
  });
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
    history: 1, bookmarks: 1, scroll: 1, viewModes: 1, textHistory: null, textBookmarks: null, shelves: null,
    exportedAt: plan.summary.exportedAt, defaultedSettings: [],
  });
  assert.equal(plan.text, null);
});

test("backs up the text library's reading records and saved items", () => {
  const hash = "a".repeat(64);
  const text = {
    schema_version: 1,
    history: {
      "novel:novel:1:12": {
        readAt: "2026-09-01T00:00:00Z", progress: 0.5, scroll: 900, offset: 120, anchor: "문장", anchorTop: 12,
        total: 40, title: "12화", work: "소설", workId: "novel:1", chapterId: "12", revision: hash,
        route: "/text?lane=novel&work=novel%3A1&chapter=12", listRoute: "https://evil.example/", extra: "drop",
      },
      "novel:novel:1:13": { readAt: "not a date" },
      "write_free21:1": { readAt: "2026-09-01T00:00:00Z" },
    },
    bookmarks: {
      "arcalive:novel:108:text": {
        savedAt: "2026-09-02T00:00:00Z", lane: "arcalive", title: "글",
        entry: { identity: "arcalive:novel:108:text", sha256: hash, object_key: "x" }, note: " 메모 ", tags: ["a", "a"],
      },
      "arcalive:novel:109:text": { savedAt: "2026-09-02T00:00:00Z", lane: "arcalive", entry: { sha256: "bad" } },
    },
  };
  const state = defaultUserState(defaults);
  const payload = JSON.parse(exportUserState(state, text));
  assert.equal(payload.schema_version, 3);
  assert.deepEqual(Object.keys(payload.text.history), ["novel:novel:1:12"]);
  assert.equal(payload.text.history["novel:novel:1:12"].listRoute, undefined);
  assert.equal(payload.text.history["novel:novel:1:12"].extra, undefined);
  assert.equal(payload.text.history["novel:novel:1:12"].route, "/text?lane=novel&work=novel%3A1&chapter=12");
  assert.deepEqual(payload.text.bookmarks, { "arcalive:novel:108:text": {
    savedAt: "2026-09-02T00:00:00Z", lane: "arcalive", title: "글",
    entry: { identity: "arcalive:novel:108:text", sha256: hash }, note: "메모", tags: ["a"],
  } });
  // The localStorage copy of the TypeMoon state never carries the text section.
  assert.equal(JSON.parse(serializeUserState({ ...state, text })).text, undefined);

  const plan = planImport(JSON.stringify(payload), defaults);
  assert.deepEqual(plan.text, payload.text);
  assert.equal(plan.summary.textHistory, 1);
  assert.equal(plan.summary.textBookmarks, 1);
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
  const reading = planImport(JSON.stringify({
    schema_version: 2,
    settings: { ...defaults, readerSurface: "paper", proseAlign: "justify" },
    history: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  }), { ...defaults, readerSurface: "default", proseAlign: "start" });
  assert.equal(reading.state.settings.readerSurface, "paper");
  assert.equal(reading.state.settings.proseAlign, "justify");
  const unknown = planImport(JSON.stringify({
    schema_version: 2,
    settings: { ...defaults, readerSurface: "neon", proseAlign: "center" },
    history: {}, bookmarks: {}, scroll: {}, viewModes: {}, lastCatalogState: null,
  }), { ...defaults, readerSurface: "default", proseAlign: "start" });
  assert.equal(unknown.state.settings.readerSurface, "default");
  assert.equal(unknown.state.settings.proseAlign, "start");
  assert.deepEqual(unknown.summary.defaultedSettings, ["proseAlign", "readerSurface"]);
  assert.throws(() => planImport(JSON.stringify({ schema_version: 3 }), defaults),
    /지원하지 않는 상태 파일 형식/);
});

test("keeps each AA picture's zoom and sideways position, newest 300", () => {
  const state = defaultUserState(defaults);
  state.aaViews = {
    "aa_19:12": { zoom: 0.75, left: 120.4, at: 5 },
    "aa_19:13": { zoom: 9, left: -1, at: 6 },
    "../bad": { zoom: 1, at: 7 },
  };
  for (let index = 0; index < 305; index += 1) state.aaViews[`aa_19:${1000 + index}`] = { left: index, at: 100 + index };
  const plan = planImport(exportUserState(state), defaults);
  assert.deepEqual(plan.state.aaViews["aa_19:12"], undefined);
  assert.equal(Object.keys(plan.state.aaViews).length, 300);
  assert.deepEqual(plan.state.aaViews["aa_19:1304"], { left: 304, at: 404 });
  const small = planImport(exportUserState({ ...defaultUserState(defaults), aaViews: state.aaViews && { "aa_19:12": { zoom: 0.75, left: 120.4, at: 5 } } }), defaults);
  assert.deepEqual(small.state.aaViews, { "aa_19:12": { zoom: 0.75, left: 120, at: 5 } });
});

test("imports v2 files and merges a backup into this browser's records", () => {
  const legacy = planImport(JSON.stringify({ ...defaultUserState(defaults), text: { history: {}, bookmarks: {} } }), defaults);
  assert.deepEqual(legacy.text, { schema_version: 1, history: {}, bookmarks: {} });
  assert.throws(() => planImport(JSON.stringify({ schema_version: 3, typemoon: {} }), defaults), /지원하지 않는/);

  const mine = defaultUserState(defaults);
  mine.settings.theme = "dark";
  mine.history["aa_19:1"] = { readAt: "2026-09-01T00:00:00Z", progress: 1 };
  mine.history["aa_19:2"] = { readAt: "2026-09-05T00:00:00Z", progress: 0.2 };
  mine.scroll["aa_19:2"] = 50;
  mine.bookmarks["aa_19:1"] = { savedAt: "2026-09-01T00:00:00Z", note: "내 메모" };
  mine.viewModes["aa_19:1"] = "prose";
  const theirs = defaultUserState(defaults);
  theirs.history["aa_19:1"] = { readAt: "2026-09-10T00:00:00Z", progress: 0.3 };
  theirs.history["aa_19:2"] = { readAt: "2026-09-02T00:00:00Z", progress: 0.9 };
  theirs.history["aa_19:3"] = { readAt: "2026-09-03T00:00:00Z" };
  theirs.scroll["aa_19:1"] = 700;
  theirs.bookmarks["aa_19:3"] = { savedAt: "2026-09-03T00:00:00Z" };
  theirs.viewModes["aa_19:1"] = "aa";
  theirs.viewModes["aa_19:3"] = "aa";
  const merged = mergeUserStates(mine, theirs);
  assert.equal(merged.settings.theme, "dark");
  // Newer record wins, furthest progress is kept.
  assert.deepEqual(merged.history["aa_19:1"], { readAt: "2026-09-10T00:00:00Z", progress: 1 });
  assert.equal(merged.scroll["aa_19:1"], 700);
  assert.deepEqual(merged.history["aa_19:2"], { readAt: "2026-09-05T00:00:00Z", progress: 0.9 });
  assert.equal(merged.scroll["aa_19:2"], 50);
  assert.ok(merged.history["aa_19:3"]);
  assert.deepEqual(Object.keys(merged.bookmarks).sort(), ["aa_19:1", "aa_19:3"]);
  assert.equal(merged.bookmarks["aa_19:1"].note, "내 메모");
  assert.deepEqual(merged.viewModes, { "aa_19:1": "prose", "aa_19:3": "aa" });

  const hash = "c".repeat(64);
  const text = mergeTextStates(
    { history: { "novel:a:1": { readAt: "2026-09-01T00:00:00Z", progress: 0.5 } }, bookmarks: {},
      shelves: [{ id: "sbl", name: "BL", hidden: true }], workShelves: { "novel:a": "sbl" } },
    { history: { "novel:a:1": { readAt: "2026-08-01T00:00:00Z", progress: 1 }, "novel:a:2": { readAt: "2026-08-02T00:00:00Z" } },
      bookmarks: { "novel:a:2": { savedAt: "2026-08-02T00:00:00Z", lane: "novel", entry: { sha256: hash } } },
      shelves: [{ id: "sx", name: "bl" }, { id: "sy", name: "완결" }], workShelves: { "novel:b": "sx", "novel:c": "sy" } },
  );
  assert.deepEqual(text.history["novel:a:1"], { readAt: "2026-09-01T00:00:00Z", progress: 1 });
  assert.ok(text.history["novel:a:2"] && text.bookmarks["novel:a:2"]);
  assert.deepEqual(text.shelves.map((shelf) => shelf.name), ["BL", "완결"]);
  assert.deepEqual(text.workShelves, { "novel:a": "sbl", "novel:b": "sbl", "novel:c": "sy" });
});
