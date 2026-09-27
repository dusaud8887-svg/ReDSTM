// Arcalive media identity shared by the Reader and the Worker. Arcalive serves images only
// through short-lived signed URLs (?expires=…&key=…); the CDN path is the stable identity.

const MEDIA_HOST = /(^|\.)(arca\.live|namu\.la)$/i;
const PATH_KEY = /^[a-z0-9]{6,20}\/[a-f0-9]{16,128}\.(?:png|jpe?g|webp|gif|avif)$/;
const POST_URL = /^https:\/\/arca\.live\/b\/[a-z0-9_]{1,40}\/[1-9]\d{0,12}$/;

// "https://ac-o.arca.live/20230607sac/<hash>.webp?expires=…" → "20230607sac/<hash>.webp"
export function arcaPathKey(href) {
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

export function isArcaPathKey(value) {
  return typeof value === "string" && PATH_KEY.test(value);
}

// The post a body came from, reduced to its canonical form (query and fragment dropped).
export function arcaPostUrl(href) {
  let url;
  try {
    url = new URL(String(href ?? ""));
  } catch {
    return null;
  }
  const canonical = `https://arca.live${url.pathname.replace(/\/+$/, "")}`;
  return url.hostname === "arca.live" && POST_URL.test(canonical) ? canonical : null;
}
