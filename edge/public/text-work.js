// Browser copy of crawler/collections.py. Grouping and order keys must stay identical.

const LEADING_TAG = /^\s*\[(?:연재|번역|aa|팬픽|소설|작품)\]\s*/i;
const EXPLICIT_EPISODE = new RegExp(
  "(?<label>(?:(?<season>\\d+)\\s*(?:기|시즌|season)\\s*)?(?:(?:제\\s*)?(?<volume>\\d+)\\s*(?:권|부|volume|vol\\.?|part)\\s*)?(?:제\\s*)?(?<start>\\d+)(?:\\s*(?:~|〜|～|-)\\s*(?<end>\\d+))?\\s*(?:화|회|장|편|chapter|ch\\.?|episode|ep\\.?))\\s*$",
  "i",
);
const HASH_EPISODE = /(?<label>#\s*(?<start>\d+))\s*$/;
const BRACKET_EPISODE = /(?<label>[([]\s*(?<start>\d+)\s*[)\]])\s*$/;
const SPECIAL_EPISODE = /(?<label>프롤로그|서장|막간|외전|특별편|에필로그|prologue|interlude|epilogue)\s*$/i;
const TRAILING_SEPARATOR = /[\s:：/\-–—·]+$/;
const SPECIAL_RANK = {
  프롤로그: 0, 서장: 0, prologue: 0, 막간: 1, interlude: 1, 외전: 2, 특별편: 2, 에필로그: 3, epilogue: 3,
};

function matchingText(title) {
  let value = String(title || "").normalize("NFKC").toLocaleLowerCase("ko-KR").replaceAll("～", "~").replaceAll("〜", "~");
  let match = LEADING_TAG.exec(value);
  while (match) {
    value = value.slice(match[0].length);
    match = LEADING_TAG.exec(value);
  }
  return value.replace(/\s+/g, " ").trim();
}

function finish(value, match) {
  return {
    base: TRAILING_SEPARATOR.test(value.slice(0, match.index))
      ? value.slice(0, match.index).replace(TRAILING_SEPARATOR, "").trim()
      : value.slice(0, match.index).trim(),
    label: match.groups.label.trim(),
  };
}

export function parseTitle(title) {
  const value = matchingText(title);
  const match = EXPLICIT_EPISODE.exec(value) || HASH_EPISODE.exec(value) || BRACKET_EPISODE.exec(value);
  if (match) {
    const start = Number(match.groups.start);
    const end = Number(match.groups.end || start);
    const season = Number(match.groups.season || 0);
    const volume = Number(match.groups.volume || 0);
    const cut = finish(value, match);
    return { base: cut.base, label: cut.label, order: [season, volume, 1, start, end] };
  }
  const special = SPECIAL_EPISODE.exec(value);
  if (special) {
    const label = special.groups.label.trim();
    const cut = finish(value, special);
    return { base: cut.base, label: cut.label, order: [0, 0, SPECIAL_RANK[label.toLocaleLowerCase("ko-KR")], 0, 0] };
  }
  return { base: value, label: null, order: null };
}

function compareOrder(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function serialWorks(posts) {
  const blocks = new Map();
  for (const post of posts) {
    const parsed = parseTitle(post.title);
    if (!parsed.order || parsed.base.replaceAll(" ", "").length < 4) continue;
    const key = `${post.board || ""}\u0000${parsed.base}`;
    const rows = blocks.get(key) || [];
    rows.push({ post, parsed });
    blocks.set(key, rows);
  }
  const works = [];
  const members = new Set();
  for (const key of [...blocks.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rows = blocks.get(key);
    if (rows.length < 2) continue;
    const orders = new Set(rows.map((row) => row.parsed.order.join(",")));
    if (orders.size !== rows.length) continue;
    rows.sort((left, right) => compareOrder(left.parsed.order, right.parsed.order)
      || Number(left.post.post_id) - Number(right.post.post_id));
    for (const row of rows) members.add(row.post);
    works.push({
      title: rows[0].parsed.base,
      posts: rows.map((row) => ({ ...row.post, label: row.parsed.label, order: row.parsed.order })),
    });
  }
  return { works, loose: posts.filter((post) => !members.has(post)) };
}
