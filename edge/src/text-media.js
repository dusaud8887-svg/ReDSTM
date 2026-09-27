// Archived copies of Arcalive images for the text library (R2 bytes + D1 path index), and the
// queue of posts whose images still need to be fetched by the reader's browser extension.

import { arcaPostUrl, isArcaPathKey } from "../public/arca-media.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PATHS = 100;
const MAX_ATTEMPTS = 5;
// Arcalive answers unsigned or expired requests with this fixed 200×200 "access denied" mascot.
export const ARCA_DENIED_PLACEHOLDER_SHA256 = "f2a44313661ef4ab6ad83b675c12452ca28f568ee5ee5ccd7bc26ddfac7b8c0b";
const TYPES = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};
const EXTENSION_TYPES = Object.fromEntries(Object.entries(TYPES).map(([type, extension]) => [extension, type]));

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

function mediaUrl(sha256, contentType) {
  return `/api/v1/text/media/${sha256}.${TYPES[contentType]}`;
}

function objectKey(sha256, extension) {
  return `media/images/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

// Magic bytes must agree with the declared type; nothing else is stored.
export function sniffImageType(bytes) {
  const view = new Uint8Array(bytes.slice(0, 12));
  const ascii = (start, end) => String.fromCharCode(...view.slice(start, end));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (view[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  return null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  if (!String(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validPaths(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) return null;
  const paths = [...new Set(value)];
  return paths.every(isArcaPathKey) ? paths : null;
}

async function storedPaths(env, paths) {
  const placeholders = paths.map(() => "?").join(", ");
  const { results } = await env.CONTROL_DB.prepare(
    `SELECT path_key, sha256, content_type, width, height FROM text_media WHERE path_key IN (${placeholders})`,
  ).bind(...paths).all();
  return new Map(results.map((row) => [row.path_key, row]));
}

async function resolve(request, env) {
  const body = await readJson(request);
  const paths = validPaths(body?.paths);
  if (!paths) return error(400, "invalid_paths");
  const stored = await storedPaths(env, paths);
  const media = {};
  for (const [path, row] of stored) {
    media[path] = { url: mediaUrl(row.sha256, row.content_type), width: row.width, height: row.height };
  }
  return json(200, { media });
}

async function enqueue(request, env) {
  const body = await readJson(request);
  const postUrl = arcaPostUrl(body?.post_url);
  const paths = validPaths(body?.paths);
  if (!postUrl || !paths) return error(400, "invalid_request");
  const stored = await storedPaths(env, paths);
  const missing = paths.filter((path) => !stored.has(path));
  if (!missing.length) return json(200, { queued: 0 });
  const now = new Date().toISOString();
  // A post read again moves to the front of the queue and gets fresh attempts.
  await env.CONTROL_DB.prepare(
    `INSERT INTO text_media_queue (post_url, paths, status, attempts, last_error, requested_at, updated_at)
     VALUES (?, ?, 'pending', 0, NULL, ?, ?)
     ON CONFLICT(post_url) DO UPDATE SET paths = excluded.paths, status = 'pending', attempts = 0,
       last_error = NULL, requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
  ).bind(postUrl, JSON.stringify(missing), now, now).run();
  return json(200, { queued: missing.length });
}

async function pending(url, env) {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 1), 20);
  const { results } = await env.CONTROL_DB.prepare(
    `SELECT post_url, paths, attempts FROM text_media_queue
     WHERE status = 'pending' AND attempts < ? ORDER BY requested_at DESC LIMIT ?`,
  ).bind(MAX_ATTEMPTS, limit).all();
  const { results: counts } = await env.CONTROL_DB.prepare(
    "SELECT status, COUNT(*) AS count FROM text_media_queue GROUP BY status",
  ).all();
  return json(200, {
    posts: results.map((row) => ({ post_url: row.post_url, paths: JSON.parse(row.paths), attempts: row.attempts })),
    counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
  });
}

async function report(request, env) {
  const body = await readJson(request);
  const postUrl = arcaPostUrl(body?.post_url);
  if (!postUrl || !["done", "failed"].includes(body?.status)) return error(400, "invalid_request");
  const message = typeof body.error === "string" ? body.error.slice(0, 200) : null;
  // A failed attempt stays pending until MAX_ATTEMPTS, then stops being handed out.
  await env.CONTROL_DB.prepare(
    `UPDATE text_media_queue SET
       status = CASE WHEN ? = 'done' THEN 'done' WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
       attempts = attempts + 1, last_error = ?, updated_at = ?
     WHERE post_url = ?`,
  ).bind(body.status, MAX_ATTEMPTS, body.status === "done" ? null : message, new Date().toISOString(), postUrl).run();
  return json(200, { ok: true });
}

async function store(request, url, env) {
  const path = url.searchParams.get("path") ?? "";
  if (!isArcaPathKey(path)) return error(400, "invalid_path");
  const width = Number(request.headers.get("X-Media-Width"));
  const height = Number(request.headers.get("X-Media-Height"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 20000 || height > 20000) {
    return error(400, "invalid_dimensions");
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return error(413, "too_large");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return error(413, "too_large");
  const contentType = sniffImageType(bytes);
  if (!contentType || contentType !== request.headers.get("Content-Type")) return error(415, "unsupported_image");
  const sha256 = await sha256Hex(bytes);
  if (sha256 === ARCA_DENIED_PLACEHOLDER_SHA256) return error(422, "placeholder_image");
  const key = objectKey(sha256, TYPES[contentType]);
  if (!(await env.TEXT_ARCHIVE.head(key))) {
    await env.TEXT_ARCHIVE.put(key, bytes, { httpMetadata: { contentType } });
  }
  await env.CONTROL_DB.prepare(
    `INSERT INTO text_media (path_key, sha256, content_type, width, height, bytes, stored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path_key) DO UPDATE SET sha256 = excluded.sha256, content_type = excluded.content_type,
       width = excluded.width, height = excluded.height, bytes = excluded.bytes, stored_at = excluded.stored_at`,
  ).bind(path, sha256, contentType, width, height, bytes.byteLength, new Date().toISOString()).run();
  return json(201, { path, url: mediaUrl(sha256, contentType) });
}

async function serve(request, env, sha256, extension) {
  const object = request.method === "HEAD"
    ? await env.TEXT_ARCHIVE.head(objectKey(sha256, extension))
    : await env.TEXT_ARCHIVE.get(objectKey(sha256, extension));
  if (!object) return error(404, "not_found");
  const headers = new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": EXTENSION_TYPES[extension],
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export async function textMediaResponse(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.slice("/api/v1/text/media/".length);
  const image = /^([a-f0-9]{64})\.(webp|png|jpg|gif)$/.exec(route);
  if (image && SHA256.test(image[1])) {
    if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method_not_allowed");
    return serve(request, env, image[1], image[2]);
  }
  // Writes need a header a cross-site form or image cannot send, so other sites cannot use the
  // reader's Access session to write here (a cross-origin script would need a CORS preflight).
  const write = request.method !== "GET" && request.method !== "HEAD";
  if (write && request.headers.get("X-ReDSTM-Media") !== "1") return error(403, "missing_media_header");
  if (route === "resolve" && request.method === "POST") return resolve(request, env);
  if (route === "queue" && request.method === "POST") return enqueue(request, env);
  if (route === "queue" && request.method === "GET") return pending(url, env);
  if (route === "queue/result" && request.method === "POST") return report(request, env);
  if (route === "object" && request.method === "PUT") return store(request, url, env);
  return error(404, "not_found");
}
