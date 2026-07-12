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
  assert.equal(result.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(await result.text(), /ReDSTM/);

  const operations = await workerFetch(request("/ops"), env);
  assert.equal(operations.status, 200);
  assert.equal(new URL(received.url).pathname, "/ops");
  assert.match(operations.headers.get("Content-Security-Policy"), /connect-src 'self'/);
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

  assert.equal(statements.length, 4);
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
