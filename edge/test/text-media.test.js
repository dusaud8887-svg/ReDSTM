import assert from "node:assert/strict";
import test from "node:test";

import { arcaPathKey } from "../public/arca-media.js";
import { textMediaResponse } from "../src/text-media.js";

function r2(entries = {}) {
  const objects = new Map(Object.entries(entries));
  const meta = (key) => ({ httpEtag: '"e"', httpMetadata: { contentType: objects.get(key).type } });
  return {
    objects,
    head: async (key) => (objects.has(key) ? meta(key) : null),
    get: async (key) => (objects.has(key) ? { ...meta(key), body: objects.get(key).body } : null),
  };
}

const pathA = "20240329sac/7e4f8557ceebfb10692c4b35f198e52334ddc010b6026c5bfd7da73c636b3119.png";
const pathB = "20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png";

function call(env, path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  return textMediaResponse(new Request(`https://archive.example${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  }), env);
}

test("derives stable Arcalive path keys", () => {
  assert.equal(
    arcaPathKey("https://ac-o.arca.live/20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp?expires=1&key=k&type=orig"),
    "20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp",
  );
  assert.equal(arcaPathKey("https://ac.namu.la/20230607sac/ca7acfbf53a12de0.webp"), "20230607sac/ca7acfbf53a12de0.webp");
  assert.equal(arcaPathKey("https://evil.example/20230607sac/ca7acfbf53a12de0.webp"), null);
  assert.equal(arcaPathKey("https://ac-o.arca.live/../etc/passwd"), null);
  // Older posts use a two-character directory instead of a date code.
  assert.equal(arcaPathKey("https://ac-o.arca.live/ba/ca7acfbf53a12de0.jpg?expires=1"), "ba/ca7acfbf53a12de0.jpg");
  assert.equal(arcaPathKey("https://ac-o.arca.live/b/ca7acfbf53a12de0.jpg"), null);
});

test("resolves only the path keys archived in R2", async () => {
  const env = { TEXT_ARCHIVE: r2({ [`media/arca/${pathA}`]: { type: "image/webp", body: "x" } }) };
  const response = await call(env, "/api/v1/text/media/resolve", { method: "POST", json: { paths: [pathA, pathB, pathA] } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { media: { [pathA]: { url: `/api/v1/text/media/arca/${pathA}` } } });
  assert.equal((await call(env, "/api/v1/text/media/resolve", { method: "POST", json: { paths: ["../x"] } })).status, 400);
  assert.equal((await call(env, "/api/v1/text/media/resolve", { method: "POST", json: { paths: [] } })).status, 400);
  assert.equal((await call(env, "/api/v1/text/media/resolve", { method: "POST", json: { paths: Array(41).fill(pathA) } })).status, 400);
  assert.equal((await call(env, "/api/v1/text/media/resolve", { method: "POST", body: JSON.stringify({ paths: [pathA] }) })).status, 400);
});

test("rejects oversized media lookups before R2 access, including chunked bodies", async () => {
  let heads = 0;
  const env = { TEXT_ARCHIVE: { head: async () => { heads += 1; } } };
  const declared = await call(env, "/api/v1/text/media/resolve", {
    method: "POST", headers: { "Content-Length": "20000" }, json: { paths: [pathA] },
  });
  assert.equal(declared.status, 413);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17000)); },
    cancel() { cancelled = true; },
  });
  const chunked = await textMediaResponse(new Request("https://archive.example/api/v1/text/media/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half",
  }), env);
  assert.equal(chunked.status, 413);
  assert.equal(cancelled, true);
  assert.equal(heads, 0);
});

test("serves archived images with their stored type and immutable caching", async () => {
  const env = { TEXT_ARCHIVE: r2({
    [`media/arca/${pathA}`]: { type: "image/webp", body: "webp-bytes" },
    [`media/arca/${pathB}`]: { type: "text/html", body: "<script>" },
  }) };
  const image = await call(env, `/api/v1/text/media/arca/${pathA}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/webp");
  assert.match(image.headers.get("Cache-Control"), /immutable/);
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await image.text(), "webp-bytes");
  const head = await call(env, `/api/v1/text/media/arca/${pathA}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await call(env, `/api/v1/text/media/arca/${pathB}`)).status, 404);
  assert.equal((await call(env, "/api/v1/text/media/arca/20240329sac/zz.png")).status, 404);
  assert.equal((await call(env, `/api/v1/text/media/arca/${pathA}`, { method: "PUT", body: "x" })).status, 405);
});

test("has no write, queue or upload routes", async () => {
  const env = { TEXT_ARCHIVE: r2() };
  for (const [method, path] of [
    ["POST", "/api/v1/text/media/queue"],
    ["GET", "/api/v1/text/media/queue"],
    ["POST", "/api/v1/text/media/queue/result"],
    ["PUT", `/api/v1/text/media/object?path=${pathA}`],
    ["GET", "/api/v1/text/media/resolve"],
  ]) {
    assert.equal((await call(env, path, { method, json: method === "GET" ? undefined : {} })).status, 404, `${method} ${path}`);
  }
});
