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

// The signed-in owner (ownerHash from /api/v1/me, sent by the page) suffixes every cache that holds
// reading data, so another account on this device never reads or overwrites it (§12.6.3).
async function loadOwner() {
  const saved = await (await caches.open(OWNER_CACHE)).match("/owner");
  if (saved) owner = await saved.text();
}
const ownerLoaded = loadOwner().catch(() => {});
const named = (base) => `${base}-${owner}`;
const offlineCacheName = () => named("offline-v1");

function tell(message) {
  void self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage(message);
  });
}

const api = (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/archive/");
function authFailure(request, response) {
  if (!response) return false;
  if (response.type === "opaqueredirect" || response.redirected || [401, 403].includes(response.status) ||
      (response.status >= 300 && response.status < 400)) return true;
  return api(new URL(request.url)) && (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html");
}
const guard = {
  async fetchDidSucceed({ request, response }) {
    if (authFailure(request, response)) tell({ type: "auth-expired", url: request.url });
    return response;
  },
  async cacheWillUpdate({ request, response }) {
    return response && response.status === 200 && !authFailure(request, response) ? response : null;
  },
};

// Strategies resolve their cache name per request, after the owner is known.
function ownedStrategy(Strategy, base, options = {}) {
  return async (context) => {
    await ownerLoaded;
    return new Strategy({ ...options, cacheName: named(base), plugins: [guard, ...(options.plugins ?? [])] }).handle(context);
  };
}
// A work saved for offline reading answers first; otherwise the runtime cache.
function savedFirst(fallback) {
  return async (context) => {
    await ownerLoaded;
    const saved = await (await caches.open(offlineCacheName())).match(context.request);
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
registerRoute(path((p) => /^\/api\/v1\/text\/release\/(?:novel|arcalive|manual)$/.test(p)), ownedStrategy(NetworkFirst, "text-pointer", { networkTimeoutSeconds: 3 }));
// 6–7. Immutable release manifests and indexes.
registerRoute(path((p) => p.startsWith("/api/v1/text/release-manifest/")), ownedStrategy(CacheFirst, "text-meta"));
registerRoute(path((p) => p.startsWith("/api/v1/text/index/")), ownedStrategy(CacheFirst, "text-meta", { plugins: [expiring(200)] }));
// 8. Immutable text objects.
registerRoute(path((p) => p.startsWith("/api/v1/text/object/")),
  savedFirst(ownedStrategy(CacheFirst, "text-objects", { plugins: [expiring(1000, 30 * DAY)] })));
// 9. Media (GET), with ranges for video.
registerRoute(path((p) => p.startsWith("/api/v1/text/media/")), ownedStrategy(CacheFirst, "media", {
  plugins: [new CacheableResponsePlugin({ statuses: [200] }), new RangeRequestsPlugin()],
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
    const response = await new NetworkFirst({ cacheName: "pages", networkTimeoutSeconds: 4, plugins: [guard] }).handle(context);
    if (response) return response;
  } catch { /* offline */ }
  return (await shellRequest()) ?? Response.error();
}, { denylist: [/^\/ops/, /^\/cdn-cgi\//] }));

// Saving a work for offline reading (§12.6.2): the page sends the work's files; four at a time
// they go into the owner's offline cache, files already there are skipped (so 이어서 저장 resumes),
// and progress goes back to the pages. One failed file leaves the save partial, never complete.
const cancelled = new Set();
async function saveOffline({ id, urls, requires = [] }) {
  await ownerLoaded;
  cancelled.delete(id);
  const cache = await caches.open(offlineCacheName());
  const statics = await caches.open("static-v");
  let done = 0;
  let failed = 0;
  let bytes = 0;
  const queue = [...urls];
  const report = (type) => tell({ type, id, done, failed, total: urls.length, bytes });
  async function take() {
    while (queue.length && !cancelled.has(id)) {
      const url = queue.shift();
      try {
        const cached = await cache.match(url);
        if (cached) {
          bytes += (await cached.clone().arrayBuffer()).byteLength;
        } else {
          const response = await fetch(url, { credentials: "same-origin" });
          if (response.status !== 200 || authFailure(new Request(url), response)) {
            if (authFailure(new Request(url), response)) tell({ type: "auth-expired", url });
            throw new Error(String(response.status));
          }
          bytes += (await response.clone().arrayBuffer()).byteLength;
          await cache.put(url, response);
        }
        done += 1;
      } catch {
        failed += 1;
      }
      report("offline-progress");
    }
  }
  // The fonts and modules a saved work needs to open offline.
  for (const url of requires) {
    try {
      if (!(await statics.match(url))) await statics.add(url);
    } catch { /* a missing font falls back; the text still opens */ }
  }
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, take));
  report(cancelled.has(id) ? "offline-cancelled" : "offline-done");
}

async function deleteOffline({ id, urls }) {
  await ownerLoaded;
  cancelled.add(id);
  const cache = await caches.open(offlineCacheName());
  await Promise.all(urls.map((url) => cache.delete(url)));
  tell({ type: "offline-deleted", id });
}

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  if (data.type === "SAVE_OFFLINE" && typeof data.id === "string" && Array.isArray(data.urls)) {
    event.waitUntil(saveOffline(data));
    return;
  }
  if (data.type === "DELETE_OFFLINE" && typeof data.id === "string" && Array.isArray(data.urls)) {
    event.waitUntil(deleteOffline(data));
    return;
  }
  if (data.type === "CANCEL_OFFLINE" && typeof data.id === "string") {
    cancelled.add(data.id);
    return;
  }
  if (data.type === "SET_OWNER" && /^(?:[a-f0-9]{16}|anon)$/.test(data.owner ?? "")) {
    event.waitUntil((async () => {
      owner = data.owner;
      await (await caches.open(OWNER_CACHE)).put("/owner", new Response(owner));
    })());
  } else if (data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
