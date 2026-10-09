// Archived copies of Arcalive images for the text library. Newtomi downloads and converts them,
// the Oracle media importer stores each one in R2 under its CDN path key (docs/20), and the
// Reader swaps expired signed links for these copies. There is no write API here.

import { isArcaPathKey } from "../public/arca-media.js";
import { readJson } from "./control-common.js";

// One R2 head per path; stays well under the Workers subrequest limit.
const MAX_PATHS = 40;
const RESOLVE_BODY_MAX_BYTES = 16 * 1024;
const IMAGE_TYPES = new Set(["image/webp", "image/png", "image/jpeg", "image/gif"]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

const error = (status, code) => json(status, { error: code });

const objectKey = (path) => `media/arca/${path}`;
// The URL carries the stored object's ETag. The importer may store new bytes under a key (a new
// conversion or a repair) while browsers and the Service Worker keep media URLs as immutable, so
// a new version needs a new URL (2026-10-09 review ④).
const versionOf = (object) => String(object.etag ?? object.httpEtag ?? "").replaceAll('"', "");
const mediaUrl = (path, object) => `/api/v1/text/media/arca/${path}?v=${encodeURIComponent(versionOf(object))}`;

function validPaths(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) return null;
  const paths = [...new Set(value)];
  return paths.every(isArcaPathKey) ? paths : null;
}

async function resolve(request, env) {
  let body;
  try { body = await readJson(request, RESOLVE_BODY_MAX_BYTES); }
  catch (failure) {
    return error(failure.status === 413 ? 413 : 400,
      failure.status === 413 ? "body_too_large" : "invalid_paths");
  }
  const paths = validPaths(body?.paths);
  if (!paths) return error(400, "invalid_paths");
  const found = await Promise.all(paths.map((path) => env.TEXT_ARCHIVE.head(objectKey(path))));
  const media = {};
  paths.forEach((path, index) => {
    if (found[index]) media[path] = { url: mediaUrl(path, found[index]) };
  });
  return json(200, { media });
}

async function serve(request, env, path) {
  const object = request.method === "HEAD"
    ? await env.TEXT_ARCHIVE.head(objectKey(path))
    : await env.TEXT_ARCHIVE.get(objectKey(path));
  const contentType = object?.httpMetadata?.contentType;
  if (!object || !IMAGE_TYPES.has(contentType)) return error(404, "not_found");
  // Only the current version's URL is immutable; an old or unversioned URL revalidates.
  const current = new URL(request.url).searchParams.get("v") === versionOf(object);
  const headers = new Headers({
    "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export async function textMediaResponse(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.slice("/api/v1/text/media/".length);
  if (route.startsWith("arca/")) {
    const path = route.slice("arca/".length);
    if (!isArcaPathKey(path)) return error(404, "not_found");
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method_not_allowed");
    return serve(request, env, path);
  }
  if (route === "resolve" && request.method === "POST") return resolve(request, env);
  return error(404, "not_found");
}
