import { captureTextAnchor, restoreTextAnchor } from "./text-anchor.js";

export function createScrollAdapter({ body, scroller, topInset = () => 0, revision = () => "", progress, mode = "scroll" }) {
  return {
    mode,
    captureVisiblePosition: () => captureTextAnchor(body, scroller, topInset(), revision()),
    scrollToRange: (anchor) => restoreTextAnchor(body, scroller, anchor, topInset(), revision()),
    measureProgress: progress,
    onViewportChanged: (anchor) => restoreTextAnchor(body, scroller, anchor, topInset(), revision()),
  };
}

export function createDocumentSession() {
  let controller = new AbortController();
  const pending = new Set();
  const session = {
    generation: 0, documentKey: "", workId: "", rev: "", adapter: null,
    saved: null, userScrolled: false, keyboardOpen: false,
    get signal() { return controller.signal; },
    get canSave() { return !session.keyboardOpen && !controller.signal.aborted; },
    begin({ documentKey, workId = "", rev = "", adapter = null }) {
      session.cancelPendingWork();
      controller = new AbortController();
      session.generation += 1;
      Object.assign(session, { documentKey, workId, rev, adapter, saved: null, userScrolled: false });
      return session.generation;
    },
    cancelPendingWork() {
      controller.abort();
      for (const cancel of pending) cancel();
      pending.clear();
    },
    track(cancel) {
      pending.add(cancel);
      return () => pending.delete(cancel);
    },
    guard(callback) {
      const generation = session.generation;
      const signal = controller.signal;
      return (...args) => {
        if (generation !== session.generation || signal.aborted) return undefined;
        return callback(...args);
      };
    },
    frame(callback) {
      const guarded = session.guard(callback);
      const id = requestAnimationFrame(() => { pending.delete(cancel); guarded(); });
      const cancel = () => cancelAnimationFrame(id);
      pending.add(cancel);
      return cancel;
    },
    capture() {
      if (!session.canSave || !session.adapter) return null;
      session.saved = session.adapter.captureVisiblePosition();
      return session.saved;
    },
    restore(anchor = session.saved, policy = "keep-top") {
      if (!anchor || controller.signal.aborted || !session.adapter) return false;
      const restored = session.adapter.scrollToRange(anchor, policy);
      if (restored) session.saved = anchor;
      return restored;
    },
    afterLayout(generation) {
      if (generation !== session.generation || session.userScrolled || session.keyboardOpen) return false;
      return session.restore();
    },
    markUserScroll() { session.userScrolled = true; },
    setKeyboardOpen(open) { session.keyboardOpen = Boolean(open); },
  };
  return session;
}
