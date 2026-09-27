import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { arcaPathKey, arcaPostUrl } from "../public/arca-media.js";
import { sniffImageType, textMediaResponse } from "../src/text-media.js";

// D1 over node:sqlite with the real migration, so the SQL is exercised as deployed.
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0008_text_media.sql", import.meta.url), "utf8"));
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    first: async () => db.prepare(sql).get(...values) ?? null,
    run: async () => db.prepare(sql).run(...values),
  });
  return { prepare: (sql) => statement(sql), db };
}

function r2() {
  const objects = new Map();
  return {
    objects,
    head: async (key) => (objects.has(key) ? { httpEtag: '"e"' } : null),
    get: async (key) => (objects.has(key) ? { body: objects.get(key), httpEtag: '"e"' } : null),
    put: async (key, value) => { objects.set(key, value); },
  };
}

const post = "https://arca.live/b/monmusu/102379431";
const pathA = "20240329sac/7e4f8557ceebfb10692c4b35f198e52334ddc010b6026c5bfd7da73c636b3119.png";
const pathB = "20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png";
const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 1, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 9, 9]);

function call(env, path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  if (!init.noHeader && init.method && init.method !== "GET") headers.set("X-ReDSTM-Media", "1");
  return textMediaResponse(new Request(`https://archive.example${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  }), env);
}

test("derives stable Arcalive path keys and canonical post URLs", () => {
  assert.equal(
    arcaPathKey("https://ac-o.arca.live/20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp?expires=1&key=k&type=orig"),
    "20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp",
  );
  assert.equal(arcaPathKey("https://ac.namu.la/20230607sac/ca7acfbf53a12de0.webp"), "20230607sac/ca7acfbf53a12de0.webp");
  assert.equal(arcaPathKey("https://evil.example/20230607sac/ca7acfbf53a12de0.webp"), null);
  assert.equal(arcaPathKey("https://ac-o.arca.live/../etc/passwd"), null);
  assert.equal(arcaPostUrl("https://arca.live/b/monmusu/102379431?p=1#c"), post);
  assert.equal(arcaPostUrl("https://arca.live/b/monmusu/"), null);
  assert.equal(arcaPostUrl("https://evil.example/b/monmusu/1"), null);
});

test("queues a read post's missing images, hands them out newest first, and records results", async () => {
  const env = { CONTROL_DB: d1(), TEXT_ARCHIVE: r2() };
  assert.equal((await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: post, paths: [pathA] }, noHeader: true })).status, 403);
  assert.equal((await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: "https://evil.example/b/x/1", paths: [pathA] } })).status, 400);
  assert.equal((await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: post, paths: ["../x"] } })).status, 400);
  const queued = await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: `${post}?p=1`, paths: [pathA, pathB, pathA] } });
  assert.deepEqual(await queued.json(), { queued: 2 });
  await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: "https://arca.live/b/monmusu/2", paths: [pathB] } });
  const list = await (await call(env, "/api/v1/text/media/queue?limit=5")).json();
  assert.equal(list.posts.length, 2);
  assert.equal(list.counts.pending, 2);
  const failed = await call(env, "/api/v1/text/media/queue/result", { method: "POST", json: { post_url: post, status: "failed", error: "login required" } });
  assert.equal(failed.status, 200);
  const row = env.CONTROL_DB.db.prepare("SELECT status, attempts, last_error FROM text_media_queue WHERE post_url = ?").get(post);
  assert.deepEqual({ ...row }, { status: "pending", attempts: 1, last_error: "login required" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await call(env, "/api/v1/text/media/queue/result", { method: "POST", json: { post_url: post, status: "failed" } });
  }
  assert.equal(env.CONTROL_DB.db.prepare("SELECT status FROM text_media_queue WHERE post_url = ?").get(post).status, "failed");
  // Reading the post again gives it fresh attempts.
  await call(env, "/api/v1/text/media/queue", { method: "POST", json: { post_url: post, paths: [pathA] } });
  assert.equal(env.CONTROL_DB.db.prepare("SELECT status, attempts FROM text_media_queue WHERE post_url = ?").get(post).attempts, 0);
});

test("stores validated images once by content hash and resolves them by CDN path", async () => {
  const env = { CONTROL_DB: d1(), TEXT_ARCHIVE: r2() };
  const put = (path, body, headers = {}) => call(env, `/api/v1/text/media/object?path=${encodeURIComponent(path)}`, {
    method: "PUT", body, headers: { "Content-Type": "image/webp", "X-Media-Width": "800", "X-Media-Height": "1200", ...headers },
  });
  assert.equal((await put("../x.webp", webp)).status, 400);
  assert.equal((await put(pathA, webp, { "Content-Type": "image/png" })).status, 415);
  assert.equal((await put(pathA, new TextEncoder().encode("<html>"), { "Content-Type": "text/html" })).status, 415);
  assert.equal((await put(pathA, webp, { "X-Media-Width": "0" })).status, 400);
  const stored = await put(pathA, webp);
  assert.equal(stored.status, 201);
  const { url } = await stored.json();
  assert.match(url, /^\/api\/v1\/text\/media\/[a-f0-9]{64}\.webp$/);
  assert.equal((await put(pathB, webp)).status, 201);
  assert.equal(env.TEXT_ARCHIVE.objects.size, 1, "identical bytes are stored once");
  const resolved = await (await call(env, "/api/v1/text/media/resolve", { method: "POST", json: { paths: [pathA, "20990101sac/0123456789abcdef.png"] } })).json();
  assert.deepEqual(Object.keys(resolved.media), [pathA]);
  assert.equal(resolved.media[pathA].width, 800);
  const served = await call(env, url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("Content-Type"), "image/webp");
  assert.match(served.headers.get("Cache-Control"), /immutable/);
  assert.equal((await call(env, url.replace(/[a-f0-9]{64}/, "0".repeat(64)))).status, 404);
  assert.equal((await call(env, url, { method: "DELETE" })).status, 405);
});

test("recognises image types by magic bytes", () => {
  assert.equal(sniffImageType(webp.buffer), "image/webp");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).buffer), "image/png");
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer), "image/jpeg");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a").buffer), "image/gif");
  assert.equal(sniffImageType(new TextEncoder().encode("<svg").buffer), null);
});
