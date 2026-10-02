import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEWS, matchesView, mergeLibrary, mergeWorkStyles, sanitizeLibrary } from "../public/library.js";
import { exportUserState, defaultUserState, planImport } from "../public/user-state.js";
import { planChanges } from "../public/store.js";

test("smart libraries combine conditions across sources and do not count unknown lengths", () => {
  const query = { source: "novel", read: "reading", fresh: true, maxChapters: 10, shelfId: "slater", pinned: true };
  const work = { source: "novel", read: "reading", fresh: true, chapters: 5 };
  assert.equal(matchesView(work, query, { shelfId: "slater", pinned: true }), true);
  for (const value of [{ source: "typemoon" }, { read: "finished" }, { fresh: false }, { chapters: 0 }, { chapters: 20 }]) {
    assert.equal(matchesView({ ...work, ...value }, query, { shelfId: "slater", pinned: true }), false);
  }
  assert.equal(matchesView(work, query, { shelfId: "slater", pinned: true, deletedAt: "2026-10-02T00:00:00Z" }), false);
  assert.equal(sanitizeLibrary(null).views.length, 5);
  assert.equal(DEFAULT_VIEWS.length, 5);
});

test("an older backup does not restore a removed view or a cleared work classification", () => {
  const old = { views: DEFAULT_VIEWS, updatedAt: "2026-10-02T09:00:00+09:00" };
  const mine = { views: [], updatedAt: "2026-10-02T00:30:00Z" };
  assert.deepEqual(mergeLibrary(mine, old).views, []);
  assert.deepEqual(mergeLibrary(null, { views: [] }).views, []);
  const workKey = "typemoon:collection:7";
  const current = [{ workKey, updatedAt: mine.updatedAt, deletedAt: mine.updatedAt }];
  assert.deepEqual(mergeWorkStyles(current, [{ workKey, updatedAt: old.updatedAt, shelfId: "slater" }]), []);
});

test("backup v4 preserves source-wide work styles and smart libraries without changing old backups", () => {
  const records = { annotations: [], sessions: [], works: [
    { workKey: "arcalive:novel:series", shelfId: "slater", pinned: true, hue: 3, updatedAt: "2026-10-02T00:00:00Z" },
    { workKey: "bad", updatedAt: "bad" },
  ], library: { shelves: [{ id: "slater", name: "나중에", hidden: false }], views: [{ id: "my-view", name: "짧은 소설", conditions: { source: "novel", maxChapters: 10, unknown: true } }] } };
  const state = defaultUserState();
  const planned = planImport(exportUserState(state, null, { records }));
  assert.equal(planned.records.works.length, 1);
  assert.deepEqual(planned.records.library.views[0].conditions, { source: "novel", maxChapters: 10 });
  assert.equal(planImport(exportUserState(state)).records, null);
  assert.equal(planChanges([{ store: "meta", value: planned.records.library }])[0].op.key, "meta:library");
  assert.throws(() => planChanges([{ store: "meta", value: { key: "deviceId" } }]), TypeError);
});
