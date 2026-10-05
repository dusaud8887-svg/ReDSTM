import { limitHistoryForStorage } from "../public/user-state.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createLocator } from "../public/text-model.js";

import {
  STATE_KEY,
  readBackupText,
  defaultUserState,
  exportUserState,
  migrateLegacyState,
  planImport,
  postIdentity,
  sanitizeBookmarkMetadata,
  mergeTextStates,
  mergeUserStates,
  mergeAnnotationRecords,
  mergeSessionRecords,
  samePost,
  serializeUserState,
} from "../public/user-state.js";

const defaults = {
  theme: "system", proseSize: 18, lineHeight: 1.8, proseWidth: 760, proseFont: "serif",
  aaSize: 16, aaZoom: 1, aaCanvasWidth: null, aaBackground: "#f5f5f0", aaPreserveStyles: true,
};

test("gzip backup limit counts UTF-8 bytes before retaining the decoded file", async () => {
  const text = "가나다😀".repeat(1024);
  const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  assert.equal(await readBackupText(compressed), text);
  await assert.rejects(readBackupText(compressed, 4096), /허용 크기/);
  const plain = new Blob(["가😀"]);
  assert.equal(await readBackupText(plain, 7), "가😀");
  await assert.rejects(readBackupText(plain, 6), /허용 크기/);
  await assert.rejects(readBackupText(new Blob([new Uint8Array([0x1f, 0x8b, 0, 0])])), Error);
});

test("manual document reading and bookmarks survive backup import", () => {
  const identity = `manual:${"a".repeat(64)}`;
  const text = { schema_version: 1, history: {
    [identity]: { readAt: "2026-10-01T00:00:00Z", progress: 0.5, title: "1~5권", route: `/text?lane=manual&item=${identity}` },
  }, bookmarks: {
    [identity]: { savedAt: "2026-10-01T00:00:00Z", lane: "manual", title: "1~5권", entry: {
      identity, title: "1~5권", created_at: "2026-10-01T00:00:00Z", sha256: "b".repeat(64), category: "작품",
    } },
  } };
  const backup = JSON.parse(exportUserState(defaultUserState(defaults), text));
  assert.equal(backup.text.history[identity].progress, 0.5);
  assert.equal(backup.text.bookmarks[identity].lane, "manual");
  assert.equal(backup.text.bookmarks[identity].entry.created_at, "2026-10-01T00:00:00Z");
});
const summary = (extension = "zst", hash = "a") => ({
  board_id: "write_free21",
  external_post_id: 62068,
  object_key: `posts/write_free21/62068-${hash.repeat(64)}.json.${extension}`,
});

test("continuous prose mode survives backup validation and unknown modes fall back", () => {
  const current = defaultUserState({ ...defaults, readingMode: "scroll" });
  const continuous = planImport(exportUserState({ ...current, settings: { ...current.settings, readingMode: "continuous" } }), current.settings);
  assert.equal(continuous.state.settings.readingMode, "continuous");
  const unknown = planImport(exportUserState({ ...current, settings: { ...current.settings, readingMode: "infinite" } }), current.settings);
  assert.equal(unknown.state.settings.readingMode, "scroll");
});

test("optional locators survive v2 storage and v3 backups without replacing legacy positions", () => {
  const revision = "a".repeat(64);
  const loc = createLocator({ text: "앞 문장. 읽던 문장. 뒤 문장." }, 6, 12, revision);
  const position = { offset: 5, anchor: "읽던 문장", anchorTop: -4, revision, loc, documentId: "typemoon:write_free21:62068", workId: "collection:7" };
  const state = defaultUserState(defaults);
  state.history["write_free21:62068"] = { readAt: "2026-09-30T00:00:00Z", progress: 0.6, ...position };
  state.scroll["write_free21:62068"] = 300;
  const stored = planImport(serializeUserState(state), defaults).state;
  assert.deepEqual(stored.history["write_free21:62068"], state.history["write_free21:62068"]);
  assert.equal(stored.schema_version, 2);
  const text = { schema_version: 1, history: { "novel:novel:toki:1:1": { readAt: "2026-09-30T00:00:00Z", ...position, scroll: 200 } }, bookmarks: {} };
  const backup = planImport(exportUserState(state, text), defaults);
  assert.deepEqual(backup.text.history["novel:novel:toki:1:1"].loc, loc);
  assert.equal(backup.text.history["novel:novel:toki:1:1"].offset, 5);
  const malformed = JSON.parse(serializeUserState(state));
  malformed.history["write_free21:62068"].loc.end = -1;
  const recovered = planImport(JSON.stringify(malformed), defaults).state;
  assert.equal(recovered.history["write_free21:62068"].loc, undefined);
  assert.equal(recovered.history["write_free21:62068"].offset, 5);
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
    exportedAt: plan.summary.exportedAt, annotations: null, sessions: null, defaultedSettings: [],
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
  const fitted = planImport(exportUserState({ ...defaultUserState(defaults), aaViews: { "aa_19:12": { zoom: 0.6, fit: true, at: 5 }, "aa_19:13": { left: 3, fit: true, at: 6 } } }), defaults);
  assert.deepEqual(fitted.state.aaViews, { "aa_19:13": { left: 3, at: 6 }, "aa_19:12": { zoom: 0.6, fit: true, at: 5 } });
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

// R01 (docs/24_frontend_redesign_risk_review.md): times with different zone offsets compare as
// instants, so the later reading position wins a merge.
test("a merge compares reading times as instants across time zone offsets", () => {
  const current = defaultUserState(defaults);
  current.history["write_free21:62068"] = { readAt: "2026-09-30T00:30:00Z", progress: 0.3 };
  current.scroll["write_free21:62068"] = 30;
  const incoming = defaultUserState(defaults);
  incoming.history["write_free21:62068"] = { readAt: "2026-09-30T09:00:00+09:00", progress: 0.1 };
  incoming.scroll["write_free21:62068"] = 10;
  const merged = mergeUserStates(current, incoming);
  assert.equal(merged.scroll["write_free21:62068"], 30);
  assert.equal(merged.history["write_free21:62068"].readAt, "2026-09-30T00:30:00Z");
  const texts = mergeTextStates(
    { schema_version: 1, history: { "novel:a:1": { readAt: "2026-09-30T00:30:00Z", progress: 0.3, title: "1화" } }, bookmarks: {} },
    { schema_version: 1, history: { "novel:a:1": { readAt: "2026-09-30T09:00:00+09:00", progress: 0.1, title: "옛 1화" } }, bookmarks: {} },
  );
  assert.equal(texts.history["novel:a:1"].title, "1화");
});

const mark = (id, updatedAt, extra = {}) => ({
  id, documentId: "typemoon:board_a:2", workId: "", kind: "mark", note: "", tags: [], quote: "문장",
  locator: { v: 2, tm: 1, rev: "", start: 0, end: 2, exact: "문장", prefix: "", suffix: "" },
  context: { title: "2편", work: "긴 연재", route: "/read/board_a/2" }, createdAt: "2026-09-01T00:00:00Z", updatedAt, ...extra,
});

test("a v4 backup carries marks, notes and sessions and plans their import", () => {
  const records = {
    annotations: [mark("a", "2026-09-02T00:00:00Z"), mark("b", "2026-09-03T00:00:00Z", { deletedAt: "2026-09-03T00:00:00Z" }), { id: "../bad" }],
    sessions: [{ id: "s1", day: "2026-09-02", spans: [[1, 61_000]], chars: 120, endOfWork: true, deviceId: "d" }, { id: "s2", day: "x", spans: [] }],
  };
  const backup = JSON.parse(exportUserState(defaultUserState(defaults), null, { exportedAt: "2026-10-01T00:00:00Z", records }));
  assert.equal(backup.schema_version, 4);
  assert.deepEqual(backup.records.annotations.map((record) => record.id), ["a", "b"]);
  assert.equal(backup.records.sessions.length, 1);
  assert.deepEqual(backup.records.sessions[0].spans, [[1, 61_000]]);
  const plan = planImport(JSON.stringify(backup), defaults);
  assert.equal(plan.summary.annotations, 1);
  assert.equal(plan.summary.sessions, 1);
  assert.equal(plan.records.annotations[1].deletedAt, "2026-09-03T00:00:00Z");
  // Without records the file stays a v3 backup that older versions read.
  assert.equal(JSON.parse(exportUserState(defaultUserState(defaults))).schema_version, 3);
});

test("merging marks keeps deletions permanent and the later edit (T22)", () => {
  const current = [mark("a", "2026-09-02T00:00:00Z"), mark("b", "2026-09-05T00:00:00Z", { deletedAt: "2026-09-05T00:00:00Z" }), mark("c", "2026-09-02T00:00:00Z")];
  const incoming = [
    mark("a", "2026-09-04T09:00:00+09:00", { note: "백업 쪽 메모", kind: "note" }),
    mark("b", "2026-09-09T00:00:00Z", { note: "되살리면 안 됨" }),
    mark("c", "2026-09-03T00:00:00Z", { deletedAt: "2026-09-03T00:00:00Z" }),
    mark("d", "2026-09-01T00:00:00Z"),
  ];
  const changes = mergeAnnotationRecords(current, incoming);
  // "a" was edited on both sides: the later edit wins and this device's edit stays as a copy.
  assert.deepEqual(changes.map((record) => record.id), ["a", changes[1].id, "c", "d"]);
  assert.equal(changes[0].note, "백업 쪽 메모");
  assert.equal(changes[1].conflictOf, "a");
  assert.equal(changes[1].note, "");
  changes.splice(1, 1);
  assert.equal(changes[1].deletedAt, "2026-09-03T00:00:00Z");
  // An older copy of the same edit changes nothing; an older different edit is kept as a copy.
  assert.deepEqual(mergeAnnotationRecords([mark("a", "2026-09-05T00:00:00Z")], [mark("a", "2026-09-04T00:00:00Z")]), []);
  const older = mergeAnnotationRecords([mark("a", "2026-09-05T00:00:00Z")], [mark("a", "2026-09-04T00:00:00Z", { note: "다른 기기 메모" })]);
  assert.deepEqual(older.map((record) => [record.conflictOf, record.note]), [["a", "다른 기기 메모"]]);
  // Importing the same backup again adds no second copy.
  assert.deepEqual(mergeAnnotationRecords([mark("a", "2026-09-05T00:00:00Z"), older[0]], [mark("a", "2026-09-04T00:00:00Z", { note: "다른 기기 메모" })]), []);
  assert.deepEqual(mergeSessionRecords([{ id: "s", end: 10 }], [{ id: "s", end: 5 }, { id: "s", end: 20 }, { id: "t", end: 1 }]).map((session) => session.end), [20, 1]);
});

test("imported times with a zone offset are kept as the same instant in UTC", () => {
  const texts = mergeTextStates(
    { schema_version: 1, history: {}, bookmarks: {} },
    { schema_version: 1, history: { "novel:a:1": { readAt: "2026-09-30T09:00:00+09:00", progress: 0.1 } }, bookmarks: {} },
  );
  assert.equal(texts.history["novel:a:1"].readAt, "2026-09-30T00:00:00.000Z");
  const state = defaultUserState(defaults);
  state.history["write_free21:62068"] = { readAt: "2026-09-30T09:00:00+09:00", progress: 0.1 };
  assert.equal(planImport(exportUserState(state), defaults).state.history["write_free21:62068"].readAt, "2026-09-30T00:00:00.000Z");
  state.history["write_free21:62068"].readAt = "2026-09-30T00:00:00Z";
  assert.equal(planImport(exportUserState(state), defaults).state.history["write_free21:62068"].readAt, "2026-09-30T00:00:00Z");
});

test("reading profiles, work exceptions and the auto-scroll speed survive storage and backups", () => {
  const state = defaultUserState(defaults);
  state.settings.autoScrollSpeed = 4;
  state.settings.readingProfiles = [
    { name: "밤", values: { readerSurface: "ink", readerDim: 30, proseSize: 20, theme: "dark", aaZoom: 2 } },
    { name: "밤", values: { proseSize: 16 } },
    { name: "", values: { proseSize: 16 } },
    { name: "낮", values: { proseSize: 99 } },
  ];
  state.settings.workProfiles = { "typemoon:collection:1": "밤", "typemoon:collection:2": "없는 프로필" };
  const restored = planImport(exportUserState(state), defaults).state.settings;
  assert.equal(restored.autoScrollSpeed, 4);
  assert.deepEqual(restored.readingProfiles, [{ name: "밤", values: { proseSize: 20, readerSurface: "ink", readerDim: 30 } }]);
  assert.deepEqual(restored.workProfiles, { "typemoon:collection:1": "밤" });
  state.settings.autoScrollSpeed = 11;
  assert.equal(planImport(exportUserState(state), defaults).state.settings.autoScrollSpeed, undefined);
});


test("history storage budget counts locators and scroll and retains the most recent records", () => {
  const history = {};
  const scroll = {};
  for (let index = 1; index <= 10_000; index += 1) {
    history[`board:${index}`] = { readAt: new Date(1_000_000 + index * 1000).toISOString(), anchor: "가".repeat(500), loc: { exact: "나".repeat(10_000) } };
    scroll[`board:${index}`] = index;
  }
  const state = { history, scroll, bookmarks: { "board:1": { savedAt: "2026-10-05T00:00:00Z" } } };
  const bounded = limitHistoryForStorage(state);
  assert.ok(JSON.stringify({ history: bounded.history, scroll: bounded.scroll }).length * 2 < 1_048_576);
  assert.ok(bounded.history["board:10000"]);
  assert.equal(bounded.history["board:1"], undefined);
  assert.deepEqual(Object.keys(bounded.scroll), Object.keys(bounded.history));
  assert.deepEqual(bounded.bookmarks, state.bookmarks);
  assert.equal(Object.keys(state.history).length, 10_000);
});
