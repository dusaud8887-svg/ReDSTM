import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker from "../src/index.js";

globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor() {
    super();
  }
};

const username = "reader";
const password = "test-secret";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const workerVersionMetadata = {
  id: "12345678-1234-1234-1234-123456789abc",
  tag: `git-${"a".repeat(40)}`,
  timestamp: "2026-07-12T00:00:00.000Z",
};

function archiveObject(body = "payload", range = null) {
  return {
    body: new Blob([body]).stream(),
    httpEtag: '"etag"',
    range,
    size: body.length,
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/octet-stream");
    },
  };
}

function workerFetch(workerRequest, env) {
  return worker.fetch(workerRequest, env, {
    waitUntil(promise) {
      void promise.catch((error) => assert.fail(error));
    },
  });
}

function environment(overrides = {}) {
  return {
    VIEWER_USERNAME: username,
    VIEWER_PASSWORD: password,
    CF_VERSION_METADATA: workerVersionMetadata,
    ARCHIVE: {
      async get() {
        return archiveObject();
      },
      async head() {
        return archiveObject();
      },
    },
    TEXT_ARCHIVE: {
      async get() { return archiveObject("private text"); },
      async head() { return archiveObject("private text"); },
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
  const missing = await workerFetch(new Request("https://archive.example/health"), environment());
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("WWW-Authenticate"), /Basic/);

  const unconfigured = await workerFetch(
    new Request("https://archive.example/health"),
    environment({ VIEWER_PASSWORD: "" }),
  );
  assert.equal(unconfigured.status, 500);
});

test("validates Cloudflare Access JWTs and rejects the wrong audience", async () => {
  const issuer = "https://redstm-test.cloudflareaccess.com";
  const audience = "redstm-audience";
  const runnerAudience = "redstm-runner-audience";
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
  const runnerToken = await new SignJWT({ common_name: "oracle-runner" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(runnerAudience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const accessEnvironment = environment({
    VIEWER_USERNAME: "",
    VIEWER_PASSWORD: "",
    TEAM_DOMAIN: issuer,
    POLICY_AUD: audience,
    RUNNER_POLICY_AUD: runnerAudience,
  });
  try {
    const valid = await workerFetch(
      new Request("https://archive.example/health", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      accessEnvironment,
    );
    assert.equal(valid.status, 200);

    const meRequest = (method = "GET", assertion = token) => new Request("https://archive.example/api/v1/me", {
      method, headers: { "Cf-Access-Jwt-Assertion": assertion },
    });
    const me = await workerFetch(meRequest(), accessEnvironment);
    assert.equal(me.status, 200);
    const emailHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("reader@example.test")));
    const expectedOwner = Array.from(emailHash, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
    assert.deepEqual(await me.json(), { ownerHash: expectedOwner });
    assert.equal(me.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await workerFetch(meRequest("POST"), accessEnvironment)).status, 405);
    assert.equal((await workerFetch(meRequest("GET", runnerToken), accessEnvironment)).status, 403);
    assert.equal((await workerFetch(new Request("https://archive.example/api/v1/me"), accessEnvironment)).status, 403);
    const secondUser = await new SignJWT({ email: "other@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    assert.notEqual((await (await workerFetch(meRequest("GET", secondUser), accessEnvironment)).json()).ownerHash, expectedOwner);

    const runnerHeaders = {
      "X-Request-Id": "018f47a8-7a2d-7c11-8f44-89d95775c6ea",
      "X-ReDSTM-Protocol": "1",
    };
    const readerDenied = await workerFetch(
      new Request(
        "https://archive.example/api/v1/runner/release-smoke?expected_release_sha256=invalid",
        { headers: { ...runnerHeaders, "Cf-Access-Jwt-Assertion": token } },
      ),
      accessEnvironment,
    );
    assert.equal(readerDenied.status, 403);
    const runnerAccepted = await workerFetch(
      new Request(
        "https://archive.example/api/v1/runner/release-smoke?expected_release_sha256=invalid",
        { headers: { ...runnerHeaders, "Cf-Access-Jwt-Assertion": runnerToken } },
      ),
      accessEnvironment,
    );
    assert.equal(runnerAccepted.status, 400);
    assert.equal((await runnerAccepted.json()).error.code, "invalid_expected_release_sha256");

    const runnerDeniedFromTextLibrary = await workerFetch(
      new Request(`https://archive.example/api/v1/text/object/${"a".repeat(64)}`, {
        headers: { "Cf-Access-Jwt-Assertion": runnerToken },
      }),
      accessEnvironment,
    );
    assert.equal(runnerDeniedFromTextLibrary.status, 403);

    // Route roles also check the token kind, not only the Access audience.
    const sign = (claims, aud) => new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    for (const claims of [
      { email: "reader@example.test", sub: "user-id" },
      { email: "reader@example.test", common_name: "oracle-runner" },
      { sub: "" },
    ]) {
      const denied = await workerFetch(
        new Request(
          "https://archive.example/api/v1/runner/release-smoke?expected_release_sha256=invalid",
          { headers: { ...runnerHeaders, "Cf-Access-Jwt-Assertion": await sign(claims, runnerAudience) } },
        ),
        accessEnvironment,
      );
      assert.equal(denied.status, 403, JSON.stringify(claims));
    }
    for (const claims of [{ common_name: "oracle-runner", sub: "" }, { sub: "user-id" }]) {
      const userToken = await sign(claims, audience);
      const health = await workerFetch(
        new Request("https://archive.example/health", {
          headers: { "Cf-Access-Jwt-Assertion": userToken },
        }),
        accessEnvironment,
      );
      assert.equal(health.status, 403, JSON.stringify(claims));
      const opsDenied = await workerFetch(
        new Request("https://archive.example/api/v1/ops/overview", {
          headers: { ...runnerHeaders, "Cf-Access-Jwt-Assertion": userToken },
        }),
        accessEnvironment,
      );
      assert.equal(opsDenied.status, 403, JSON.stringify(claims));
    }

    const invalid = await workerFetch(
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

test("serves open-ended and suffix ranges with exact Content-Range", async () => {
  for (const [header, range, expected, length] of [
    ["bytes=4-", { offset: 4 }, "bytes 4-9/10", "6"],
    ["bytes=-3", { suffix: 3 }, "bytes 7-9/10", "3"],
    ["bytes=-30", { suffix: 30 }, "bytes 0-9/10", "10"],
  ]) {
    const env = environment({
      ARCHIVE: {
        async get() { return archiveObject("0123456789", range); },
        async head() { return archiveObject("0123456789"); },
      },
    });
    const result = await workerFetch(request("/archive/warc/run.warc.gz", { headers: { Range: header } }), env);
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Range"), expected);
    assert.equal(result.headers.get("Content-Length"), length);
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
  const result = await workerFetch(
    request("/archive/warc/run.warc.gz", { headers: { Range: "bytes=2-5" } }),
    env,
  );

  assert.equal(result.status, 206);
  assert.equal(result.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(result.headers.get("Content-Length"), "4");
  assert.equal(result.headers.get("Cache-Control"), "private, max-age=31536000, immutable");
  assert.equal(options.range.get("Range"), "bytes=2-5");

  const json = await workerFetch(request("/archive/posts/board/1-hash.json.zst"), env);
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("Content-Encoding"), "zstd");
  assert.equal(json.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(json.headers.get("Content-Length"), "10");
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

  assert.equal((await workerFetch(request("/health"), env)).status, 200);
  assert.equal((await workerFetch(request("/archive/missing.json.zst"), env)).status, 404);
  assert.equal((await workerFetch(request("/archive/%5Csecret"), env)).status, 400);
  assert.equal((await workerFetch(request("/archive/release.json", { method: "POST" }), env)).status, 405);
});

test("release.json is served as a no-cache pointer", async () => {
  const result = await workerFetch(request("/archive/release.json"), environment());
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
  const result = await workerFetch(request("/archive/release.json"), env);
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

  const result = await workerFetch(request("/"), env);
  assert.equal(result.status, 200);
  assert.equal(new URL(received.url).pathname, "/");
  assert.match(result.headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.match(result.headers.get("Content-Security-Policy"), /upgrade-insecure-requests/);
  assert.doesNotMatch(result.headers.get("Content-Security-Policy"), /img-src[^;]*data:/);
  // Text-archive [video] lines play from https sources; scripts and frames stay same-origin.
  assert.match(result.headers.get("Content-Security-Policy"), /media-src 'self' https:/);
  assert.match(result.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.equal(result.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(await result.text(), /ReDSTM/);

  const operations = await workerFetch(request("/ops"), env);
  assert.equal(operations.status, 200);
  assert.equal(new URL(received.url).pathname, "/ops");
  assert.match(operations.headers.get("Content-Security-Policy"), /connect-src 'self'/);
});

test("caches only successful versioned assets immutably and keeps me Access-only", async () => {
  const fetched = [];
  const env = environment({
    ASSETS: {
      async fetch(assetRequest) {
        fetched.push(new URL(assetRequest.url).pathname);
        return new Response("asset", { headers: { "Content-Type": "application/octet-stream" } });
      },
    },
  });
  for (const path of ["/fonts/pretendard@1.3.9/core.woff2", "/fonts/maruburi@1.000/maruburi.css", "/vendor/idb@8.0.3/idb.js", "/vendor/idb%408.0.3/idb.js"]) {
    const result = await workerFetch(request(path), env);
    assert.equal(result.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.match(result.headers.get("Content-Security-Policy"), /script-src 'self'/);
  }
  // Workers Assets would redirect a literal "@"; the Worker asks for the encoded name instead.
  assert.deepEqual(fetched, ["/fonts/pretendard%401.3.9/core.woff2", "/fonts/maruburi%401.000/maruburi.css", "/vendor/idb%408.0.3/idb.js", "/vendor/idb%408.0.3/idb.js"]);
  for (const path of ["/app.js", "/fonts/SUIT-Variable.woff2", "/vendor/unversioned/file.js", "/fonts/name@not-a-version/file"]) {
    assert.equal((await workerFetch(request(path), env)).headers.get("Cache-Control"), null);
  }
  for (const [status, contentType] of [[404, "text/plain"], [200, "text/html; charset=utf-8"]]) {
    const missing = environment({ ASSETS: { async fetch() { return new Response("missing", { status, headers: { "Content-Type": contentType } }); } } });
    assert.equal((await workerFetch(request("/fonts/pretendard@1.3.9/missing"), missing)).headers.get("Cache-Control"), null);
  }
  assert.equal((await workerFetch(request("/api/v1/me"), env)).status, 403);
  assert.equal((await workerFetch(new Request("https://archive.example/fonts/pretendard@1.3.9/core.woff2"), env)).status, 401);
});

test("text library shares the authenticated ReDSTM shell", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  // The text library is a 둘러보기 source (novels, Arcalive), not a separate destination.
  assert.equal((html.match(/data-destination="text"/g) || []).length, 0);
  assert.match(html, /id="source-switch"[\s\S]*data-source="novel"[\s\S]*data-source="arcalive"/);

  let assetPath;
  const env = environment({ ASSETS: { async fetch(request) { assetPath = new URL(request.url).pathname; return new Response("shared shell"); } } });
  const denied = await workerFetch(new Request("https://archive.example/text"), env);
  assert.equal(denied.status, 401);

  const page = await workerFetch(request("/text?lane=arcalive"), env);
  assert.equal(page.status, 200);
  assert.equal(assetPath, "/");
  assert.match(await page.text(), /shared shell/);
  assert.equal((await workerFetch(request("/text", { method: "POST" }), env)).status, 405);
});

test("text archive API exposes only fixed private read routes", async () => {
  let key;
  const env = environment({
    TEXT_ARCHIVE: {
      async get(selected) { key = selected; return archiveObject("novel body"); },
      async head(selected) { key = selected; return archiveObject("novel body"); },
    },
  });
  const response = await workerFetch(request(`/api/v1/text/object/${"a".repeat(64)}`), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "novel body");
  assert.equal(key, `published/objects/sha256/${"a".repeat(2)}/${"a".repeat(64)}.md`);
  assert.match(response.headers.get("Content-Security-Policy"), /img-src 'none'/);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  const denied = await workerFetch(new Request(`https://archive.example/api/v1/text/object/${"a".repeat(64)}`), env);
  assert.equal(denied.status, 401);
  assert.equal((await workerFetch(request("/api/v1/text/object/../private"), env)).status, 404);
  assert.equal((await workerFetch(request(`/api/v1/text/object/${"a".repeat(64)}`, { method: "POST" }), env)).status, 405);
});

test("manual archive reads use authenticated fixed routes", async () => {
  let key;
  const env = environment({ TEXT_ARCHIVE: {
    async get(selected) { key = selected; return archiveObject('{}'); },
  } });
  for (const [path, expected] of [
    ["release/manual", "published/manual/release.json"],
    [`index/manual/${"a".repeat(64)}.json`, `published/indexes/manual/${"a".repeat(64)}.json`],
    [`release-manifest/manual/${"a".repeat(64)}.json`, `published/releases/manual/${"a".repeat(64)}.json`],
  ]) {
    const response = await workerFetch(request(`/api/v1/text/${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(key, expected);
    assert.equal((await workerFetch(new Request(`https://archive.example/api/v1/text/${path}`), env)).status, 401);
  }
});

test("text archive status is served uncached from its fixed key", async () => {
  let key;
  const env = environment({
    TEXT_ARCHIVE: { async get(selected) { key = selected; return archiveObject('{"schema":1}'); } },
  });
  const response = await workerFetch(request("/api/v1/text/status"), env);
  assert.equal(response.status, 200);
  assert.equal(key, "published/status/text.json");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await workerFetch(request("/api/v1/text/status", { method: "POST" }), env)).status, 405);
});

test("scheduled maintenance reconciles stale runs and retains terminal evidence by outcome", async () => {
  const statements = [];
  const env = {
    CONTROL_DB: {
      prepare(sql) {
        const statement = {
          sql,
          bind(...parameters) {
            statement.parameters = parameters;
            return statement;
          },
        };
        return statement;
      },
      batch(received) {
        statements.push(...received);
        return [];
      },
    },
  };
  const scheduledTime = Date.parse("2026-07-12T03:00:00Z");
  await worker.scheduled({ scheduledTime, cron: "0 3 * * *" }, env, {});

  assert.equal(statements.length, 7);
  // Overdue queued commands expire and lapsed claims are settled even with no runner polling.
  assert.match(statements[4].sql, /SET state = 'expired'/);
  assert.match(statements[5].sql, /SET state = 'queued'.*WHERE state = 'claimed'/s);
  assert.match(statements[6].sql, /safe_message = 'claim_lost'/);
  assert.equal(statements[4].parameters[1], "2026-07-12T03:00:00.000Z");
  assert.match(statements[0].sql, /UPDATE commands SET state = 'failed'/);
  assert.match(statements[1].sql, /UPDATE runs SET state = 'failed'/);
  assert.match(statements[1].sql, /started_at < \?/);
  assert.match(statements[1].sql, /started_at > \?/);
  assert.equal(statements[1].parameters[2], "2026-07-11T19:00:00.000Z");
  assert.equal(statements[1].parameters[3], "2026-07-12T03:05:00.000Z");
  assert.match(statements[2].sql, /'succeeded', 'cancelled', 'expired'/);
  assert.match(statements[2].sql, /'partial', 'failed'/);
  assert.match(statements[2].sql, /finished_at IS NOT NULL/);
  assert.doesNotMatch(statements[2].sql, /'queued'|'claimed'/);
  assert.deepEqual(statements[2].parameters, [
    "2026-06-12T03:00:00.000Z",
    "2026-04-13T03:00:00.000Z",
  ]);
  assert.match(statements[3].sql, /DELETE FROM runs/);
  assert.match(statements[3].sql, /state = 'succeeded'/);
  assert.match(statements[3].sql, /state IN \('partial', 'failed'\)/);
  assert.doesNotMatch(statements[3].sql, /state = 'running'/);
  assert.equal(statements.some((statement) => /DELETE FROM run_events/.test(statement.sql)), false);
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"crons": \["0 3 \* \* \*"\]/);
  const retention = await readFile(
    new URL("../migrations/0004_retention_indexes.sql", import.meta.url),
    "utf8",
  );
  assert.match(retention, /commands_retention_idx\s+ON commands\(state, finished_at\)/s);
  assert.match(retention, /runs_retention_idx\s+ON runs\(state, finished_at\)/s);
  assert.equal((retention.match(/WHERE finished_at IS NOT NULL/g) || []).length, 2);
  const integrity = await readFile(
    new URL("../migrations/0005_control_integrity.sql", import.meta.url),
    "utf8",
  );
  assert.match(integrity, /CREATE UNIQUE INDEX commands_active_conflict_group_idx/);
  assert.match(integrity, /WHEN action IN \('pause-after-current', 'resume-schedule'\)/);
  assert.match(integrity, /THEN 'schedule-marker'/);
  assert.match(integrity, /ELSE 'process'/);
  assert.match(integrity, /state IN \('queued', 'claimed'\)/);
  assert.match(integrity, /CREATE INDEX run_events_snapshot_recorded_idx/);
  assert.match(integrity, /WHERE step = 'archive_snapshot'/);
});
