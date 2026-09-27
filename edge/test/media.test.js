import assert from "node:assert/strict";
import test from "node:test";

import { imageUrl, isExpiredSignedUrl, taggedMedia, unwrapLink } from "../public/media.js";

test("accepts direct raster image URLs, keeping the query and upgrading to https", () => {
  assert.equal(imageUrl("https://img.example/a/b.JPG?token=1"), "https://img.example/a/b.JPG?token=1");
  assert.equal(imageUrl("  http://img.example/x.webp  "), "https://img.example/x.webp");
  assert.equal(imageUrl("https://ac.namu.la/20260101/abc.png?type=orig"), "https://ac.namu.la/20260101/abc.png?type=orig");
});

test("rejects pages, non-image paths, credentials, and unsafe schemes", () => {
  for (const candidate of [
    "https://example.test/page?name=image.jpg",
    "https://example.test/board.php?bo_table=novel&wr_id=1",
    "https://user:pass@example.test/a.png",
    "javascript:alert(1)//a.png",
    "data:image/png;base64,AAAA",
    "file:///c:/a.png",
    "https://example.test/vector.svg",
    "https://example.test/a.jpg 설명",
    "사진 https://example.test/a.jpg",
    "",
  ]) {
    assert.equal(imageUrl(candidate), null, candidate);
  }
});

test("reads text-archive media lines and unwraps redirect links", () => {
  const signed = "https://ac-o.arca.live/20241221sac/b61f.jpg?expires=1785653056&key=74QT-LQzh0NGH404Ha4Rvw&type=orig";
  assert.deepEqual(taggedMedia(`[image] ${signed}`), { kind: "image", href: signed });
  assert.deepEqual(taggedMedia("[video] https://ac.arca.live/v/abc.mp4?expires=1&key=k"), { kind: "video", href: "https://ac.arca.live/v/abc.mp4?expires=1&key=k" });
  assert.equal(taggedMedia("[image] javascript:alert(1)"), null);
  assert.equal(taggedMedia("[AI 번역] https://example.test/a.png"), null);
  assert.equal(taggedMedia("본문 [image] https://example.test/a.png"), null);
  assert.equal(unwrapLink("https://unsafelink.com/https://novelpia.com/novel/391903"), "https://novelpia.com/novel/391903");
  assert.equal(unwrapLink("https://arca.live/b/x/1"), "https://arca.live/b/x/1");
});

test("recognises expired signed media links", () => {
  const url = (expires) => `https://ac-o.arca.live/a.png?expires=${expires}&key=k&type=orig`;
  assert.equal(isExpiredSignedUrl(url(1785653056), 1790000000), true);
  assert.equal(isExpiredSignedUrl(url(1795653056), 1790000000), false);
  assert.equal(isExpiredSignedUrl("https://example.test/a.png", 1790000000), false);
});
