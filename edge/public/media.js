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

export function mediaFigure(href) {
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
  caption.append(originalLink(href, `원본 · ${hostOf(href)}`));
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
export function renderPlainTextWithMedia(container, text, { sourceUrl = "" } = {}) {
  const fragment = document.createDocumentFragment();
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    appendLinkedText(fragment, buffer);
    buffer = "";
  };
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    const tagged = taggedMedia(line);
    const href = tagged ? null : imageUrl(line);
    if (tagged || href) {
      flush();
      const url = tagged?.href ?? href;
      const kind = tagged?.kind ?? "image";
      fragment.append(isExpiredSignedUrl(url) ? expiredMedia(url, kind, sourceUrl)
        : kind === "video" ? mediaVideo(url) : mediaFigure(url));
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
