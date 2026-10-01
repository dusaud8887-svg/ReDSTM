// The page side of the service worker (docs/24 §12.6): registration as a module worker (browsers
// without module workers stay online-only), the owner whose caches it uses, and its messages.

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
      registration = await container.register("/sw.js", { type: "module", scope: "/" });
    } catch {
      return null; // module workers unsupported or blocked: online only
    }
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
  };
}
