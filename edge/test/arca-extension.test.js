import assert from "node:assert/strict";
import test from "node:test";

import { arcaPathKey } from "../public/arca-media.js";
import {
  DENIED_PLACEHOLDER_SHA256, isLoginWall, pathKey, signedImageUrls, targetSize,
} from "../../extension/redstm-arca-media/lib.js";
import { ARCA_DENIED_PLACEHOLDER_SHA256 } from "../src/text-media.js";

const path = "20230607sac/ca7acfbf53a12de0d4cdef985e8ace74effc3c2b80b8b9cef11c1b6c7eaf8010.webp";

test("the extension and the Reader agree on Arcalive path keys and the placeholder", () => {
  for (const href of [
    `https://ac-o.arca.live/${path}?expires=1&key=k&type=orig`,
    `https://ac.namu.la/${path}`,
    "https://evil.example/20230607sac/ca7acfbf53a12de0.webp",
    "https://ac-o.arca.live/static/logo.png",
    "not a url",
  ]) {
    assert.equal(pathKey(href), arcaPathKey(href), href);
  }
  assert.equal(DENIED_PLACEHOLDER_SHA256, ARCA_DENIED_PLACEHOLDER_SHA256);
});

test("takes the current signed original URL of each post image", () => {
  const html = `
    <div class="fr-view article-content">
      <img src="//ac-o.arca.live/${path}?expires=1790499616&amp;key=aKpva&amp;type=list" data-originalurl="//ac-o.arca.live/${path}?expires=1790499616&amp;key=aKpva">
      <img class="arca-emoticon" src="//ac-p.namu.la/20230101sac/0123456789abcdef0123.png?expires=1&amp;key=e">
      <img src="https://ac-o.arca.live/20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png?expires=1790499616&amp;key=b&amp;type=orig">
      <img src="/static/logo.png">
    </div>`;
  const urls = signedImageUrls(html);
  assert.deepEqual([...urls.keys()], [path, "20231026sac/7c3492e4ce4b6052a9e2d123e337ca339964275147bd8fe8fe9ad4c4aa71623f.png"]);
  assert.equal(urls.get(path), `https://ac-o.arca.live/${path}?expires=1790499616&key=aKpva&type=orig`);
});

test("shrinks wide images to 1600px and recognises login walls", () => {
  assert.deepEqual(targetSize(3200, 4800), { width: 1600, height: 2400 });
  assert.deepEqual(targetSize(900, 5000), { width: 900, height: 5000 });
  assert.equal(isLoginWall(451, ""), true);
  assert.equal(isLoginWall(200, "<h3>Unavailable For Legal Reasons</h3>"), true);
  assert.equal(isLoginWall(200, "<div class=\"article-content\">본문</div>"), false);
});
