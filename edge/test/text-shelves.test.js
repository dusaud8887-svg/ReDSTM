import assert from "node:assert/strict";
import test from "node:test";

import {
  UNSORTED, addShelf, ensureShelves, hiddenShelfIds, mergeShelfState, migrateShelfAliases, moveShelf,
  removeShelf, renameShelf, sanitizeShelfState, setShelfHidden, setWorkShelf, shelfCounts, shelfName, shelfOf,
} from "../public/text-shelves.js";

test("a state gets starter shelves once, then keeps its own list", () => {
  const state = { history: {}, bookmarks: {} };
  assert.equal(ensureShelves(state), true);
  assert.deepEqual(state.shelves.map((shelf) => shelf.name), ["찜 · 나중에 볼 작품", "다 본 작품", "안 볼 작품"]);
  assert.deepEqual([...hiddenShelfIds(state)], ["sskip"]);
  removeShelf(state, "sdone");
  assert.equal(ensureShelves(state), false);
  assert.equal(state.shelves.length, 2);
});

test("works move between shelves and 미분류; removing a shelf returns its works", () => {
  const state = { shelves: [], workShelves: {} };
  const { id } = addShelf(state, "  BL  ", { hidden: true });
  assert.equal(shelfName(state, id), "BL");
  assert.deepEqual(addShelf(state, "bl"), { error: "name_taken" });
  assert.deepEqual(addShelf(state, "   "), { error: "name_empty" });
  assert.equal(setWorkShelf(state, "novel:a", id), true);
  assert.equal(setWorkShelf(state, "novel:a", id), false);
  assert.equal(shelfOf(state, "novel:a"), id);
  assert.equal(shelfOf(state, "novel:b"), UNSORTED);
  const works = [{ work_id: "novel:a" }, { work_id: "novel:b" }, { work_id: "novel:c" }];
  assert.deepEqual([...shelfCounts(state, works)], [[UNSORTED, 2], [id, 1]]);
  const later = addShelf(state, "나중에").id;
  assert.equal(moveShelf(state, later, -1), true);
  assert.deepEqual(state.shelves.map((shelf) => shelf.id), [later, id]);
  assert.deepEqual(renameShelf(state, later, "BL"), { error: "name_taken" });
  setShelfHidden(state, id, false);
  assert.equal(hiddenShelfIds(state).size, 0);
  removeShelf(state, id);
  assert.equal(shelfOf(state, "novel:a"), UNSORTED);
});

test("sanitize drops bad shelves and assignments; aliases and imports keep shelves", () => {
  const clean = sanitizeShelfState({
    shelves: [{ id: "sok", name: "좋음" }, { id: "bad id", name: "x" }, { id: "sdup", name: "좋음" }, { id: "sx", name: "" }],
    workShelves: { "novel:1": "sok", "novel:2": "sdup", "arcalive:x": "sok" },
  });
  assert.deepEqual(clean, { shelves: [{ id: "sok", name: "좋음", hidden: false }], workShelves: { "novel:1": "sok" } });

  const state = { shelves: [{ id: "sok", name: "좋음", hidden: false }], workShelves: { "novel:old": "sok" } };
  assert.equal(migrateShelfAliases(state, [{ work_id: "novel:new", legacy_work_ids: ["novel:old"] }]), true);
  assert.deepEqual(state.workShelves, { "novel:new": "sok" });

  mergeShelfState(state, {
    shelves: [{ id: "sother", name: "좋음" }, { id: "sok", name: "새 분류", hidden: true }],
    workShelves: { "novel:x": "sother", "novel:y": "sok" },
  });
  assert.equal(state.shelves.length, 2);
  assert.equal(state.workShelves["novel:x"], "sok");
  const added = state.shelves.find((shelf) => shelf.name === "새 분류");
  assert.notEqual(added.id, "sok");
  assert.equal(state.workShelves["novel:y"], added.id);
  assert.equal(added.hidden, true);
});
