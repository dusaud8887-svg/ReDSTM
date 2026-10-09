// Service worker (docs/24 §12.6). Routes are registered in the order of the §12.6.1 table and the
// first match wins. Nothing is imported dynamically. Every caching strategy shares one response
// check: a redirect, a 3xx/401/403 or an HTML answer to an API request is never cached and tells
// the page that the sign-in has expired instead of standing in for the real answer.

import {
  CacheableResponsePlugin, CacheFirst, ExpirationPlugin, NavigationRoute, NetworkFirst, NetworkOnly, RangeRequestsPlugin,
  cleanupOutdatedCaches, precacheAndRoute, registerRoute,
} from "/vendor/workbox@7.4.1/workbox.js";
import shell from "/precache-manifest.js";

const OWNER_CACHE = "redstm-sw-owner";
const DAY = 24 * 60 * 60;
let owner = "anon";
const owners = new Map();

// The signed-in owner (ownerHash from /api/v1/me, sent by the page) suffixes every cache that holds
// reading data, so another account on this device never reads or overwrites it (§12.6.3).
async function loadOwner() {
  const saved = await (await caches.open(OWNER_CACHE)).match("/owner");
  if (saved) owner = await saved.text();
}
const ownerLoaded = loadOwner().catch(() => {});
const named = (base, account) => `${base}-${account}`;
const offlineCacheName = (account) => named("offline-v1", account);

async function ownerFor(clientId) {
  await ownerLoaded;
  if (!clientId) return "anon";
  if (!owners.has(clientId)) owners.set(clientId, (async () => {
    const saved = await (await caches.open(OWNER_CACHE)).match(`/owner/${clientId}`);
    if (saved) return saved.text();
    try {
      const response = await fetch("/api/v1/me", { credentials: "same-origin" });
      if (authFailure(new Request(new URL("/api/v1/me", self.location.origin)), response)) return owner;
      const me = response.ok ? await response.json() : null;
      return /^[a-f0-9]{16}$/.test(me?.ownerHash ?? "") ? me.ownerHash : "anon";
    } catch { return owner; }
  })());
  return owners.get(clientId);
}

function tell(message, clientId) {
  void self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    for (const client of clients) if (!clientId || client.id === clientId) client.postMessage(message);
  });
}

const api = (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/archive/");
function authFailure(request, response) {
  if (!response) return false;
  if (response.type === "opaqueredirect" || response.redirected || [401, 403].includes(response.status) ||
      (response.status >= 300 && response.status < 400)) return true;
  return api(new URL(request.url)) && (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html");
}
function cacheable(request, response) {
  if (response?.status !== 200 || authFailure(request, response)) return false;
  return !new URL(request.url).pathname.endsWith(".js") ||
    /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get("Content-Type") ?? "");
}
const guard = {
  async fetchDidSucceed({ request, response, event }) {
    if (authFailure(request, response)) tell({ type: "auth-expired", url: request.url }, event?.clientId);
    return response;
  },
  async cacheWillUpdate({ request, response }) {
    return cacheable(request, response) ? response : null;
  },
  async cachedResponseWillBeUsed({ request, cachedResponse }) {
    return cacheable(request, cachedResponse) ? cachedResponse : null;
  },
};

// Strategies resolve their cache name per request, after the owner is known.
function ownedStrategy(Strategy, base, options = {}) {
  return async (context) => {
    const started = cacheEpoch;
    const account = await ownerFor(context.event?.clientId);
    if (account === "anon" || deletingOwners.has(account) || (deletedAt.get(account) ?? 0) > started) return new NetworkOnly({ plugins: [guard] }).handle(context);
    const [response, done] = new Strategy({ ...options, cacheName: named(base, account), plugins: [guard, ...(options.plugins ?? [])] }).handleAll(context);
    const tasks = ownedTasks.get(account) ?? new Set();
    ownedTasks.set(account, tasks);
    const finished = done.catch(() => {}).finally(() => {
      tasks.delete(finished);
      if (!tasks.size) ownedTasks.delete(account);
    });
    tasks.add(finished);
    return response;
  };
}
// A work saved for offline reading answers first; otherwise the runtime cache.
function savedFirst(fallback) {
  return async (context) => {
    const account = await ownerFor(context.event?.clientId);
    const saved = account === "anon" ? null : await (await caches.open(offlineCacheName(account))).match(context.request);
    return saved ?? fallback(context);
  };
}
const path = (test) => ({ url }) => url.origin === self.location.origin && test(url.pathname);
const expiring = (maxEntries, maxAgeSeconds) => new ExpirationPlugin({ maxEntries, maxAgeSeconds, purgeOnQuotaError: true });

// 1. Operations, Cloudflare and Access sign-in.
registerRoute(path((p) => p.startsWith("/ops") || p.startsWith("/cdn-cgi/")), new NetworkOnly());
// 2. Sync, RUM and who-am-I (POST requests are never routed, so they always reach the network).
registerRoute(path((p) => p.startsWith("/api/v1/sync") || p === "/api/v1/rum" || p === "/api/v1/me"), new NetworkOnly());
// 4. Archive freshness must not show a past value as current.
registerRoute(path((p) => p === "/api/v1/text/status"), new NetworkOnly());
// 5. Text release pointers.
registerRoute(path((p) => /^\/api\/v1\/text\/release\/(?:novel|arcalive|manual|tuna)$/.test(p)), ownedStrategy(NetworkFirst, "text-pointer", { networkTimeoutSeconds: 3 }));
// 6–7. Immutable release manifests and indexes.
// One expiry for the shared cache, so manifests count toward (and leave by) the same limit.
const textMetaExpiry = expiring(200);
registerRoute(path((p) => p.startsWith("/api/v1/text/release-manifest/")), ownedStrategy(CacheFirst, "text-meta", { plugins: [textMetaExpiry] }));
registerRoute(path((p) => p.startsWith("/api/v1/text/index/")), ownedStrategy(CacheFirst, "text-meta", { plugins: [textMetaExpiry] }));
// 8. Immutable text objects.
registerRoute(path((p) => p.startsWith("/api/v1/text/object/")),
  savedFirst(ownedStrategy(CacheFirst, "text-objects", { plugins: [expiring(1000, 30 * DAY)] })));
// 9. Media (GET), with ranges for video. Only versioned URLs (?v=<R2 ETag>) are immutable: an
// archived image may be replaced under the same key (2026-10-09 review ④).
const versionedMedia = ({ url }) => url.origin === self.location.origin &&
  url.pathname.startsWith("/api/v1/text/media/") && url.searchParams.has("v");
registerRoute(versionedMedia, ownedStrategy(CacheFirst, "media", {
  plugins: [new CacheableResponsePlugin({ statuses: [200] }), new RangeRequestsPlugin(), expiring(1000, 30 * DAY)],
}));
// 10. The archive pointer.
registerRoute(path((p) => p === "/archive/release.json"), ownedStrategy(NetworkFirst, "archive-pointer", { networkTimeoutSeconds: 3 }));
// 11. Content-addressed archive objects (.json.zst replays from the cache, spike S3).
registerRoute(path((p) => p.startsWith("/archive/")),
  savedFirst(ownedStrategy(CacheFirst, "archive", { plugins: [expiring(1000, 30 * DAY)] })));
// 12. Versioned fonts and vendor bundles never change under the same path.
registerRoute(path((p) => /^\/(?:fonts|vendor)\/[a-z0-9-]+@\d+(?:\.\d+){0,2}\//.test(p)),
  new CacheFirst({ cacheName: "static-v", plugins: [guard] }));
// 13. The app shell.
precacheAndRoute(shell);
cleanupOutdatedCaches();
// 14. Other navigations: the network, else the cached shell (the page shows the offline banner).
const shellRequest = () => caches.match("/", { ignoreSearch: true });
registerRoute(new NavigationRoute(async (context) => {
  try {
    // Every SPA URL caches its own copy of the same shell: keep only the recent few.
    const response = await new NetworkFirst({ cacheName: "pages", networkTimeoutSeconds: 4, plugins: [guard, expiring(30, 7 * DAY)] }).handle(context);
    if (response) return response;
  } catch { /* offline */ }
  return (await shellRequest()) ?? Response.error();
}, { denylist: [/^\/ops/, /^\/cdn-cgi\//] }));

// Saving a work for offline reading (§12.6.2): the page sends the work's files; four at a time
// they go into the owner's offline cache, files already there are skipped (so 이어서 저장 resumes),
// and progress goes back to the pages. One failed file leaves the save partial, never complete.
const saves = new Map();
// Size of a body without holding it: a stored Content-Length, else the stream counted chunk by chunk.
// arrayBuffer() kept whole files in memory, four at a time (2026-10-09 review: 4 × 64 MiB).
async function bodyBytes(response) {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isSafeInteger(declared) && declared >= 0 && response.headers.get("Content-Encoding") === null) {
    await response.body?.cancel();
    return declared;
  }
  let total = 0;
  const reader = response.body?.getReader();
  for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader.read()) total += chunk.value.byteLength;
  return total;
}
const ownedTasks = new Map();
const deletingOwners = new Set();
let cacheEpoch = 0;
const deletedAt = new Map();
async function saveOffline({ id, urls, requires = [] }, clientId, account, task) {
  const cache = await caches.open(offlineCacheName(account));
  const statics = await caches.open("static-v");
  let done = 0;
  let failed = 0;
  let requiredFailed = 0;
  let bytes = 0;
  const queue = [...urls];
  const report = (type) => tell({ type, id, done, failed, requiredFailed, total: urls.length, bytes }, clientId);
  async function take() {
    while (queue.length && !task.cancelled) {
      const url = queue.shift();
      try {
        const cached = await cache.match(url);
        if (cached) {
          bytes += await bodyBytes(cached);
        } else {
          const response = await fetch(url, { credentials: "same-origin", signal: task.controller.signal });
          if (response.status !== 200 || authFailure(new Request(url), response)) {
            if (authFailure(new Request(url), response)) tell({ type: "auth-expired", url }, clientId);
            throw new Error(String(response.status));
          }
          if (task.cancelled) break;
          // Both branches of the tee are read together, so neither buffers the whole body.
          const [size] = await Promise.all([bodyBytes(response.clone()), cache.put(url, response)]);
          bytes += size;
        }
        done += 1;
      } catch {
        failed += 1;
      }
      if (!task.cancelled) report("offline-progress");
    }
  }
  // The fonts and modules a saved work needs to open offline.
  for (const url of requires) {
    if (task.cancelled) break;
    try {
      const request = new Request(new URL(url, self.location.origin));
      let response = await statics.match(request);
      if (!cacheable(request, response)) {
        if (response) await statics.delete(request);
        response = await fetch(request, { signal: task.controller.signal });
      }
      if (!cacheable(request, response)) {
        throw new Error("Required asset unavailable");
      }
      if (!task.cancelled) await statics.put(request, response);
    } catch {
      // Fonts have a fallback; imported modules are required for a cold offline start.
      if (url.endsWith(".js") && !task.cancelled) requiredFailed += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, take));
  report(task.cancelled ? "offline-cancelled" : "offline-done");
}

async function startSave(data, clientId) {
  const started = cacheEpoch;
  const account = await ownerFor(clientId);
  if (deletingOwners.has(account) || (deletedAt.get(account) ?? 0) > started) {
    tell({ type: "offline-cancelled", id: data.id, done: 0, failed: 0, total: data.urls.length, bytes: 0 }, clientId);
    return;
  }
  const key = `${account}:${data.id}`;
  const previous = saves.get(key);
  if (previous) { previous.cancelled = true; previous.controller.abort(); }
  const task = { cancelled: false, controller: new AbortController() };
  saves.set(key, task);
  task.promise = (async () => {
    await previous?.promise.catch(() => {});
    if (task.cancelled || deletingOwners.has(account)) return;
    await saveOffline(data, clientId, account, task);
  })().finally(() => {
    if (saves.get(key) === task) saves.delete(key);
  });
  return task.promise;
}

async function cancelSave(key) {
  const task = saves.get(key);
  if (!task) return;
  task.cancelled = true;
  task.controller.abort();
  await task.promise.catch(() => {});
}

async function deleteOffline({ id, urls }, clientId) {
  const account = await ownerFor(clientId);
  await cancelSave(`${account}:${id}`);
  const cache = await caches.open(offlineCacheName(account));
  await Promise.all(urls.map((url) => cache.delete(url)));
  tell({ type: "offline-deleted", id }, clientId);
}

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  const complete = (work) => event.waitUntil(Promise.resolve(work).then(
    () => event.ports[0]?.postMessage({ ok: true }),
    (error) => event.ports[0]?.postMessage({ ok: false, error: String(error) }),
  ));
  if (data.type === "SAVE_OFFLINE" && typeof data.id === "string" && Array.isArray(data.urls)) {
    event.waitUntil(startSave(data, event.source?.id));
    return;
  }
  if (data.type === "DELETE_OFFLINE" && typeof data.id === "string" && Array.isArray(data.urls)) {
    complete(deleteOffline(data, event.source?.id));
    return;
  }
  if (data.type === "CANCEL_OFFLINE" && typeof data.id === "string") {
    complete(ownerFor(event.source?.id).then((account) => cancelSave(`${account}:${data.id}`)));
    return;
  }
  if (data.type === "RESET_OWNER" && /^[a-f0-9]{16}$/.test(data.owner ?? "")) {
    complete((async () => {
      const account = data.owner;
      deletingOwners.add(account);
      deletedAt.set(account, ++cacheEpoch);
      tell({ type: "offline-owner-reset", owner: account, records: data.records === true });
      try {
        await Promise.all([...saves.keys()].filter((key) => key.startsWith(`${account}:`)).map(cancelSave));
        await Promise.all(ownedTasks.get(account) ?? []);
        for (const name of await caches.keys()) if (name.endsWith(`-${account}`)) await caches.delete(name);
      } finally { deletingOwners.delete(account); }
    })());
    return;
  }
  if (data.type === "SET_OWNER" && /^(?:[a-f0-9]{16}|anon)$/.test(data.owner ?? "")) {
    if (event.source?.id) owners.set(event.source.id, data.owner);
    event.waitUntil((async () => {
      await ownerLoaded;
      owner = data.owner;
      const cache = await caches.open(OWNER_CACHE);
      await cache.put("/owner", new Response(data.owner));
      if (event.source?.id) await cache.put(`/owner/${event.source.id}`, new Response(data.owner));
      const live = new Set((await self.clients.matchAll({ includeUncontrolled: true })).map((client) => client.id));
      for (const request of await cache.keys()) {
        const id = new URL(request.url).pathname.slice("/owner/".length);
        if (new URL(request.url).pathname.startsWith("/owner/") && !live.has(id)) await cache.delete(request);
      }
    })());
  } else if (data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
