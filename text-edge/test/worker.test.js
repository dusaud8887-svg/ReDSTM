import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker from "../src/index.js";

let accessToken;
let serviceToken;
let previousFetch;

before(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/cdn-cgi/access/certs")) {
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
    .sign(pair.privateKey);
  serviceToken = await new SignJWT({ common_name: "typemoon-runner" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience("text-reader-aud")
    .setSubject("runner-123")
    .setExpirationTime("1h")
    .sign(pair.privateKey);
});

after(() => {
  globalThis.fetch = previousFetch;
});

function environment() {
  return {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "text-reader-aud",
  };
}

function request(path, token = accessToken, method = "GET") {
  return new Request(`https://text.example.com${path}`, {
    method,
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
  });
}

test("legacy viewer redirects into the authenticated shared Reader", async () => {
  const response = await worker.fetch(request("/?lane=novel"), environment());
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "https://redstm-edge.redstm-archive-private.workers.dev/text?lane=novel",
  );
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("legacy API paths do not serve the retired duplicate viewer", async () => {
  const response = await worker.fetch(request("/api/v1/object/" + "a".repeat(64)), environment());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://redstm-edge.redstm-archive-private.workers.dev/text");
});

test("unauthenticated and service identities are rejected", async () => {
  const missing = await worker.fetch(request("/", null), environment());
  assert.equal(missing.status, 401);
  const service = await worker.fetch(request("/", serviceToken), environment());
  assert.equal(service.status, 401);
});

test("only GET and HEAD are accepted", async () => {
  const response = await worker.fetch(request("/", accessToken, "POST"), environment());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD");
});
