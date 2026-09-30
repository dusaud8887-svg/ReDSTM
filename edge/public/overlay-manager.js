// Native dialogs/popovers own their close requests; only bars need a CloseWatcher.
export function createOverlayManager({ CloseWatcher = globalThis.CloseWatcher, onClose = () => {} } = {}) {
  const layers = [];
  const reasons = new Map();
  function finish(id, reason) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    while (layers.length > index + 1) closeTop("parent");
    const layer = layers.pop();
    layer.watcher?.destroy();
    reasons.delete(id);
    onClose({ id, kind: layer.kind, reason });
  }
  function closeTop(reason = "cancel") {
    const layer = layers.at(-1);
    if (!layer) return false;
    finish(layer.id, reason);
    layer.close();
    return true;
  }
  function add(layer) {
    if (!layers.some((item) => item.id === layer.id)) layers.push(layer);
  }
  return {
    layers,
    closeTop,
    closeAll(reason = "navigate") { while (closeTop(reason)) { /* one layer at a time */ } },
    watch(element, kind = "dialog") {
      const opened = () => add({ id: element.id, kind, close: () => {
        if (kind === "dialog") element.close();
        else element.hidePopover();
      } });
      const closed = () => finish(element.id, reasons.get(element.id) || (kind === "popover" ? "outside" : "cancel"));
      element.addEventListener("beforetoggle", (event) => { if (event.newState === "open") opened(); else closed(); });
      element.addEventListener("toggle", (event) => { if (event.newState === "open") opened(); else closed(); });
      element.addEventListener("cancel", () => reasons.set(element.id, "back"));
      element.addEventListener("close", closed);
      if (element.open || element.matches?.(":popover-open")) opened();
    },
    // Call synchronously inside the opening click, before any await.
    openBar(id, close) {
      if (layers.some((layer) => layer.id === id)) return;
      const watcher = CloseWatcher ? new CloseWatcher() : null;
      add({ id, kind: "bar", close, watcher });
      watcher?.addEventListener("cancel", (event) => { if (layers.at(-1)?.id !== id) event.preventDefault(); });
      watcher?.addEventListener("close", () => { if (layers.at(-1)?.id === id) closeTop("back"); });
    },
    handleEscape(event) {
      if (event.key !== "Escape" || !layers.length) return false;
      if (layers.at(-1).kind === "bar" && !layers.at(-1).watcher) {
        event.preventDefault();
        closeTop("back");
      }
      return true;
    },
    watchFullscreen(document) {
      document.addEventListener("fullscreenchange", () => {
        if (document.fullscreenElement) add({ id: "fullscreen", kind: "fullscreen", close: () => {
          void document.exitFullscreen().catch(() => {});
        } });
        else finish("fullscreen", "back");
      });
    },
    showToast(element) {
      const host = element.ownerDocument?.fullscreenElement;
      if (host && !host.contains(element)) host.append(element);
      if (element.matches(":popover-open")) element.hidePopover();
      element.hidden = false;
      element.showPopover();
    },
    hideToast(element) {
      if (element.matches(":popover-open")) element.hidePopover();
      element.hidden = true;
    },
  };
}
