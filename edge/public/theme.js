// App theme and Reader surface (DESIGN §2.4). The app theme drives the chrome; the reading
// surface (기본 · 종이 · 먹), brightness and warmth belong to the Reader alone, so a light app can
// hold an ink-black page. Settings are validated by user-state.js; this module only applies them.

export const READER_DIM_MAX = 60;
export const READER_WARM_MAX = 25;

const appColors = { light: "#F7F6F3", dark: "#121413" };
const readerColors = {
  default: { light: "#FDFCFA", dark: "#161918" },
  paper: { light: "#F5EFE3", dark: "#1D1A15" },
  ink: { light: "#000000", dark: "#000000" },
};

export function prefersDark(theme, systemDark) {
  return theme === "dark" || (theme === "system" && systemDark);
}

// The browser bar follows the page behind it: the Reader surface while a body is open.
export function themeColor({ dark, readerOpen, surface = "default" }) {
  const scheme = dark ? "dark" : "light";
  return readerOpen ? (readerColors[surface] ?? readerColors.default)[scheme] : appColors[scheme];
}

export function applyAppearance(settings, systemDark = matchMedia("(prefers-color-scheme: dark)").matches) {
  const root = document.documentElement;
  const dark = prefersDark(settings.theme, systemDark);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.surface = settings.readerSurface;
  root.style.setProperty("--reader-dim", String((settings.readerDim ?? 0) / 100));
  root.style.setProperty("--reader-warm", String((settings.readerWarm ?? 0) / 100));
  return dark;
}

// Under 시스템 each media-scoped meta keeps its own scheme and the browser picks; an explicit
// 밝게/어둡게 sets both.
export function syncThemeColor(settings, readerOpen) {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const dark = settings.theme === "system" ? meta.media.includes("dark") : settings.theme === "dark";
    meta.content = themeColor({ dark, readerOpen, surface: settings.readerSurface });
  }
}
