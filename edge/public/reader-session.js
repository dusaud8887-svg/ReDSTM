import { captureTextAnchor, restoreTextAnchor } from "./text-anchor.js";

export function createScrollAdapter({ body, scroller, topInset = () => 0, revision = () => "", progress, mode = "scroll" }) {
  const restore = (anchor) => {
    if (anchor.atStart) { scroller.scrollTop = 0; return true; }
    return restoreTextAnchor(body, scroller, anchor, topInset(), revision());
  };
  return {
    mode,
    captureVisiblePosition: () => {
      const anchor = captureTextAnchor(body, scroller, topInset(), revision());
      return anchor ? { ...anchor, atStart: scroller.scrollTop === 0 } : null;
    },
    scrollToRange: restore,
    scrollTop: () => scroller.scrollTop,
    measureProgress: progress,
    onViewportChanged: restore,
  };
}

export function createDocumentSession() {
  let controller = new AbortController();
  const pending = new Set();
  const session = {
    generation: 0, documentKey: "", workId: "", rev: "", adapter: null,
    saved: null, savedTop: null, userScrolled: false, keyboardOpen: false, expectedTop: null,
    get signal() { return controller.signal; },
    get canSave() { return !session.keyboardOpen && !controller.signal.aborted; },
    begin({ documentKey, workId = "", rev = "", adapter = null }) {
      session.cancelPendingWork();
      controller = new AbortController();
      session.generation += 1;
      Object.assign(session, { documentKey, workId, rev, adapter, saved: null, savedTop: null, userScrolled: false, expectedTop: null });
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
      session.savedTop = session.adapter.scrollTop?.() ?? null;
      return session.saved;
    },
    restore(anchor = session.saved, policy = "keep-top") {
      if (!anchor || controller.signal.aborted || !session.adapter) return false;
      const restored = session.adapter.scrollToRange(anchor, policy);
      if (restored) session.saved = anchor;
      session.expectedTop = session.adapter.scrollTop?.() ?? null;
      session.savedTop = session.expectedTop;
      return restored;
    },
    observeScroll(top) {
      if (session.expectedTop === null || Math.abs(top - session.expectedTop) > 2) session.userScrolled = true;
      session.expectedTop = null;
    },
    afterLayout(generation) {
      if (generation !== session.generation || session.userScrolled || session.keyboardOpen) return false;
      const top = session.adapter?.scrollTop?.();
      // Scroll events are queued: a font/image callback may run before observeScroll.
      if (session.savedTop !== null && top !== undefined && Math.abs(top - session.savedTop) > 2) {
        session.markUserScroll();
        return false;
      }
      return session.restore();
    },
    markUserScroll() { session.userScrolled = true; },
    setKeyboardOpen(open) { session.keyboardOpen = Boolean(open); },
  };
  return session;
}
