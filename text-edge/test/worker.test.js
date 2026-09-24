import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker, { handleAuthedRequest } from "../src/index.js";

let privateKey;
let accessToken;
let serviceToken;
let previousFetch;
const content = Buffer.from("private text\n");
const digest = await crypto.subtle.digest("SHA-256", content);
const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const paths = [];

before(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return previousFetch(input, init);
  };
  const issuer = "https://example.cloudflareaccess.com";
  accessToken = await new SignJWT({ email: "reader@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience("text-reader-aud")
    .setSubject("user-123")
    .setExpirationTime("1h")
    .sign(privateKey);
  serviceToken = await new SignJWT({ common_name: "typemoon-runner" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience("text-reader-aud")
    .setSubject("runner-123")
    .setExpirationTime("1h")
    .sign(privateKey);
});

after(() => {
  globalThis.fetch = previousFetch;
});

function environment() {
  return {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "text-reader-aud",
    TEXT_ARCHIVE: {
      async get(key) {
        paths.push(key);
        const body = key === "published/novel/release.json"
          ? Buffer.from(JSON.stringify({ schema: 1, lane: "novel", sha256: hash }))
          : key.endsWith(`${hash}.md`)
            ? content
            : null;
        if (body) {
          return {
            body: new Response(body).body,
            httpEtag: `"${hash}"`,
            writeHttpMetadata(headers) {
              headers.set("Content-Length", String(body.length));
            },
          };
        }
        return null;
      },
    },
    ASSETS: {
      async fetch() {
        return new Response("shell");
      },
    },
  };
}

function authorizedRequest(path, token = accessToken, method = "GET") {
  return new Request(`https://text.example.com${path}`, {
    method,
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
  });
}

test("human Access identity receives streamed private text with no image allowance", async () => {
  paths.length = 0;
  const response = await worker.fetch(
    authorizedRequest(`/api/v1/object/${hash}`),
    environment(),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "private text\n");
  assert.equal(paths[0], `published/objects/sha256/${hash.slice(0, 2)}/${hash}.md`);
  assert.match(response.headers.get("Content-Security-Policy"), /img-src 'none'/);
  assert.match(response.headers.get("Cache-Control"), /immutable/);
});

test("missing, wrong-audience, and service-token identities fail closed", async () => {
  const env = environment();
  const missing = await worker.fetch(authorizedRequest(`/api/v1/object/${hash}`, null), env);
  assert.equal(missing.status, 401);
  const service = await worker.fetch(authorizedRequest(`/api/v1/object/${hash}`, serviceToken), env);
  assert.equal(service.status, 401);
  const wrongAudience = await new SignJWT({ email: "reader@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://example.cloudflareaccess.com")
    .setAudience("wrong-aud")
    .setSubject("user-123")
    .setExpirationTime("1h")
    .sign(privateKey);
  const denied = await worker.fetch(
    authorizedRequest(`/api/v1/object/${hash}`, wrongAudience),
    env,
  );
  assert.equal(denied.status, 401);
});

test("only fixed GET/HEAD routes can read from the private bucket", async () => {
  paths.length = 0;
  const env = environment();
  const badPath = await worker.fetch(
    authorizedRequest(`/api/v1/object/${hash}/../../private`),
    env,
  );
  assert.equal(badPath.status, 404);
  const post = await worker.fetch(
    authorizedRequest(`/api/v1/object/${hash}`, accessToken, "POST"),
    env,
  );
  assert.equal(post.status, 405);
  assert.deepEqual(paths, []);
  const head = await worker.fetch(
    authorizedRequest(`/api/v1/object/${hash}`, accessToken, "HEAD"),
    env,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("release pointer is non-cacheable and the independent shell allows no images", async () => {
  paths.length = 0;
  const env = environment();
  const release = await handleAuthedRequest(
    new Request("https://text.example.com/api/v1/release/novel"),
    env,
  );
  assert.equal(release.status, 200);
  assert.match(release.headers.get("Cache-Control"), /no-store/);
  assert.equal(paths[0], "published/novel/release.json");

  const shell = await handleAuthedRequest(new Request("https://text.example.com/"), env);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("Content-Security-Policy"), /img-src 'none'/);
  assert.match(shell.headers.get("Content-Security-Policy"), /connect-src 'self'/);
});

test("reader assets render archive data as text and contain no remote media", async () => {
  const [html, app, style] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/style.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(app, /\.textContent\s*=/);
  assert.doesNotMatch(app, /\.innerHTML\s*=|\.outerHTML\s*=/);
  assert.doesNotMatch(style, /https?:\/\//i);
});
