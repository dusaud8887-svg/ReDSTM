import { expect, test } from "@playwright/test";
import { useLongCollection } from "./typemoon-fixture.js";
import { arcalivePost, arcaliveWork, novelWork, useTextArchive } from "./text-fixture.js";

async function enableContinuous(page) {
  await page.goto("/settings");
  await page.locator('[data-reading-mode="continuous"]').click();
  await expect(page.locator('[data-reading-mode="continuous"]')).toHaveAttribute("aria-checked", "true");
}

async function enterPreview(page, key) {
  const preview = page.locator(`.continuous-document[data-continuous-key="${key}"]`);
  await expect(preview).toBeAttached();
  await page.locator("#reader-pane").evaluate((pane, key) => {
    const target = document.querySelector(`.continuous-document[data-continuous-key="${key}"]`);
    pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
  }, key);
}

test("P6-5 document window preserves visible prose while evicting an earlier document", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createContinuousReader } = await import("/continuous-reader.js");
    const scroller = document.createElement("div");
    scroller.style.cssText = "position:fixed;inset:0;height:400px;overflow:auto;overflow-anchor:none;background:white";
    const body = document.createElement("div");
    body.id = "continuous-fixture"; scroller.append(body); document.body.append(scroller);
    let number = 1;
    const descriptor = () => ({ key: `chapter:${number}`, workId: "work:1", title: `${number}화` });
    const render = () => {
      reader.prepare(descriptor());
      body.replaceChildren(...Array.from({ length: 40 }, (_, index) => {
        const line = document.createElement("p"); line.textContent = `${number}화 문장 ${index}`;
        line.style.cssText = "height:40px;margin:0"; return line;
      }));
      reader.commit(descriptor());
    };
    const reader = createContinuousReader({ body, scroller, enabled: () => true, step: async (direction) => { number += direction; render(); } });
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    render(); await frame();
    const deltas = [];
    for (let chapter = 1; chapter <= 3; chapter++) {
      const visible = body.children[30];
      scroller.scrollTop += visible.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const before = visible.getBoundingClientRect().top;
      await reader.move(1); await frame();
      deltas.push(Math.abs(visible.getBoundingClientRect().top - before));
    }
    const keys = [...scroller.querySelectorAll("[data-continuous-key]")].map((node) => node.dataset.continuousKey);
    const count = scroller.children.length;
    scroller.scrollTop += body.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    await reader.move(-1); await frame();
    const back = body.textContent;
    reader.reset();
    return { deltas, keys, count, back, resetCount: scroller.children.length };
  });
  expect(result.deltas.every((delta) => delta < 2)).toBe(true);
  expect(result.keys).toEqual(["chapter:2", "chapter:3"]);
  expect(result.count).toBe(3);
  expect(result.back).toContain("3화 문장 0");
  expect(result.resetCount).toBe(1);
});

test("P6-5 a short next episode is displayed without marking it read until it reaches the viewport top", async ({ page }) => {
  await useLongCollection(page, 3);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createContinuousReader } = await import("/continuous-reader.js");
    const scroller = document.createElement("div");
    scroller.style.cssText = "position:fixed;inset:0;height:200px;overflow:auto;overflow-anchor:none;background:white";
    const body = document.createElement("div"); body.style.height = "160px";
    body.textContent = "짧은 첫 회차"; scroller.append(body); document.body.append(scroller);
    const opened = [];
    const reader = createContinuousReader({ body, scroller, enabled: () => true, step: async () => {
      opened.push("two");
      reader.prepare({ key: "two", workId: "work", title: "2화" });
      body.textContent = "다음 회차"; body.style.height = "400px";
      reader.commit({ key: "two", workId: "work", title: "2화" });
    } });
    reader.commit({ key: "one", workId: "work", title: "1화" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const preview = document.createElement("div"); preview.style.height = "400px";
    preview.textContent = "다음 회차";
    reader.offer({ key: "two", workId: "work", title: "2화" }, preview);
    const before = { key: reader.currentKey, count: opened.length, text: scroller.textContent };
    scroller.scrollTop = 130;
    const top = preview.getBoundingClientRect().top;
    reader.observeScroll(130);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { before, after: reader.currentKey, opened, count: scroller.children.length, topDelta: body.getBoundingClientRect().top - top };
  });
  expect(result.before).toEqual({ key: "one", count: 0, text: "짧은 첫 회차다음 회차" });
  expect(result.after).toBe("two");
  expect(result.opened).toEqual(["two"]);
  expect(result.count).toBe(2);
  expect(Math.abs(result.topDelta)).toBeLessThan(2);
});

test("P6-5 TypeMoon continues in one history entry, keeps per-document progress and returns through retained prose", async ({ page }) => {
  await useLongCollection(page, 6);
  await enableContinuous(page);
  await page.goto("/read/board_a/1");
  await expect(page.locator("#reader-title")).toHaveText("1편 제목");
  await expect(page.locator('.continuous-document[data-continuous-key="typemoon:board_a:2"]')).toBeAttached();
  const length = await page.evaluate(() => history.length);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).history["board_a:2"])).toBeUndefined();
  for (let chapter = 2; chapter <= 4; chapter++) {
    await enterPreview(page, `typemoon:board_a:${chapter}`);
    await expect(page.locator("#reader-title")).toHaveText(`${chapter}편 제목`);
    await expect(page).toHaveURL(new RegExp(`/read/board_a/${chapter}$`));
  }
  await expect(page.locator("#aa-host > .archive-body")).toHaveCount(3);
  expect(await page.evaluate(() => history.length)).toBe(length);
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).history);
  expect(records["board_a:1"].progress).toBeGreaterThanOrEqual(0.98);
  expect(records["board_a:3"].documentId).toBe("typemoon:board_a:3");
  await page.locator("#reader-pane").evaluate((pane) => {
    const previous = document.querySelector('.continuous-document[data-continuous-key="typemoon:board_a:3"]');
    pane.scrollTop += previous.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
  });
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
  await page.locator("#reader-pane").evaluate((pane) => { pane.scrollTop += 400; });
  await page.waitForTimeout(350);
  const quote = await page.evaluate(() => JSON.parse(localStorage.getItem("redstm.userState.v2")).history["board_a:3"].anchor);
  await page.reload();
  await expect(page.locator("#reader-title")).toHaveText("3편 제목");
  await expect.poll(() => page.locator("#reader-pane").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(200);
  await expect(page.locator("#archive-body")).toContainText(quote);
  await page.goBack();
  await expect(page.locator("#reader")).toBeHidden();
});

for (const source of ["novel", "arcalive"]) {
  test(`P6-5 ${source} previews unread chapters and saves each original locator when scrolling across the boundary`, async ({ page }) => {
    await useLongCollection(page, 3);
    const novel = novelWork({ id: 1, title: "이어 읽는 소설", chapters: 5 });
    const posts = [1, 2, 3, 4, 5].map((id) => arcalivePost({ id, title: `${id}편` }));
    const work = arcaliveWork({ key: "chain", title: "이어 읽는 연재", posts });
    await useTextArchive(page, { novels: [novel], posts, works: [work] });
    await enableContinuous(page);
    const route = source === "novel" ? `/text?lane=novel&work=${encodeURIComponent(novel.item.work_id)}&chapter=1-1` :
      `/text?lane=arcalive&view=works&work=${encodeURIComponent(work.item.work_id)}&item=${encodeURIComponent(posts[0].identity)}`;
    const key = (chapter) => source === "novel" ? `novel:toki:1-${chapter}` : posts[chapter - 1].identity;
    const storedKey = (chapter) => source === "novel" ? `novel:${novel.item.work_id}:1-${chapter}` : key(chapter);
    const title = (chapter) => `${chapter}${source === "novel" ? "화" : "편"}`;
    await page.goto(route);
    await expect(page.locator("#reader-title")).toHaveText(title(1));
    await expect(page.locator(`.continuous-document[data-continuous-key="${key(2)}"]`)).toBeAttached();
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem("redstm.textState.v1")).history[key], storedKey(2))).toBeUndefined();
    const length = await page.evaluate(() => history.length);
    for (let chapter = 2; chapter <= 4; chapter++) {
      await enterPreview(page, key(chapter));
      await expect(page.locator("#reader-title")).toHaveText(title(chapter));
    }
    await expect(page.locator("#aa-host > .archive-body")).toHaveCount(3);
    expect(await page.evaluate(() => history.length)).toBe(length);
    const record = await page.evaluate((key) => JSON.parse(localStorage.getItem("redstm.textState.v1")).history[key], storedKey(3));
    expect(record.progress).toBeGreaterThanOrEqual(0.98);
    expect(record.documentId).toBe(key(3));
    expect(record.loc).toBeTruthy();
    await page.goBack();
    await expect(page.locator("#reader")).toBeHidden();
  });
}
