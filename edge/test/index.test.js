import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker from "../src/index.js";

const username = "reader";
const password = "test-secret";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

function archiveObject(body = "payload", range = null) {
  return {
    body,
    httpEtag: '"etag"',
    range,
    size: body.length,
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/octet-stream");
    },
  };
}

function environment(overrides = {}) {
  return {
    VIEWER_USERNAME: username,
    VIEWER_PASSWORD: password,
    ARCHIVE: {
      async get() {
        return archiveObject();
      },
      async head() {
        return archiveObject();
      },
    },
    ASSETS: {
      async fetch() {
        return new Response("Not found", { status: 404 });
      },
    },
    ...overrides,
  };
}

function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", authorization);
  return new Request(`https://archive.example${path}`, { ...options, headers });
}

test("rejects missing or invalid credentials", async () => {
  const missing = await worker.fetch(new Request("https://archive.example/health"), environment());
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("WWW-Authenticate"), /Basic/);

  const unconfigured = await worker.fetch(
    new Request("https://archive.example/health"),
    environment({ VIEWER_PASSWORD: "" }),
  );
  assert.equal(unconfigured.status, 500);
});

test("validates Cloudflare Access JWTs and rejects the wrong audience", async () => {
  const issuer = "https://redstm-test.cloudflareaccess.com";
  const audience = "redstm-audience";
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  };
  const token = await new SignJWT({ email: "reader@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const accessEnvironment = environment({
    VIEWER_USERNAME: "",
    VIEWER_PASSWORD: "",
    TEAM_DOMAIN: issuer,
    POLICY_AUD: audience,
  });
  try {
    const valid = await worker.fetch(
      new Request("https://archive.example/health", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      accessEnvironment,
    );
    assert.equal(valid.status, 200);

    const invalid = await worker.fetch(
      new Request("https://archive.example/health", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      { ...accessEnvironment, POLICY_AUD: "wrong-audience" },
    );
    assert.equal(invalid.status, 403);
    assert.equal(invalid.headers.has("WWW-Authenticate"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streams private objects with safe Zstandard and range headers", async () => {
  let options;
  const env = environment({
    ARCHIVE: {
      async get(_key, received) {
        options = received;
        return archiveObject(
          "0123456789",
          received.range ? { offset: 2, length: 4 } : { offset: 0, length: 10 },
        );
      },
      async head() {
        return archiveObject("0123456789");
      },
    },
  });
  const result = await worker.fetch(
    request("/archive/warc/run.warc.gz", { headers: { Range: "bytes=2-5" } }),
    env,
  );

  assert.equal(result.status, 206);
  assert.equal(result.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(result.headers.get("Cache-Control"), "private, immutable");
  assert.equal(options.range.get("Range"), "bytes=2-5");

  const json = await worker.fetch(request("/archive/posts/board/1-hash.json.zst"), env);
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("Content-Encoding"), "zstd");
  assert.equal(json.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(options.range, undefined);
});

test("handles health, missing objects, methods, and invalid keys", async () => {
  const env = environment({
    ARCHIVE: {
      async get() {
        return null;
      },
      async head() {
        return null;
      },
    },
  });

  assert.equal((await worker.fetch(request("/health"), env)).status, 200);
  assert.equal((await worker.fetch(request("/archive/missing.json.zst"), env)).status, 404);
  assert.equal((await worker.fetch(request("/archive/%5Csecret"), env)).status, 400);
  assert.equal((await worker.fetch(request("/archive/release.json", { method: "POST" }), env)).status, 405);
});

test("release.json is served as a no-cache pointer", async () => {
  const result = await worker.fetch(request("/archive/release.json"), environment());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-cache");
});

test("release.json exposes R2 uploaded as Last-Modified", async () => {
  const uploaded = new Date("2026-07-12T03:00:00Z");
  const env = environment({
    ARCHIVE: {
      async get() {
        return { ...archiveObject(), uploaded };
      },
      async head() {
        return { ...archiveObject(), uploaded };
      },
    },
  });
  const result = await worker.fetch(request("/archive/release.json"), env);
  assert.equal(result.headers.get("Last-Modified"), uploaded.toUTCString());
});

test("serves authenticated static assets with security headers", async () => {
  let received;
  const env = environment({
    ASSETS: {
      async fetch(assetRequest) {
        received = assetRequest;
        return new Response("<!doctype html><title>ReDSTM</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  });

  const result = await worker.fetch(request("/"), env);
  assert.equal(result.status, 200);
  assert.equal(new URL(received.url).pathname, "/");
  assert.match(result.headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.equal(result.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(await result.text(), /ReDSTM/);

  const operations = await worker.fetch(request("/ops"), env);
  assert.equal(operations.status, 200);
  assert.equal(new URL(received.url).pathname, "/ops");
  assert.match(operations.headers.get("Content-Security-Policy"), /connect-src 'self'/);
});
