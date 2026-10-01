import { expect, test } from "@playwright/test";
import { useLongCollection } from "./typemoon-fixture.js";

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
