import { createRemoteJWKSet, jwtVerify } from "jose";
import { controlApiResponse } from "./control-api.js";
import { runControlMaintenance } from "./control-read.js";

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
      const subject = payload.email || payload.common_name || payload.sub;
      return typeof subject === "string" ? { role, subject } : false;
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
  secured.headers.set("Content-Security-Policy", contentSecurityPolicy);
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Content-Type-Options", "nosniff");
  return secured;
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
  if (options.range && object.range) {
    status = 206;
    headers.set(
      "Content-Range",
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
    );
  }
  const length = options.range && object.range ? object.range.length : object.size;
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
    if (url.pathname.startsWith("/api/v1/")) {
      return controlApiResponse(request, env, isAuthorized);
    }
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      return response("Method not allowed", 405, { Allow: "GET, HEAD" });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
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
