// Turns direct image links in reading bodies into inline images. Only http(s) URLs whose path
// ends in a raster image extension qualify; anything else stays a link. Images load without a
// referrer; a failed image falls back to its original link without breaking the body.

const IMAGE_PATH = /\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
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
export function renderPlainTextWithMedia(container, text) {
  const fragment = document.createDocumentFragment();
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    appendLinkedText(fragment, buffer);
    buffer = "";
  };
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    const href = imageUrl(line);
    if (href) {
      flush();
      fragment.append(mediaFigure(href));
      return;
    }
    buffer += line + (index < lines.length - 1 ? "\n" : "");
  });
  flush();
  container.replaceChildren(fragment);
}

function appendLinkedText(target, text) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    let href;
    try {
      href = new URL(raw).href;
    } catch {
      continue;
    }
    if (match.index > last) target.append(text.slice(last, match.index));
    const link = originalLink(href, raw);
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
