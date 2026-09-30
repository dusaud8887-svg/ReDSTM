import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentSession } from "../public/reader-session.js";

test("a document generation cancels old work and keeps document and work identities separate", () => {
  const session = createDocumentSession();
  session.begin({ documentKey: "typemoon:board:1", workId: "collection:1", rev: "a" });
  const signal = session.signal;
  let calls = 0;
  const callback = session.guard(() => { calls += 1; });
  let canceled = false;
  session.track(() => { canceled = true; });
  session.begin({ documentKey: "typemoon:board:1", workId: "collection:2", rev: "b" });
  callback();
  assert.equal(calls, 0);
  assert.equal(canceled, true);
  assert.equal(signal.aborted, true);
  assert.equal(session.signal.aborted, false);
  assert.equal(session.generation, 2);
  assert.equal(session.documentKey, "typemoon:board:1");
  assert.equal(session.workId, "collection:2");
});

test("font swaps stop correcting after user scroll or while the keyboard is open", () => {
  const session = createDocumentSession();
  const anchor = { offset: 12, quote: "읽던 문장" };
  let restores = 0;
  session.begin({ documentKey: "text:1", adapter: {
    captureVisiblePosition: () => anchor,
    scrollToRange: (value) => { assert.equal(value, anchor); restores += 1; return true; },
  } });
  assert.equal(session.capture(), anchor);
  assert.equal(session.afterLayout(session.generation), true);
  assert.equal(session.afterLayout(session.generation - 1), false);
  session.setKeyboardOpen(true);
  assert.equal(session.capture(), null);
  assert.equal(session.canSave, false);
  assert.equal(session.afterLayout(session.generation), false);
  session.setKeyboardOpen(false);
  session.markUserScroll();
  assert.equal(session.afterLayout(session.generation), false);
  assert.equal(restores, 1);
});

test("tracked animation frames are removed when the document changes", (context) => {
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  const frames = new Map();
  context.after(() => {
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  });
  globalThis.requestAnimationFrame = (callback) => { frames.set(1, callback); return 1; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  const session = createDocumentSession();
  session.begin({ documentKey: "one" });
  let called = false;
  session.frame(() => { called = true; });
  const lateCallback = frames.get(1);
  session.begin({ documentKey: "two" });
  assert.equal(frames.size, 0);
  lateCallback();
  assert.equal(called, false);
});

test("only the app's restored scroll may be corrected after a late layout", () => {
  const session = createDocumentSession();
  let top = 0;
  let restores = 0;
  const adapter = {
    captureVisiblePosition: () => ({ top }),
    scrollTop: () => top,
    scrollToRange: (anchor) => { top = anchor.top; restores += 1; return true; },
  };
  session.begin({ documentKey: "text:1", adapter });
  session.capture();
  session.restore();
  session.observeScroll(1);
  assert.equal(session.userScrolled, false);
  assert.equal(session.afterLayout(session.generation), true);
  top = 999;
  session.observeScroll(top);
  assert.equal(session.userScrolled, true);
  assert.equal(session.afterLayout(session.generation), false);
  assert.equal(top, 999);
  assert.equal(restores, 2);
  session.begin({ documentKey: "text:2", adapter });
  assert.equal(session.expectedTop, null);
  assert.equal(session.userScrolled, false);
  session.observeScroll(300);
  assert.equal(session.userScrolled, true);
});
