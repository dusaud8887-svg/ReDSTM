const HASH = /^[a-f0-9]{64}$/;
const LANES = new Set(["novel", "arcalive"]);

function jsonError(status) {
  return new Response(JSON.stringify({ error: status === 404 ? "not_found" : "method_not_allowed" }), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

async function readObject(request, env, key, contentType, immutable = true) {
  const object = request.method === "HEAD"
    ? await env.TEXT_ARCHIVE.head(key)
    : await env.TEXT_ARCHIVE.get(key);
  if (!object) return jsonError(404);
  const headers = new Headers();
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", immutable ? "private, max-age=31536000, immutable" : "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Content-Security-Policy", "default-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export function textArchiveResponse(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError(405);
  const path = new URL(request.url).pathname;
  let match = path.match(/^\/api\/v1\/text\/release\/(novel|arcalive)$/);
  if (match) return readObject(request, env, `published/${match[1]}/release.json`, "application/json; charset=utf-8", false);
  match = path.match(/^\/api\/v1\/text\/release-manifest\/(novel|arcalive)\/([a-f0-9]{64})\.json$/);
  if (match && LANES.has(match[1]) && HASH.test(match[2])) {
    return readObject(request, env, `published/releases/${match[1]}/${match[2]}.json`, "application/json; charset=utf-8");
  }
  match = path.match(/^\/api\/v1\/text\/index\/(novel|arcalive)\/([a-f0-9]{64})\.json$/);
  if (match && LANES.has(match[1]) && HASH.test(match[2])) {
    return readObject(request, env, `published/indexes/${match[1]}/${match[2]}.json`, "application/json; charset=utf-8");
  }
  match = path.match(/^\/api\/v1\/text\/object\/([a-f0-9]{64})$/);
  if (match && HASH.test(match[1])) {
    return readObject(request, env, `published/objects/sha256/${match[1].slice(0, 2)}/${match[1]}.md`, "text/markdown; charset=utf-8");
  }
  return jsonError(404);
}
