import { arcaPathKey } from "./arca-media.js";

// Turns direct image links in reading bodies into inline images. Only http(s) URLs whose path
// ends in a raster image extension qualify; anything else stays a link. Images load without a
// referrer; a failed image falls back to its original link without breaking the body.

const IMAGE_PATH = /\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;
// A markdown link "[label](url)" or a bare URL.
const LINK_PATTERN = /\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>"'`]+/gi;
// Text-archive exports mark media on their own line: "[image] URL", "[video] URL".
const TAGGED_MEDIA = /^\s*\[(image|img|video)\]\s+(\S+)\s*$/i;
const LINK_WRAPPERS = [/^https?:\/\/unsafelink\.com\/(https?:\/\/.+)$/i];
const TRAILING_PUNCTUATION = /[)\]}.,!?;:'"。、」』]+$/;

export function imageUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate ?? "").trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (!IMAGE_PATH.test(url.pathname)) return null;
  url.protocol = "https:";
  return url.href;
}

function safeHttpUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate ?? "").trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  url.protocol = "https:";
  return url.href;
}

// "https://unsafelink.com/https://real" → "https://real".
export function unwrapLink(href) {
  for (const wrapper of LINK_WRAPPERS) {
    const match = wrapper.exec(href);
    if (match) return unwrapLink(match[1]);
  }
  return href;
}

// { kind: "image" | "video", href } for a tagged media line, else null. The tag declares the
// type, so the URL needs no image extension (signed CDN URLs keep their query intact).
export function taggedMedia(line) {
  const match = TAGGED_MEDIA.exec(String(line ?? ""));
  if (!match) return null;
  const href = safeHttpUrl(match[2]);
  if (!href) return null;
  return { kind: match[1].toLowerCase() === "video" ? "video" : "image", href };
}

// Signed CDN links (…?expires=<unix seconds>&key=…) stop working after that time; loading them
// only produces a broken box, so they get a note pointing at the source post instead.
export function isExpiredSignedUrl(href, nowSeconds = Date.now() / 1000) {
  try {
    const expires = Number(new URL(href).searchParams.get("expires"));
    return Number.isFinite(expires) && expires > 0 && expires < nowSeconds;
  } catch {
    return false;
  }
}

function expiredMedia(href, kind, sourceUrl) {
  const note = document.createElement("p");
  note.className = "media-expired";
  note.append(`만료된 ${kind === "video" ? "영상" : "이미지"} 링크`);
  if (sourceUrl) {
    note.append(" · ");
    note.append(originalLink(sourceUrl, "원문 글에서 보기"));
  }
  note.title = href;
  return note;
}

export function mediaVideo(href) {
  const figure = document.createElement("figure");
  figure.className = "media-figure media-video";
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "none";
  video.playsInline = true;
  video.src = href;
  const caption = document.createElement("figcaption");
  caption.append(originalLink(href, `영상 원본 · ${hostOf(href)}`));
  figure.append(video, caption);
  return figure;
}

function hostOf(href) {
  try { return new URL(href).hostname; } catch { return ""; }
}

function originalLink(href, label) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

export function mediaFigure(href, { caption: captionText = "" } = {}) {
  const figure = document.createElement("figure");
  figure.className = "media-figure";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "media-open";
  open.ariaLabel = "이미지 크게 보기";
  const image = document.createElement("img");
  image.alt = "본문 이미지";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = href;
  open.append(image);
  const caption = document.createElement("figcaption");
  if (captionText) caption.textContent = captionText;
  else caption.append(originalLink(href, `원본 · ${hostOf(href)}`));
  figure.append(open, caption);
  watchFailure(image, href);
  return figure;
}

function watchFailure(image, href) {
  image.addEventListener("error", () => {
    const figure = image.closest(".media-figure");
    if (!figure) return;
    figure.classList.add("failed");
    const note = document.createElement("p");
    note.className = "media-failed";
    note.textContent = "이미지를 불러오지 못했습니다";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "media-retry";
    retry.textContent = "다시 시도";
    retry.addEventListener("click", () => {
      figure.replaceWith(mediaFigure(href));
    }, { once: true });
    figure.querySelector(".media-open").replaceWith(note, retry);
  }, { once: true });
}

// Plain text: a line that is only an image URL becomes an image; other URLs become links.
// A long plain text (a whole personal novel in one .txt, up to 32 MiB) is laid out in chunks the
// browser can skip while off screen (content-visibility, reader.css). Chunks end right after a
// line break, so the text model sees exactly the original text and saved positions still hold.
const PLAIN_CHUNK_CHARACTERS = 64 * 1024;
const PLAIN_CHUNK_FROM = 256 * 1024;

function appendPlainChunks(target, text) {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + PLAIN_CHUNK_CHARACTERS);
    if (end < text.length) {
      const lineEnd = text.lastIndexOf("\n", end - 1);
      end = lineEnd >= start ? lineEnd + 1 : (text.indexOf("\n", end) + 1 || text.length);
    }
    // The last piece stays bare text: a block there would add a trailing line to the model.
    if (end >= text.length) {
      appendLinkedText(target, text.slice(start));
      return;
    }
    const chunk = document.createElement("div");
    chunk.className = "text-chunk";
    appendLinkedText(chunk, text.slice(start, end));
    target.append(chunk);
    start = end;
  }
}

export function renderPlainTextWithMedia(container, text, { sourceUrl = "" } = {}) {
  const fragment = document.createDocumentFragment();
  const chunked = String(text).length > PLAIN_CHUNK_FROM;
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    if (chunked) appendPlainChunks(fragment, buffer);
    else appendLinkedText(fragment, buffer);
    buffer = "";
  };
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    const tagged = taggedMedia(line);
    // URL parsing is the costly part; a line without "://" cannot be an image address.
    const href = tagged || !line.includes("://") ? null : imageUrl(line);
    if (tagged || href) {
      flush();
      const url = tagged?.href ?? href;
      const kind = tagged?.kind ?? "image";
      const node = isExpiredSignedUrl(url) ? expiredMedia(url, kind, sourceUrl)
        : kind === "video" ? mediaVideo(url) : mediaFigure(url);
      // Arcalive images can be swapped for the archived copy once it is known (videos are not kept).
      const path = kind === "image" ? arcaPathKey(url) : null;
      if (path) node.dataset.arcaPath = path;
      fragment.append(node);
      return;
    }
    buffer += line + (index < lines.length - 1 ? "\n" : "");
  });
  flush();
  container.replaceChildren(fragment);
}

function appendLinkedText(target, text) {
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const markdown = match[1] !== undefined;
    const raw = markdown ? match[0] : match[0].replace(TRAILING_PUNCTUATION, "");
    let href;
    try {
      href = new URL(unwrapLink(markdown ? match[2] : raw)).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href)) continue;
    if (match.index > last) target.append(text.slice(last, match.index));
    const label = markdown ? match[1].replace(/^https?:\/\/unsafelink\.com\//i, "") : raw;
    const link = originalLink(href, label);
    if (imageUrl(href)) link.dataset.image = imageUrl(href);
    target.append(link);
    last = match.index + raw.length;
  }
  if (last < text.length) target.append(text.slice(last));
}

// Archived HTML (prose only, never AA): anchors to images and standalone image-URL text.
export function enhanceHtmlMedia(container) {
  if (container.dataset.mediaEnhanced === "true") return;
  container.dataset.mediaEnhanced = "true";
  for (const anchor of container.querySelectorAll("a[href]")) {
    const href = imageUrl(anchor.getAttribute("href"));
    if (!href || anchor.querySelector("img")) continue;
    const label = anchor.textContent.trim();
    const bare = !label || label === anchor.getAttribute("href").trim() || imageUrl(label);
    if (bare) anchor.replaceWith(mediaFigure(href));
    else anchor.dataset.image = href;
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("a, pre, code, figure, .aa-canvas")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const standalone = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const href = imageUrl(node.data);
    if (href) standalone.push([node, href]);
  }
  for (const [node, href] of standalone) node.replaceWith(mediaFigure(href));
}

// Existing <img> in archived bodies: no referrer, lazy, and a link when they fail.
export function decorateImages(container) {
  for (const image of container.querySelectorAll("img")) {
    if (image.closest(".media-figure")) continue;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      const link = originalLink(image.src, image.alt || "이미지 링크");
      link.className = "image-fallback";
      image.replaceWith(link);
    }, { once: true });
  }
}

export function arcaPaths(container) {
  return [...new Set([...container.querySelectorAll("[data-arca-path]")].map((node) => node.dataset.arcaPath))];
}

// Replaces Arcalive images (live or expired) with archived copies; returns paths still missing.
export function applyArchivedMedia(container, media) {
  const missing = new Set();
  for (const node of container.querySelectorAll("[data-arca-path]")) {
    const archived = media[node.dataset.arcaPath];
    if (!archived) {
      missing.add(node.dataset.arcaPath);
      continue;
    }
    const figure = mediaFigure(archived.url, { caption: "보관된 이미지" });
    figure.dataset.archived = "true";
    node.replaceWith(figure);
  }
  return [...missing];
}

