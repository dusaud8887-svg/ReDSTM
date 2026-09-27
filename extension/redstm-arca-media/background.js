// Drains the ReDSTM text-media queue using this Chrome's own Arcalive login: open the post,
// take the image URLs it serves now, shrink them, and upload them to the ReDSTM archive.

import {
  DEFAULT_BASE_URL, DENIED_PLACEHOLDER_SHA256, WEBP_QUALITY, isLoginWall, signedImageUrls, targetSize,
} from "./lib.js";

const POSTS_PER_RUN = 5;
const PAUSE_BETWEEN_POSTS_MS = 2500;
const PAUSE_BETWEEN_IMAGES_MS = 400;
const MEDIA_HEADER = { "X-ReDSTM-Media": "1" };
let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settings() {
  const stored = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL, auto: true });
  return { baseUrl: stored.baseUrl.replace(/\/+$/, ""), auto: stored.auto };
}

async function saveStatus(patch) {
  const { status = {} } = await chrome.storage.local.get("status");
  await chrome.storage.local.set({ status: { ...status, ...patch, updatedAt: new Date().toISOString() } });
}

async function redstm(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { credentials: "include", redirect: "manual", ...init });
  // An Access login page instead of the API: the ReDSTM session in this Chrome has expired.
  if (response.type === "opaqueredirect" || response.status === 401 || (response.status === 403 && !init.method)) {
    throw Object.assign(new Error("ReDSTM에 로그인되어 있지 않습니다. 사이트를 한 번 열어 주세요."), { code: "redstm_login" });
  }
  return response;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// WebP at most 1600px wide; animated GIFs and already-small files keep their original bytes.
async function prepare(blob) {
  const original = await blob.arrayBuffer();
  if (await sha256Hex(original) === DENIED_PLACEHOLDER_SHA256) throw new Error("placeholder");
  const bitmap = await createImageBitmap(blob);
  const size = targetSize(bitmap.width, bitmap.height);
  const keepOriginal = blob.type === "image/gif" ||
    (size.width === bitmap.width && ["image/webp", "image/jpeg"].includes(blob.type) && original.byteLength < 350_000);
  if (keepOriginal) {
    bitmap.close();
    return { bytes: original, type: blob.type, width: size.width, height: size.height };
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const webp = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  return { bytes: await webp.arrayBuffer(), type: "image/webp", width: size.width, height: size.height };
}

async function archivePost(baseUrl, item) {
  const page = await fetch(item.post_url, { credentials: "include" });
  const html = await page.text();
  if (isLoginWall(page.status, html)) throw new Error(`아카라이브 로그인 필요 (${page.status})`);
  if (!page.ok) throw new Error(`원문 응답 ${page.status}`);
  const current = signedImageUrls(html);
  let stored = 0;
  for (const path of item.paths) {
    const url = current.get(path);
    if (!url) continue; // no longer in the post: nothing to fetch
    const image = await fetch(url, { credentials: "include" });
    if (!image.ok) throw new Error(`이미지 응답 ${image.status}`);
    const prepared = await prepare(await image.blob());
    const upload = await redstm(baseUrl, `/api/v1/text/media/object?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        ...MEDIA_HEADER,
        "Content-Type": prepared.type,
        "X-Media-Width": String(prepared.width),
        "X-Media-Height": String(prepared.height),
      },
      body: prepared.bytes,
    });
    if (!upload.ok) throw new Error(`업로드 응답 ${upload.status}`);
    stored += 1;
    await sleep(PAUSE_BETWEEN_IMAGES_MS);
  }
  return stored;
}

async function report(baseUrl, postUrl, status, error = null) {
  await redstm(baseUrl, "/api/v1/text/media/queue/result", {
    method: "POST",
    headers: { ...MEDIA_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ post_url: postUrl, status, error }),
  });
}

export async function run() {
  if (running) return;
  running = true;
  const { baseUrl } = await settings();
  let stored = 0;
  let failed = 0;
  try {
    const queue = await (await redstm(baseUrl, `/api/v1/text/media/queue?limit=${POSTS_PER_RUN}`)).json();
    for (const item of queue.posts ?? []) {
      try {
        stored += await archivePost(baseUrl, item);
        await report(baseUrl, item.post_url, "done");
      } catch (error) {
        failed += 1;
        if (error.code === "redstm_login") throw error;
        await report(baseUrl, item.post_url, "failed", String(error.message).slice(0, 200));
      }
      await sleep(PAUSE_BETWEEN_POSTS_MS);
    }
    await saveStatus({ lastRun: new Date().toISOString(), lastStored: stored, lastFailed: failed, message: "", counts: queue.counts ?? {} });
  } catch (error) {
    await saveStatus({ lastRun: new Date().toISOString(), lastStored: stored, lastFailed: failed, message: error.message });
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("drain", { periodInMinutes: 10 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("drain", { periodInMinutes: 10 }));
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "drain" && (await settings()).auto) await run();
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "run") {
    run().then(() => respond({ ok: true }));
    return true;
  }
  return false;
});
