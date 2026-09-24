import { requireHumanAccess } from "./access.js";

const HASH = /^[a-f0-9]{64}$/;
const LANES = new Set(["novel", "arcalive"]);

function securityHeaders(headers, { immutable = false, pointer = false } = {}) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Content-Security-Policy", "default-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("Cache-Control", pointer ? "private, no-store" : immutable ? "private, max-age=31536000, immutable" : "private, no-store");
  return headers;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: securityHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8" })),
  });
}

async function objectResponse(request, bucket, key, contentType, immutable = true) {
  const object = await bucket.get(key);
  if (!object) return jsonError(404, "not_found");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  securityHeaders(headers, { immutable });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function apiResponse(request, env, path) {
  const pointer = path.match(/^\/api\/v1\/release\/(novel|arcalive)$/);
  if (pointer) {
    return objectResponse(
      request,
      env.TEXT_ARCHIVE,
      `published/${pointer[1]}/release.json`,
      "application/json; charset=utf-8",
      false,
    );
  }
  const release = path.match(/^\/api\/v1\/release-manifest\/(novel|arcalive)\/([a-f0-9]{64})\.json$/);
  if (release && LANES.has(release[1]) && HASH.test(release[2])) {
    return objectResponse(
      request,
      env.TEXT_ARCHIVE,
      `published/releases/${release[1]}/${release[2]}.json`,
      "application/json; charset=utf-8",
    );
  }
  const index = path.match(/^\/api\/v1\/index\/(novel|arcalive)\/([a-f0-9]{64})\.json$/);
  if (index && LANES.has(index[1]) && HASH.test(index[2])) {
    return objectResponse(
      request,
      env.TEXT_ARCHIVE,
      `published/indexes/${index[1]}/${index[2]}.json`,
      "application/json; charset=utf-8",
    );
  }
  const body = path.match(/^\/api\/v1\/object\/([a-f0-9]{64})$/);
  if (body && HASH.test(body[1])) {
    return objectResponse(
      request,
      env.TEXT_ARCHIVE,
      `published/objects/sha256/${body[1].slice(0, 2)}/${body[1]}.md`,
      "text/markdown; charset=utf-8",
    );
  }
  return jsonError(404, "not_found");
}

function withShellHeaders(response) {
  const headers = new Headers(response.headers);
  securityHeaders(headers);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleAuthedRequest(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed");
  }
  if (url.pathname.startsWith("/api/")) return apiResponse(request, env, url.pathname);
  return withShellHeaders(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    try {
      await requireHumanAccess(request, env);
    } catch {
      return jsonError(401, "access_required");
    }
    return handleAuthedRequest(request, env);
  },
};
