// 서재 pieces (DESIGN §7.3, §9; docs/24 §8.2): the continue card's cover and quote, the shelf of
// works being read, and the first-visit block. app.js decides what to show; this module only
// builds and fills the DOM.

import { createTypeCover, workHue } from "/type-cover.js";

// A shelf card: cover M, title, one meta line, and an optional new-episode badge.
export function shelfCard({ title, meta = [], badge = "", hueKey, source = "", progress = null, newCount = 0, open }) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-item shelf-card";
  const name = document.createElement("strong");
  name.textContent = title;
  const info = document.createElement("span");
  info.textContent = meta.filter(Boolean).join(" · ");
  button.append(createTypeCover({ title, source, size: "m", hue: workHue(hueKey), newCount, progress }), name, info);
  if (badge) {
    const mark = document.createElement("span");
    mark.className = "home-badge";
    mark.textContent = badge;
    button.append(mark);
  }
  button.addEventListener("click", open);
  item.append(button);
  return item;
}

// The continue card's cover (the one "my place" on Home, so its progress is the ribbon) and the
// sentence the reader last saw. An empty quote hides its line.
export function fillContinueCard({ cover, quote, when }, { title, source, hueKey, progress, sentence = "", readAt = "" }) {
  cover.replaceChildren(createTypeCover({ title, source, size: "m", hue: workHue(hueKey), progress, mine: true }));
  quote.textContent = sentence;
  quote.hidden = !sentence;
  when.textContent = relativeTime(readAt);
}

const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((then - now) / 60_000);
  if (Math.abs(minutes) < 1) return " · 방금";
  if (Math.abs(minutes) < 60) return ` · ${relative.format(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return ` · ${relative.format(hours, "hour")}`;
  return ` · ${relative.format(Math.round(hours / 24), "day")}`;
}
