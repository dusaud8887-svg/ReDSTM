// The page side of the service worker (docs/24 §12.6): registration as a module worker (browsers
// without module workers stay online-only), the owner whose caches it uses, and its messages.

// Everything this device keeps for one owner: the IndexedDB namespace and the caches named with
// that owner (§12.6.3). Shared, versioned assets (shell, fonts, vendor) stay.
export async function deleteNamespace(owner) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(`redstm:${owner}`);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  for (const name of await caches.keys()) if (name.endsWith(`-${owner}`)) await caches.delete(name);
}

export function createOffline({ onAuthExpired = () => {}, onUpdateReady = () => {}, onSave = () => {} } = {}) {
  const container = globalThis.navigator?.serviceWorker;
  let registration = null;
  let owner = "anon";

  function send(message) {
    const worker = registration?.active ?? container?.controller;
    worker?.postMessage(message);
  }

  async function register() {
    if (!container) return null;
    try {
      registration = await container.register("/sw.js", { scope: "/" });
    } catch {
      return null; // service workers unsupported or blocked: online only
    }
    if (!registration) return null;
    await container.ready;
    send({ type: "SET_OWNER", owner });
    // A new version waits until the page applies it at a safe point (T23).
    const watch = (worker) => worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && container.controller) onUpdateReady();
    });
    if (registration.waiting && container.controller) onUpdateReady();
    watch(registration.installing);
    registration.addEventListener("updatefound", () => watch(registration.installing));
    return registration;
  }

  container?.addEventListener("message", (event) => {
    if (event.data?.type === "auth-expired") onAuthExpired(event.data);
    else if (String(event.data?.type).startsWith("offline-")) onSave(event.data);
  });

  return {
    register,
    get registration() { return registration; },
    setOwner(hash) {
      owner = /^[a-f0-9]{16}$/.test(hash ?? "") ? hash : "anon";
      send({ type: "SET_OWNER", owner });
    },
    get owner() { return owner; },
    // A worker is needed to save; without one (unsupported, blocked) saving is not offered.
    get canSave() { return Boolean(registration?.active ?? container?.controller); },
    save(id, urls, requires = []) { send({ type: "SAVE_OFFLINE", id, urls, requires }); },
    remove(id, urls) { send({ type: "DELETE_OFFLINE", id, urls }); },
    cancel(id) { send({ type: "CANCEL_OFFLINE", id }); },
    // The waiting version takes over and the page reloads once it controls (T23).
    applyUpdate() {
      const waiting = registration?.waiting;
      if (!waiting) return false;
      container.addEventListener("controllerchange", () => location.reload(), { once: true });
      waiting.postMessage({ type: "SKIP_WAITING" });
      return true;
    },
    // 앱 캐시 지우기 (T24): the worker goes and the caches it filled with it; saved works go too.
    async reset() {
      await registration?.unregister();
      for (const name of await caches.keys()) await caches.delete(name);
    },
  };
}
