import assert from "node:assert/strict";
import test from "node:test";

import UFuzzy from "@leeoniya/ufuzzy";
import * as hangul from "es-hangul";

import { createSuggester, createSuggestIndex, suggest } from "../public/search-suggest.js";

const titles = ["세이버와 일곱 번째 밤", "세이버 얼터 관찰 일지", "마술사의 밤", "달그림자 서고의 마술사", "Fate/stay night 번역", "ＡＢＣ 모음", "고양이 공방"];
const index = createSuggestIndex(titles.map((title, key) => ({ key, title, kind: "work" })), { hangul, UFuzzy });
const names = (hits) => hits.map((hit) => hit.item.title);

test("partial matches come first, with the match range on the title", () => {
  const found = suggest(index, "세이버");
  assert.deepEqual(names(found.exact), ["세이버와 일곱 번째 밤", "세이버 얼터 관찰 일지"]);
  assert.deepEqual(found.exact[0].ranges, [[0, 3]]);
  assert.equal(found.normalizeVersion, 1);
  // NFKC and case: full-width Latin and a lowercase query still match.
  assert.deepEqual(names(suggest(index, "abc").exact), ["ＡＢＣ 모음"]);
  assert.deepEqual(names(suggest(index, "fate/stay").exact), ["Fate/stay night 번역"]);
});

test("initial consonants find titles when every character can be one", () => {
  assert.deepEqual(names(suggest(index, "ㄷㄱㄹㅈ").choseong), ["달그림자 서고의 마술사"]);
  assert.deepEqual(suggest(index, "ㄷ그").choseong, []);
});

test("a one-jamo typo lands under similar titles, mapped back to syllables", () => {
  const found = suggest(index, "세이바");
  assert.deepEqual(found.exact, []);
  assert.ok(names(found.similar).includes("세이버와 일곱 번째 밤"));
  const hit = found.similar.find((item) => item.item.title === "세이버와 일곱 번째 밤");
  assert.deepEqual(hit.ranges, [[0, 3]]);
  assert.ok(names(suggest(index, "마슐사").similar).includes("달그림자 서고의 마술사"));
});

test("Latin keys typed for Hangul are offered as a conversion only when nothing matches", () => {
  assert.equal(suggest(index, "tpdlqj").qwerty, "세이버");
  assert.equal(suggest(index, "fate").qwerty, "");
});

test("each group is capped", () => {
  const many = createSuggestIndex(Array.from({ length: 50 }, (_, key) => ({ key, title: `밤의 이야기 ${key}`, kind: "work" })), { hangul, UFuzzy });
  assert.equal(suggest(many, "밤의").exact.length, 20);
});

test("a late answer to an older query is dropped (T19)", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const suggester = createSuggester(() => (calls++ === 0 ? slow.then(() => index) : index));
  const shown = [];
  const first = suggester.request("세이버", (result) => shown.push(result.query));
  const second = suggester.request("마술사", (result) => shown.push(result.query));
  release();
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.deepEqual(shown, ["마술사"]);
});
