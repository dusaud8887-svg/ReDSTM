import { createRemoteJWKSet, jwtVerify } from "jose";

const encoder = new TextEncoder();
const keyPattern = /^[a-zA-Z0-9_./-]+$/;
const accessJwks = new Map();
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' https: data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function equalSecrets(left, right) {
  const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

function accessIssuer(teamDomain) {
  const issuer = new URL(teamDomain);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password ||
      issuer.pathname !== "/" || issuer.search || issuer.hash ||
      !issuer.hostname.endsWith(".cloudflareaccess.com")) {
    throw new TypeError("invalid Cloudflare Access team domain");
  }
  return issuer.origin;
}

async function authorized(request, env) {
  if (env.TEAM_DOMAIN || env.POLICY_AUD) {
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
    let issuer;
    try {
      issuer = accessIssuer(env.TEAM_DOMAIN);
    } catch {
      return null;
    }
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return false;
    try {
      let jwks = accessJwks.get(issuer);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        accessJwks.set(issuer, jwks);
      }
      await jwtVerify(token, jwks, { issuer, audience: env.POLICY_AUD });
      return true;
    } catch {
      return false;
    }
  }
  if (!env.VIEWER_USERNAME || !env.VIEWER_PASSWORD) {
    return null;
  }
  const expected = `Basic ${btoa(`${env.VIEWER_USERNAME}:${env.VIEWER_PASSWORD}`)}`;
  return equalSecrets(request.headers.get("Authorization") || "", expected);
}

function response(body, status, headers = {}) {
  return new Response(body, { status, headers });
}

function objectKey(url) {
  if (!url.pathname.startsWith("/archive/")) {
    return null;
  }
  const key = url.pathname.slice("/archive/".length);
  if (!key || !keyPattern.test(key) || key.split("/").includes("..")) {
    return "";
  }
  return key;
}

function objectHeaders(object, key) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  if (key.endsWith(".json.gz")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Encoding", "gzip");
  }
  headers.set("Cache-Control", key === "release.json" ? "no-cache" : "private, immutable");
  return headers;
}

async function staticAssetResponse(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const secured = new Response(asset.body, asset);
  secured.headers.set("Content-Security-Policy", contentSecurityPolicy);
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  return secured;
}

async function archiveResponse(request, env, key) {
  if (request.method === "HEAD") {
    const object = await env.ARCHIVE.head(key);
    return object ? response(null, 200, objectHeaders(object, key)) : response("Not found", 404);
  }

  const options = { onlyIf: request.headers };
  if (!key.endsWith(".json.gz") && request.headers.has("Range")) {
    options.range = request.headers;
  }
  const object = await env.ARCHIVE.get(key, options);
  if (!object) {
    return response("Not found", 404);
  }
  if (!("body" in object)) {
    return response(null, 304, { ETag: object.httpEtag });
  }

  const headers = objectHeaders(object, key);
  let status = 200;
  if (options.range && object.range) {
    status = 206;
    headers.set(
      "Content-Range",
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
    );
  }
  return new Response(object.body, { status, headers, encodeBody: "manual" });
}

export default {
  async fetch(request, env) {
    const isAuthorized = await authorized(request, env);
    if (isAuthorized === null) {
      return response("Worker secrets are not configured", 500);
    }
    if (!isAuthorized) {
      const accessMode = Boolean(env.TEAM_DOMAIN || env.POLICY_AUD);
      return response(
        "Authentication required",
        accessMode ? 403 : 401,
        accessMode ? {} : { "WWW-Authenticate": 'Basic realm="ReDSTM", charset="UTF-8"' },
      );
    }
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      return response("Method not allowed", 405, { Allow: "GET, HEAD" });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    const key = objectKey(url);
    if (key === null) {
      return staticAssetResponse(request, env);
    }
    if (key === "") {
      return response("Invalid archive key", 400);
    }
    return archiveResponse(request, env, key);
  },
};
