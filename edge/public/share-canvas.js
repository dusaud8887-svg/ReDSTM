// Share images drawn straight onto a canvas (docs/24 §8.14, D-25): no DOM capture, so the
// Content-Security-Policy stays as it is. Excerpt cards are 1080×1350; an AA scene keeps its own
// proportions with its lines, font and colours as preserved.

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const AA_MAX_WIDTH = 4096;
export const QUOTE_FONT = "MaruBuri";
export const UI_FONT = '"Pretendard Variable"';
export const AA_FONT = 'Saitamaar, "MS PGothic", monospace';
export const CREDIT = "개인 기록용 인용 — 원문 저작권은 작가에게 있습니다";

// Work colours for the card, as the light and dark values of tokens.css .hue-0 … .hue-9.
const HUES = [
  ["#D9ECFF", "#316CA5", "#1D2B3B", "#85BCF5"], ["#D0F0F8", "#007890", "#132F35", "#62C8DF"],
  ["#D6F1E2", "#177C52", "#1A3024", "#7BCBA1"], ["#E6EDD4", "#61721C", "#282D19", "#AFC177"],
  ["#F6E8D0", "#8A6000", "#332815", "#D9B06B"], ["#FFE3D7", "#9C522E", "#39251B", "#EDA382"],
  ["#FDE1ED", "#974C72", "#37232C", "#E89DC0"], ["#F1E4FC", "#7C5598", "#2F2537", "#CBA6E8"],
  ["#E2E8FF", "#5762A8", "#25293C", "#A4B3F8"], ["#E9E9E9", "#696969", "#2A2A2A", "#B7B7B7"],
];

// 작품색 · 밝게 · 어둡게.
export function cardPalette(hue, tone) {
  const [lightBg, lightMark, darkBg, darkMark] = HUES[hue] ?? HUES[9];
  if (tone === "dark") return { background: "#161514", ink: "#EDEBE6", muted: "#A8A49C", band: darkMark || darkBg };
  if (tone === "light") return { background: "#FBFAF7", ink: "#1C1B19", muted: "#6B675F", band: lightMark };
  return { background: lightBg, ink: "#1C1B19", muted: "#4F4B44", band: lightMark };
}

const graphemes = (text) => [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

// Lines that fit `maxWidth` by `measure`, breaking at word boundaries (Intl.Segmenter) and inside a
// word only when one word is wider than the line. Past `maxLines` the last line ends with "…".
export function wrapText(text, measure, maxWidth, maxLines) {
  const words = new Intl.Segmenter("ko", { granularity: "word" });
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const { segment } of words.segment(paragraph)) {
      if (measure(line + segment) <= maxWidth) {
        line += segment;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = segment.trimStart();
      // One word wider than the whole line is broken by characters.
      while (measure(line) > maxWidth) {
        let fit = "";
        for (const character of graphemes(line)) {
          if (measure(fit + character) > maxWidth && fit) break;
          fit += character;
        }
        lines.push(fit);
        line = line.slice(fit.length);
      }
    }
    lines.push(line.trimEnd());
  }
  while (lines.length > 1 && !lines.at(-1)) lines.pop();
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  let last = kept.at(-1);
  while (last && measure(`${last}…`) > maxWidth) last = graphemes(last).slice(0, -1).join("");
  kept[kept.length - 1] = `${last.trimEnd()}…`;
  return { lines: kept, truncated: true };
}

export function drawExcerptCard(ctx, { quote, work = "", title = "", hue = 9, tone = "work" }) {
  const palette = cardPalette(hue, tone);
  ctx.canvas.width = CARD_WIDTH;
  ctx.canvas.height = CARD_HEIGHT;
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.fillStyle = palette.band;
  ctx.fillRect(0, 0, CARD_WIDTH, 28);
  ctx.textBaseline = "alphabetic";
  ctx.font = `44px ${QUOTE_FONT}`;
  const { lines, truncated } = wrapText(quote, (text) => ctx.measureText(text).width, CARD_WIDTH - 192, 9);
  ctx.fillStyle = palette.ink;
  const lineHeight = 70;
  const top = 220;
  for (const [index, line] of lines.entries()) ctx.fillText(line, 96, top + index * lineHeight);
  if (truncated) {
    ctx.font = `600 28px ${UI_FONT}`;
    ctx.fillStyle = palette.muted;
    ctx.fillText("이어짐", 96, top + lines.length * lineHeight + 8);
  }
  ctx.fillStyle = palette.band;
  ctx.fillRect(96, 1130, 6, 92);
  ctx.font = `600 32px ${UI_FONT}`;
  ctx.fillStyle = palette.ink;
  const source = (text) => wrapText(text, (value) => ctx.measureText(value).width, CARD_WIDTH - 260, 1).lines[0] ?? "";
  ctx.fillText(source(work || title), 124, 1166);
  ctx.font = `28px ${UI_FONT}`;
  ctx.fillStyle = palette.muted;
  if (work && title) ctx.fillText(source(title), 124, 1210);
  ctx.font = `700 28px ${UI_FONT}`;
  ctx.textAlign = "right";
  ctx.fillText("ReDSTM", CARD_WIDTH - 96, CARD_HEIGHT - 72);
  ctx.textAlign = "left";
  return { truncated };
}

// An AA scene: whole lines of runs [{ text, color }] in the AA font at the AA line height, on the
// picture's own background; wider than 4,096px it is drawn smaller.
export function aaSceneSize(lines, measure, fontSize) {
  const padding = Math.round(fontSize * 2);
  const natural = Math.max(1, ...lines.map((runs) => measure(runs.map((run) => run.text).join(""))));
  const scale = Math.min(1, (AA_MAX_WIDTH - padding * 2) / natural);
  const size = Math.max(1, Math.floor(fontSize * scale * 100) / 100);
  return { fontSize: size, lineHeight: size * 1.125, padding, width: Math.ceil(natural * (size / fontSize) + padding * 2) };
}

export function drawAaScene(ctx, { lines, background, fontSize = 16 }) {
  ctx.font = `${fontSize}px ${AA_FONT}`;
  const size = aaSceneSize(lines, (text) => ctx.measureText(text).width, fontSize);
  ctx.canvas.width = Math.min(AA_MAX_WIDTH, size.width);
  ctx.canvas.height = Math.ceil(lines.length * size.lineHeight + size.padding * 2);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.font = `${size.fontSize}px ${AA_FONT}`;
  ctx.textBaseline = "top";
  lines.forEach((runs, row) => {
    let x = size.padding;
    for (const run of runs) {
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, x, size.padding + row * size.lineHeight);
      x += ctx.measureText(run.text).width;
    }
  });
  return size;
}

export function canvasBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
