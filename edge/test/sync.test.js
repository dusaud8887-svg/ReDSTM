import assert from "node:assert/strict";
import test from "node:test";

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { syncResponse } from "../src/sync-api.js";
import { applyEntries, planCandidates, pushOnLeave, stateEntries, syncOnce } from "../public/sync.js";

// The real Worker sync routes on real SQLite with the real migrations.
function server() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
  const execute = (sql, parameters, mode) => {
    const statement = db.prepare(sql);
    if (mode === "first") return statement.get(...parameters) ?? null;
    if (mode === "all") return { results: statement.all(...parameters) };
    return { meta: { changes: Number(statement.run(...parameters).changes) } };
  };
  const CONTROL_DB = {
    prepare(sql) {
      const statement = {
        sql, parameters: [],
        bind(...values) { statement.parameters = values; return statement; },
        first: async () => execute(sql, statement.parameters, "first"),
        all: async () => execute(sql, statement.parameters, "all"),
        run: async () => execute(sql, statement.parameters, "run"),
      };
      return statement;
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.parameters, "run"));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = { CONTROL_DB, TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "aud" };
  const identity = { role: "user", subject: "reader@example.com" };
  let requests = 0;
  const fetchImpl = async (path, init = {}) => {
    requests += 1;
    return syncResponse(new Request(`https://archive.example${path}`, init), env, identity);
  };
  return { db, fetchImpl, requests: () => requests };
}

const emptyUser = () => ({ schema_version: 2, settings: {}, history: {}, bookmarks: {}, scroll: {}, viewModes: {}, aaViews: {}, lastCatalogState: null });
const emptyText = () => ({ schema_version: 1, history: {}, bookmarks: {}, shelves: [], workShelves: {}, hidden: {} });

// A browser: its states and records, kept the way the page keeps them.
function device(remote, name, { clock = () => Date.parse("2026-10-09T12:00:00Z"), keep = (state) => state } = {}) {
  const self = {
    userState: emptyUser(), textState: emptyText(),
    records: { annotations: [], sessions: [], works: [], library: null },
    savedMeta: null,
  };
  const put = (list, value, id) => {
    const index = list.findIndex((item) => item[id] === value[id]);
    if (index >= 0) list[index] = value;
    else list.push(value);
  };
  self.local = {
    read: async () => structuredClone({ userState: self.userState, textState: self.textState, records: self.records }),
    apply: async (changes, conflicts = []) => {
      const result = applyEntries({ userState: self.userState, textState: self.textState }, changes);
      if (result.userState) self.userState = keep(result.userState);
      if (result.textState) self.textState = result.textState;
      for (const { store, value } of result.records) {
        if (store === "annotations") put(self.records.annotations, value, "id");
        if (store === "sessions") put(self.records.sessions, value, "id");
        if (store === "works") put(self.records.works, value, "workKey");
        if (store === "meta") self.records.library = value;
      }
      for (const record of conflicts) self.records.annotations.push({ ...record, id: `${record.id}-c`, conflictOf: record.id });
    },
  };
  self.meta = { get: async () => structuredClone(self.savedMeta), put: async (value) => { self.savedMeta = structuredClone(value); } };
  self.sync = () => syncOnce({ fetchImpl: remote.fetchImpl, local: self.local, meta: self.meta, deviceId: `device-${name}`, now: clock });
  return self;
}

const read = (at, progress, extra = {}) => ({ readAt: at, progress, ...extra });

test("records made on one device appear on another, and a second run sends nothing", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  const desk = device(remote, "desk");
  phone.userState.history["board_a:1"] = read("2026-10-09T10:00:00.000Z", 0.4, { offset: 120 });
  phone.userState.scroll["board_a:1"] = 900;
  phone.userState.bookmarks["board_a:2"] = { savedAt: "2026-10-09T09:00:00.000Z", note: "다시 볼 것" };
  phone.userState.later = { "post:board_a:3": { at: "2026-10-09T08:00:00.000Z", on: true, route: "/read/board_a/3", title: "3", source: "typemoon" } };
  phone.textState.history["novel:7:70"] = read("2026-10-09T07:00:00.000Z", 1, { title: "70화" });
  phone.records.annotations.push({ id: "mark-1", documentId: "novel:7:70", updatedAt: "2026-10-09T07:10:00.000Z", note: "", kind: "mark" });
  phone.records.sessions.push({ id: "session-1", day: "2026-10-09", end: 1_000, spans: [[0, 1_000]] });
  const first = await phone.sync();
  assert.equal(first.pushed, 7, "six records and the (empty) shelf list");
  const pulled = await desk.sync();
  assert.equal(pulled.applied, 6);
  assert.deepEqual(desk.userState.history["board_a:1"], read("2026-10-09T10:00:00.000Z", 0.4, { offset: 120 }));
  assert.equal(desk.userState.scroll["board_a:1"], 900);
  assert.equal(desk.userState.bookmarks["board_a:2"].note, "다시 볼 것");
  assert.equal(desk.userState.later["post:board_a:3"].on, true);
  assert.equal(desk.textState.history["novel:7:70"].title, "70화");
  assert.deepEqual(desk.records.annotations.map((record) => record.id), ["mark-1"]);
  assert.deepEqual(desk.records.sessions.map((record) => record.id), ["session-1"]);
  // Nothing new on either side: no push, and the next pull is empty.
  assert.deepEqual([(await desk.sync()).pushed, (await phone.sync()).pushed], [0, 0]);
  assert.equal((await desk.sync()).pulled, 0);
});

test("the later reading position wins on both devices and the furthest progress is kept", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  const desk = device(remote, "desk");
  // Read on the desk first (further in), then on the phone later but nearer the start.
  desk.userState.history["board_a:1"] = read("2026-10-09T09:00:00.000Z", 0.9, { offset: 9000 });
  phone.userState.history["board_a:1"] = read("2026-10-09T11:00:00.000Z", 0.3, { offset: 3000 });
  // Phone syncs first; the desk was offline and syncs afterwards with its older reading.
  await phone.sync();
  await desk.sync();
  await phone.sync();
  for (const browser of [phone, desk]) {
    assert.deepEqual(browser.userState.history["board_a:1"], read("2026-10-09T11:00:00.000Z", 0.9, { offset: 3000 }));
  }
});

test("a first sync keeps both devices' records and the newer of each", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  const desk = device(remote, "desk");
  phone.userState.bookmarks["board_a:1"] = { savedAt: "2026-10-09T10:00:00.000Z", note: "phone" };
  phone.userState.history["board_a:5"] = read("2026-10-09T10:00:00.000Z", 0.5);
  await phone.sync();
  // The desk had records of its own before it ever synced: one older, one only it has.
  desk.userState.bookmarks["board_a:1"] = { savedAt: "2026-10-01T10:00:00.000Z", note: "desk, older" };
  desk.userState.bookmarks["board_a:9"] = { savedAt: "2026-10-02T10:00:00.000Z" };
  await desk.sync();
  await phone.sync();
  for (const browser of [phone, desk]) {
    assert.equal(browser.userState.bookmarks["board_a:1"].note, "phone");
    assert.ok(browser.userState.bookmarks["board_a:9"]);
    assert.ok(browser.userState.history["board_a:5"]);
  }
});

test("a removal on one device removes the entry everywhere and an old copy cannot bring it back", async () => {
  const remote = server();
  const phone = device(remote, "phone", { clock: () => Date.parse("2026-10-09T12:00:00Z") });
  const desk = device(remote, "desk", { clock: () => Date.parse("2026-10-09T12:05:00Z") });
  for (const browser of [phone, desk]) {
    browser.userState.bookmarks["board_a:1"] = { savedAt: "2026-10-01T10:00:00.000Z" };
    browser.userState.bookmarks["board_a:2"] = { savedAt: "2026-10-01T10:00:00.000Z" };
  }
  await phone.sync();
  await desk.sync();
  delete desk.userState.bookmarks["board_a:1"];
  await desk.sync();
  // The phone still holds its unchanged copy: it takes the removal instead of resending the bookmark.
  await phone.sync();
  assert.equal(phone.userState.bookmarks["board_a:1"], undefined);
  assert.ok(phone.userState.bookmarks["board_a:2"]);
  // Saving it again later is a newer action and wins.
  phone.userState.bookmarks["board_a:1"] = { savedAt: "2026-10-09T13:00:00.000Z" };
  await phone.sync();
  await desk.sync();
  assert.ok(desk.userState.bookmarks["board_a:1"]);
});

test("a device whose storage was cleared gets its records back instead of deleting them everywhere", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  for (let index = 0; index < 4; index += 1) phone.userState.bookmarks[`board_a:${index}`] = { savedAt: "2026-10-01T10:00:00.000Z" };
  await phone.sync();
  phone.userState.bookmarks = {};
  await phone.sync();
  assert.equal(Object.keys(phone.userState.bookmarks).length, 4);
  const fresh = device(remote, "fresh");
  await fresh.sync();
  assert.equal(Object.keys(fresh.userState.bookmarks).length, 4);
});

test("history pruned for space is not sent as a deletion; a field this version drops does not loop", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  phone.userState.history["board_a:1"] = read("2026-10-01T10:00:00.000Z", 0.1);
  phone.userState.history["board_a:2"] = read("2026-10-05T10:00:00.000Z", 0.2);
  await phone.sync();
  // The oldest record was pruned to make room for a new one.
  delete phone.userState.history["board_a:1"];
  phone.userState.history["board_a:3"] = read("2026-10-09T10:00:00.000Z", 0.3);
  await phone.sync();
  const desk = device(remote, "desk", {
    // An older app version whose sanitizer drops a field the phone writes.
    keep: (state) => {
      for (const record of Object.values(state.history)) delete record.future;
      return state;
    },
  });
  await desk.sync();
  assert.deepEqual(Object.keys(desk.userState.history).sort(), ["board_a:1", "board_a:2", "board_a:3"]);
  phone.userState.history["board_a:3"] = read("2026-10-09T10:00:00.000Z", 0.3, { future: "kept" });
  await phone.sync();
  await desk.sync();
  // The desk shows the record without the field it does not know and does not send it back stripped.
  assert.equal((await desk.sync()).pushed, 0);
  await phone.sync();
  assert.equal(phone.userState.history["board_a:3"].future, "kept");
});

test("a deleted note stays deleted, and an edit that lost is kept as a conflict copy", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  const desk = device(remote, "desk");
  const note = { id: "note-1", documentId: "novel:1:1", kind: "note", note: "처음", updatedAt: "2026-10-09T08:00:00.000Z" };
  phone.records.annotations.push(structuredClone(note));
  await phone.sync();
  await desk.sync();
  phone.records.annotations[0] = { ...note, note: "휴대폰에서 고침", updatedAt: "2026-10-09T10:00:00.000Z" };
  desk.records.annotations[0] = { ...note, note: "책상에서 고침", updatedAt: "2026-10-09T09:00:00.000Z" };
  await phone.sync();
  const run = await desk.sync();
  // The later phone edit is kept; the desk's own edit stays beside it as a conflict copy.
  assert.equal(run.conflicts, 1);
  assert.equal(desk.records.annotations.find((record) => record.id === "note-1").note, "휴대폰에서 고침");
  assert.equal(desk.records.annotations.find((record) => record.conflictOf === "note-1").note, "책상에서 고침");
  desk.records.annotations = desk.records.annotations.filter((record) => !record.conflictOf);
  // Deleted on the desk; an old phone edit afterwards does not bring it back.
  desk.records.annotations[0] = { ...desk.records.annotations[0], deletedAt: "2026-10-09T11:00:00.000Z", updatedAt: "2026-10-09T11:00:00.000Z" };
  await desk.sync();
  phone.records.annotations[0] = { ...phone.records.annotations[0], note: "늦은 수정", updatedAt: "2026-10-09T12:00:00.000Z" };
  await phone.sync();
  assert.ok(phone.records.annotations.find((record) => record.id === "note-1").deletedAt);
});

test("text shelves are united by name on a first sync, then follow the latest change", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  const desk = device(remote, "desk");
  phone.textState.shelves = [{ id: "s1", name: "읽는 중" }];
  phone.textState.workShelves = { "novel:1": "s1" };
  await phone.sync();
  desk.textState.shelves = [{ id: "s9", name: "나중에" }];
  desk.textState.workShelves = { "novel:2": "s9" };
  await desk.sync();
  await phone.sync();
  for (const browser of [phone, desk]) {
    assert.deepEqual(browser.textState.shelves.map((shelf) => shelf.name).sort(), ["나중에", "읽는 중"]);
    assert.equal(Object.keys(browser.textState.workShelves).length, 2);
  }
});

test("a leaving page sends its pending changes with keepalive and the next run settles them", async () => {
  const remote = server();
  const phone = device(remote, "phone");
  await phone.sync();
  phone.userState.history["board_a:1"] = read("2026-10-09T10:00:00.000Z", 0.4);
  const requests = [];
  const sent = await pushOnLeave({
    fetchImpl: async (path, init) => { requests.push(init); return remote.fetchImpl(path, init); },
    local: phone.local, meta: phone.meta, deviceId: "device-phone",
  });
  assert.equal(sent, 1);
  assert.equal(requests[0].keepalive, true);
  const desk = device(remote, "desk");
  await desk.sync();
  assert.ok(desk.userState.history["board_a:1"]);
  // The phone's next run finds the server already agrees.
  assert.equal((await phone.sync()).applied, 0);
});

test("a signed-out answer or a network failure stops the run without changing what was agreed", async () => {
  const phone = device(server(), "phone");
  phone.userState.history["board_a:1"] = read("2026-10-09T10:00:00.000Z", 0.4);
  const html = async () => new Response("<html>sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  await assert.rejects(syncOnce({ fetchImpl: html, local: phone.local, meta: phone.meta, deviceId: "device-phone" }), { kind: "auth" });
  const down = async () => { throw new TypeError("network"); };
  await assert.rejects(syncOnce({ fetchImpl: down, local: phone.local, meta: phone.meta, deviceId: "device-phone" }), { kind: "offline" });
  const refused = async () => Response.json({ error: "owner_not_allowed" }, { status: 403 });
  await assert.rejects(syncOnce({ fetchImpl: refused, local: phone.local, meta: phone.meta, deviceId: "device-phone" }), { kind: "unavailable" });
  assert.equal(phone.savedMeta, null);
});

test("entries map TypeMoon and text state to their keys and back", () => {
  const userState = { ...emptyUser(), history: { "board_a:1": read("2026-10-09T10:00:00.000Z", 0.5) }, scroll: { "board_a:1": 40 }, viewModes: { "board_a:1": "aa" } };
  const entries = stateEntries({ userState, textState: emptyText() });
  assert.deepEqual([...entries.keys()].sort(), ["text.shelves", "tm.h:board_a:1", "tm.view:board_a:1"]);
  assert.equal(entries.get("tm.h:board_a:1").scroll, 40);
  const back = applyEntries({ userState: emptyUser(), textState: emptyText() }, new Map([...entries].map(([key, data]) => [key, { at: 1, data }])));
  assert.deepEqual(back.userState.history, userState.history);
  assert.deepEqual(back.userState.scroll, userState.scroll);
  assert.deepEqual(back.userState.viewModes, userState.viewModes);
  // A first sync with nothing agreed yet sends entries without a time of their own at 0.
  const { candidates } = planCandidates(entries, {}, 5_000, false);
  assert.equal(candidates.get("tm.view:board_a:1").at, 0);
  assert.equal(candidates.get("tm.h:board_a:1").at, Date.parse("2026-10-09T10:00:00.000Z"));
});
