import { createRemoteJWKSet, jwtVerify } from "jose";
import { controlApiResponse } from "./control-api.js";
import { runControlMaintenance } from "./control-read.js";
import { textArchiveResponse } from "./text-archive.js";

const encoder = new TextEncoder();
const keyPattern = /^[a-zA-Z0-9_./-]+$/;
const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;
const accessJwks = new Map();
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' https:",
  "media-src 'self' https:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "upgrade-insecure-requests",
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

async function authorized(request, env, role) {
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
      const audience = role === "runner" ? env.RUNNER_POLICY_AUD : env.POLICY_AUD;
      if (!audience) return null;
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      // Defense in depth behind the per-route Access applications (docs/08 §4.2, §5.3): an
      // Access service-token JWT carries common_name (the Client ID) and no email, and a user
      // identity JWT carries email. Runner routes accept only the former, user routes only the
      // latter, even if an Access policy is ever widened by mistake.
      const email = typeof payload.email === "string" && payload.email ? payload.email : null;
      const serviceToken = typeof payload.common_name === "string" && payload.common_name
        ? payload.common_name
        : null;
      if (role === "runner") return serviceToken && !email ? { role, subject: serviceToken } : false;
      return email ? { role, subject: email } : false;
    } catch {
      return false;
    }
  }
  if (!env.VIEWER_USERNAME || !env.VIEWER_PASSWORD) {
    return null;
  }
  const expected = `Basic ${btoa(`${env.VIEWER_USERNAME}:${env.VIEWER_PASSWORD}`)}`;
  return await equalSecrets(request.headers.get("Authorization") || "", expected)
    ? { role: "user", subject: "local-basic" }
    : false;
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
  if (key.endsWith(".json.zst")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Encoding", "zstd");
  }
  if (key === "release.json" && object.uploaded instanceof Date) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }
  headers.set(
    "Cache-Control",
    key === "release.json"
      ? "no-cache"
      : `private, max-age=${IMMUTABLE_CACHE_SECONDS}, immutable`,
  );
  return headers;
}

async function staticAssetResponse(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const secured = new Response(asset.body, asset);
  const versioned = /^\/(?:vendor|fonts)\/[a-z0-9-]+@\d+(?:\.\d+){0,2}\//.test(new URL(request.url).pathname);
  if (versioned && [200, 304].includes(asset.status) &&
      !asset.headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
    secured.headers.set("Cache-Control", `public, max-age=${IMMUTABLE_CACHE_SECONDS}, immutable`);
  }
  secured.headers.set("Content-Security-Policy", contentSecurityPolicy);
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  return secured;
}

// R2 reports the range as requested: {offset, length}, {offset} for "bytes=100-", or {suffix}
// for "bytes=-100". Turn it into the absolute byte span the body actually carries.
function servedRange(range, size) {
  if (Number.isInteger(range.suffix)) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = Math.min(Number.isInteger(range.offset) ? range.offset : 0, size);
  const length = Math.min(Number.isInteger(range.length) ? range.length : size - offset, size - offset);
  return { offset, length };
}

async function archiveResponse(request, env, key, ctx) {
  if (request.method === "HEAD") {
    const object = await env.ARCHIVE.head(key);
    return object ? response(null, 200, objectHeaders(object, key)) : response("Not found", 404);
  }

  const options = { onlyIf: request.headers };
  if (!key.endsWith(".json.zst") && request.headers.has("Range")) {
    options.range = request.headers;
  }
  const object = await env.ARCHIVE.get(key, options);
  if (!object) {
    return response("Not found", 404);
  }
  if (!("body" in object)) {
    return response(null, 304, objectHeaders(object, key));
  }

  const headers = objectHeaders(object, key);
  let status = 200;
  const range = options.range && object.range ? servedRange(object.range, object.size) : null;
  if (range) {
    status = 206;
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  const length = range ? range.length : object.size;
  const fixed = new FixedLengthStream(length);
  ctx.waitUntil(object.body.pipeTo(fixed.writable));
  headers.set("Content-Length", String(length));
  return new Response(fixed.readable, { status, headers, encodeBody: "manual" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const role = url.pathname.startsWith("/api/v1/runner/") ? "runner" : "user";
    const isAuthorized = await authorized(request, env, role);
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
    if (url.pathname === "/api/v1/me") {
      if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return response("Access user required", 403);
      if (request.method !== "GET") return response("Method not allowed", 405, { Allow: "GET" });
      const ownerHash = Array.from(await digest(isAuthorized.subject), (byte) => byte.toString(16).padStart(2, "0"))
        .join("").slice(0, 16);
      return Response.json({ ownerHash }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (url.pathname.startsWith("/api/v1/text/")) {
      return textArchiveResponse(request, env);
    }
    if (url.pathname.startsWith("/api/v1/")) {
      return controlApiResponse(request, env, isAuthorized);
    }
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      return response("Method not allowed", 405, { Allow: "GET, HEAD" });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/text" || url.pathname === "/text/") {
      const shellUrl = new URL(request.url);
      shellUrl.pathname = "/";
      return staticAssetResponse(new Request(shellUrl, request), env);
    }
    if (url.pathname === "/ops" || url.pathname === "/ops/") {
      return staticAssetResponse(request, env);
    }
    const key = objectKey(url);
    if (key === null) {
      return staticAssetResponse(request, env);
    }
    if (key === "") {
      return response("Invalid archive key", 400);
    }
    return archiveResponse(request, env, key, ctx);
  },
  async scheduled(controller, env) {
    await runControlMaintenance(env, new Date(controller.scheduledTime));
  },
};
