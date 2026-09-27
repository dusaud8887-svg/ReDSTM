import assert from "node:assert/strict";
import test from "node:test";

// Drives the extension's background run() with stand-ins for chrome.*, fetch, and the image
// APIs, to check the whole queue → post page → image → upload → report flow.

const base = "https://redstm.example";
const post = "https://arca.live/b/monmusu/102379431";
const denied = "https://arca.live/b/monmusu/2";
const walled = "https://arca.live/b/monmusu/3";
const path = "20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp";
const gone = "20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png";
const placeholder = new Uint8Array([7, 7, 7]);
const calls = [];
const storage = { baseUrl: base, auto: true };

globalThis.chrome = {
  storage: { local: {
    get: async (keys) => (typeof keys === "string" ? { [keys]: storage[keys] } : { ...(Array.isArray(keys) ? {} : keys), ...storage }),
    set: async (value) => Object.assign(storage, value),
  } },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};
globalThis.createImageBitmap = async () => ({ width: 3200, height: 1600, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) { Object.assign(this, { width, height }); }
  getContext() { return { drawImage() {} }; }
  async convertToBlob() { return new Blob([new TextEncoder().encode("RIFF0000WEBPVP8 ")], { type: "image/webp" }); }
};
globalThis.setTimeout = (callback) => { callback(); return 0; };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
  const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (url === `${base}/api/v1/text/media/queue?limit=5`) {
    return json({ posts: [{ post_url: post, paths: [path, gone] }, { post_url: denied, paths: [path] }, { post_url: walled, paths: [path] }], counts: { pending: 3 } });
  }
  if (url === post) return new Response(`<img data-originalurl="//ac-o.arca.live/${path}?expires=9&amp;key=fresh">`);
  if (url === denied) return new Response(`<img src="https://ac-o.arca.live/${path}?expires=9&amp;key=old&amp;type=orig">`);
  if (url === walled) return new Response("Unavailable For Legal Reasons", { status: 451 });
  if (url.includes("key=fresh")) return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  if (url.includes("key=old")) return new Response(new Blob([placeholder], { type: "image/webp" }));
  if (url.startsWith(`${base}/api/v1/text/media/`)) return json({ ok: true });
  throw new Error(`unexpected fetch ${url}`);
};

test("archives a post's images through the reader's own session and reports each post", async () => {
  const lib = await import("../../extension/redstm-arca-media/lib.js");
  // Pretend the stale-key response is Arcalive's placeholder.
  const original = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = async (algorithm, data) => {
    const bytes = new Uint8Array(data);
    if (bytes.length === 3 && bytes[0] === 7) return Uint8Array.from(Buffer.from(lib.DENIED_PLACEHOLDER_SHA256, "hex")).buffer;
    return original(algorithm, data);
  };
  const { run } = await import("../../extension/redstm-arca-media/background.js");
  await run();

  const pageFetch = calls.find((call) => call.url === post);
  assert.ok(pageFetch, "the post page was opened");
  const imageFetch = calls.find((call) => call.url.includes("key=fresh"));
  assert.equal(new URL(imageFetch.url).searchParams.get("type"), "orig");
  const uploads = calls.filter((call) => call.method === "PUT");
  assert.equal(uploads.length, 1, "only the real image is uploaded; the placeholder and the missing path are not");
  assert.equal(new URL(uploads[0].url).searchParams.get("path"), path);
  assert.equal(uploads[0].headers["Content-Type"], "image/webp");
  assert.equal(uploads[0].headers["X-Media-Width"], "1600");
  assert.equal(uploads[0].headers["X-Media-Height"], "800");
  assert.equal(uploads[0].headers["X-ReDSTM-Media"], "1");
  const results = calls.filter((call) => call.url.endsWith("/queue/result")).map((call) => JSON.parse(call.body));
  assert.deepEqual(results.map(({ post_url, status }) => [post_url, status]), [[post, "done"], [denied, "failed"], [walled, "failed"]]);
  assert.match(results[2].error, /로그인/);
  assert.equal(storage.status.lastStored, 1);
  assert.equal(storage.status.lastFailed, 2);
});
