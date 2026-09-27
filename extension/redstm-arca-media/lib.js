// Pure helpers for the extension (no chrome.* or DOM), tested from edge/test with Node.

export const DEFAULT_BASE_URL = "https://redstm-edge.redstm-archive-private.workers.dev";
export const MAX_WIDTH = 1600;
export const WEBP_QUALITY = 0.8;
// Arcalive's fixed 200×200 "access denied" mascot, served for unsigned/expired image requests.
export const DENIED_PLACEHOLDER_SHA256 = "f2a44313661ef4ab6ad83b675c12452ca28f568ee5ee5ccd7bc26ddfac7b8c0b";

const MEDIA_HOST = /(^|\.)(arca\.live|namu\.la)$/i;
const PATH_KEY = /^[a-z0-9]{6,20}\/[a-f0-9]{16,128}\.(?:png|jpe?g|webp|gif|avif)$/;

// Same rule as edge/public/arca-media.js arcaPathKey (kept in step by a parity test).
export function pathKey(href) {
  let url;
  try {
    url = new URL(String(href ?? ""));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !MEDIA_HOST.test(url.hostname)) return null;
  const key = url.pathname.replace(/^\/+/, "");
  return PATH_KEY.test(key) ? key : null;
}

function unescapeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Current signed image URLs in a post page, keyed by CDN path. data-originalurl (the original
// file) wins over src (often a resized preview). Emoticons are skipped.
export function signedImageUrls(html) {
  const found = new Map();
  const tags = String(html ?? "").match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (/class\s*=\s*"[^"]*arca-emoticon/i.test(tag)) continue;
    const attribute = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, "i").exec(tag)?.[1];
    const raw = attribute("data-originalurl") ?? attribute("data-orig") ?? attribute("src");
    if (!raw) continue;
    let href = unescapeHtml(raw.trim());
    if (href.startsWith("//")) href = `https:${href}`;
    const key = pathKey(href);
    if (!key || found.has(key)) continue;
    const url = new URL(href);
    if (!url.searchParams.has("type")) url.searchParams.set("type", "orig");
    found.set(key, url.href);
  }
  return found;
}

// Scale to at most MAX_WIDTH wide, keeping the aspect ratio.
export function targetSize(width, height, maxWidth = MAX_WIDTH) {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

export function isLoginWall(status, html) {
  return status === 401 || status === 403 || status === 451 || /로그인이 필요|성인 인증|Unavailable For Legal Reasons/.test(String(html ?? ""));
}
