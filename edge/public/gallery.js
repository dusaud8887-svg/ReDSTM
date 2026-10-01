// Image gallery (docs/24 §8.18): PhotoSwipe over the pictures of the open body. Pinch, double tap,
// swipe between pictures and drag down to close come from PhotoSwipe; the dialog around it keeps
// Back, 닫기 and the actions (원본 열기 · 실제 크기 · 공유).

import PhotoSwipe from "/vendor/photoswipe@5.4.4/photoswipe.esm.min.js";

const MEASURE_TIMEOUT = 2500;
const STYLES = "/vendor/photoswipe@5.4.4/photoswipe.css";

// The gallery's stylesheet loads on first use, not with every page.
let styles = null;
function loadStyles() {
  styles ??= new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = STYLES;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
  return styles;
}

// Taller than 1:3 opens filling the width and is read by panning down, not shrunk to a sliver.
export function isTall(width, height) {
  return height > width * 3;
}

// Pictures that can open: loaded or loadable images and image links, in document order. A figure
// that failed to load (expired or never preserved) is left out.
export function galleryTargets(container) {
  return [...container.querySelectorAll("img, a[data-image]")].filter((element) => !element.closest(".media-figure.failed"));
}

export function sourceOf(element) {
  return element.dataset.image ?? element.currentSrc ?? element.src ?? "";
}

// Natural size, once loaded (PhotoSwipe needs it up front). Null when the picture does not load.
function measure(element) {
  if (element.tagName === "IMG" && element.complete && element.naturalWidth) {
    return Promise.resolve({ width: element.naturalWidth, height: element.naturalHeight });
  }
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.src = sourceOf(element);
  const loaded = image.decode().then(() => ({ width: image.naturalWidth, height: image.naturalHeight }), () => null);
  const late = new Promise((resolve) => setTimeout(() => resolve(null), MEASURE_TIMEOUT));
  return Promise.race([loaded, late]);
}

// Opens at `target` (an image or image link inside `container`). Resolves to the PhotoSwipe
// instance, or null when the picture cannot be shown.
export async function openGallery({ container, target, appendTo, onChange, onClose }) {
  const targets = galleryTargets(container);
  const [sizes] = await Promise.all([Promise.all(targets.map(measure)), loadStyles()]);
  const items = targets.flatMap((element, index) => (sizes[index]?.width
    ? [{ src: sourceOf(element), width: sizes[index].width, height: sizes[index].height, alt: element.alt || "본문 이미지", element }]
    : []));
  const index = items.findIndex((item) => item.element === target);
  if (index < 0) return null;
  const gallery = new PhotoSwipe({
    dataSource: items,
    index,
    appendToEl: appendTo,
    bgOpacity: 1,
    showHideAnimationType: "none",
    closeOnVerticalDrag: true,
    pinchToClose: true,
    // Esc, Back, focus and closing belong to the dialog and the overlay manager.
    escKey: false,
    trapFocus: false,
    returnFocus: false,
    zoom: false,
    close: false,
    initialZoomLevel: (zoomLevel) => (isTall(zoomLevel.itemData.width, zoomLevel.itemData.height) ? zoomLevel.fill : zoomLevel.fit),
  });
  // Preserved pictures come from their original hosts, which may refuse a referrer.
  gallery.on("contentLoadImage", ({ content }) => { content.element.referrerPolicy = "no-referrer"; });
  gallery.on("change", () => onChange?.(gallery.currSlide?.data ?? null));
  gallery.on("destroy", () => onClose?.());
  gallery.init();
  onChange?.(gallery.currSlide?.data ?? null);
  return gallery;
}
