import assert from "node:assert/strict";
import test from "node:test";

import { annotationAt, annotationRecord, documentAnnotations, NOTE_LIMIT, tombstone, withNote } from "../public/annotations.js";

// A text model with only what records need (text), as createTextModel would produce.
const model = { tm: 1, text: "첫 문장입니다.\n둘째 문장입니다.\n첫 문장입니다.\n", segments: [], positions: new WeakMap() };

test("a mark keeps a locator into the original text and its quote", () => {
  const record = annotationRecord({ model, start: 9, end: 18, rev: "", documentId: "typemoon:board_a:2", workId: "w", now: "2026-10-01T00:00:00Z", id: "a" });
  assert.equal(record.quote, "둘째 문장입니다.");
  assert.deepEqual(record.locator, { v: 2, tm: 1, rev: "", start: 9, end: 18, exact: "둘째 문장입니다.", prefix: "첫 문장입니다.\n", suffix: "\n첫 문장입니다.\n" });
  assert.equal(record.kind, "mark");
  assert.deepEqual(record.tags, []);
  assert.throws(() => annotationRecord({ model, start: 0, end: 3, documentId: "d", kind: "other" }), TypeError);
});

test("a note is edited in place and clearing it leaves a mark", () => {
  const record = annotationRecord({ model, start: 0, end: 8, documentId: "d", now: "t0", id: "a" });
  const noted = withNote(record, `  ${"메".repeat(NOTE_LIMIT + 5)} `, "t1");
  assert.equal(noted.kind, "note");
  assert.equal(noted.note.length, NOTE_LIMIT);
  assert.equal(noted.updatedAt, "t1");
  assert.equal(withNote(noted, "   ", "t2").kind, "mark");
});

test("deleting leaves a tombstone that the document list skips", () => {
  const first = annotationRecord({ model, start: 9, end: 18, documentId: "d", now: "t0", id: "b" });
  const second = annotationRecord({ model, start: 0, end: 8, documentId: "d", now: "t0", id: "a" });
  const other = annotationRecord({ model, start: 0, end: 8, documentId: "e", now: "t0", id: "c" });
  const gone = tombstone(first, "t1");
  assert.equal(gone.deletedAt, "t1");
  assert.deepEqual(documentAnnotations([first, second, other], "d").map((record) => record.id), ["a", "b"]);
  assert.deepEqual(documentAnnotations([gone, second, other], "d").map((record) => record.id), ["a"]);
});

test("the record under a point is the latest of overlapping marks", () => {
  const range = {};
  const placed = [
    { record: { id: "old", updatedAt: "t0" }, start: 0, end: 10, range },
    { record: { id: "new", updatedAt: "t1" }, start: 5, end: 8, range },
    { record: { id: "lost", updatedAt: "t2" }, start: 0, end: 10, range: null },
  ];
  assert.equal(annotationAt(placed, 2).record.id, "old");
  assert.equal(annotationAt(placed, 6).record.id, "new");
  assert.equal(annotationAt(placed, 10), null);
});
