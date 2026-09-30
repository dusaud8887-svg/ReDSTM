import assert from "node:assert/strict";
import test from "node:test";
import { createOverlayManager } from "../public/overlay-manager.js";

function element(id) {
  const target = new EventTarget();
  return Object.assign(target, {
    id, open: false,
    matches: () => false,
    showModal() {
      this.open = true;
      this.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "open" }));
    },
    close() {
      this.open = false;
      this.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "closed" }));
      this.dispatchEvent(new Event("close"));
    },
  });
}

test("native layers close in order without extra watchers or duplicate close events", () => {
  const closed = [];
  const manager = createOverlayManager({ CloseWatcher: class { constructor() { assert.fail("native layer got a watcher"); } }, onClose: (layer) => closed.push(layer) });
  const settings = element("settings");
  const menu = element("menu");
  manager.watch(settings);
  manager.watch(menu);
  settings.showModal();
  menu.showModal();
  menu.dispatchEvent(new Event("cancel"));
  menu.close();
  assert.deepEqual(manager.layers.map((layer) => layer.id), ["settings"]);
  assert.deepEqual(closed, [{ id: "menu", kind: "dialog", reason: "back" }]);
  manager.closeAll();
  assert.equal(settings.open, false);
  assert.equal(closed[1].reason, "navigate");
  assert.equal(manager.layers.length, 0);
  settings.showModal();
  menu.showModal();
  settings.close();
  assert.equal(menu.open, false);
  assert.equal(closed[2].reason, "parent");
  assert.equal(manager.layers.length, 0);
});

test("watchers belong only to bars and closing a parent closes its child first", () => {
  const watchers = [];
  class Watcher extends EventTarget {
    constructor() { super(); watchers.push(this); }
    destroy() { this.destroyed = true; }
  }
  const closed = [];
  const manager = createOverlayManager({ CloseWatcher: Watcher, onClose: (layer) => closed.push(layer) });
  manager.openBar("find", () => {});
  const sheet = element("sheet");
  manager.watch(sheet);
  sheet.showModal();
  const cancel = new Event("cancel", { cancelable: true });
  watchers[0].dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  watchers[0].dispatchEvent(new Event("close"));
  assert.equal(manager.layers.length, 2);
  sheet.close();
  watchers[0].dispatchEvent(new Event("close"));
  assert.equal(manager.layers.length, 0);
  assert.equal(watchers[0].destroyed, true);
  assert.equal(closed[1].reason, "back");
  manager.openBar("parent", () => {});
  sheet.showModal();
  manager.closeAll("navigate");
  assert.equal(sheet.open, false);
});

test("without CloseWatcher Escape closes one bar and native dialogs retain their default action", () => {
  const manager = createOverlayManager({ CloseWatcher: null });
  let closes = 0;
  manager.openBar("find", () => { closes += 1; });
  const sheet = element("settings");
  manager.watch(sheet);
  sheet.showModal();
  const escapeEvent = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
  assert.equal(manager.handleEscape(escapeEvent), true);
  assert.equal(escapeEvent.defaultPrevented, false);
  assert.equal(closes, 0);
  sheet.close();
  assert.equal(manager.handleEscape(escapeEvent), true);
  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(closes, 1);
  assert.equal(manager.layers.length, 0);
});
