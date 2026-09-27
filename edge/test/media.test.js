import assert from "node:assert/strict";
import test from "node:test";

import { imageUrl } from "../public/media.js";

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
