// Arcalive media identity shared by the Reader and the Worker. Arcalive serves images only
// through short-lived signed URLs (?expires=…&key=…); the CDN path is the stable identity.

const MEDIA_HOST = /(^|\.)(arca\.live|namu\.la)$/i;
// Older posts use a two-character directory (`ba/<hash>.jpg`) instead of a date code.
const PATH_KEY = /^[a-z0-9]{2,20}\/[a-f0-9]{16,128}\.(?:png|jpe?g|webp|gif|avif)$/;

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

