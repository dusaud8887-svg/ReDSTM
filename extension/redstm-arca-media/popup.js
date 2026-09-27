import { DEFAULT_BASE_URL } from "./lib.js";

const $ = (id) => document.getElementById(id);

async function refresh() {
  const { status = {}, baseUrl = DEFAULT_BASE_URL, auto = true } = await chrome.storage.local.get(["status", "baseUrl", "auto"]);
  $("base").value = baseUrl;
  $("auto").checked = auto;
  $("pending").textContent = status.counts?.pending ?? 0;
  $("done").textContent = status.counts?.done ?? 0;
  $("failed").textContent = status.counts?.failed ?? 0;
  $("last").textContent = status.lastRun
    ? `${new Date(status.lastRun).toLocaleString("ko-KR")} · 저장 ${status.lastStored ?? 0}장`
    : "아직 없음";
  $("message").textContent = status.message ?? "";
  $("message").hidden = !status.message;
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("run").textContent = "수집 중…";
  await chrome.runtime.sendMessage({ type: "run" });
  $("run").disabled = false;
  $("run").textContent = "지금 수집";
  await refresh();
});
$("auto").addEventListener("change", () => chrome.storage.local.set({ auto: $("auto").checked }));
$("base").addEventListener("change", () => {
  const value = $("base").value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(value)) chrome.storage.local.set({ baseUrl: value });
});
chrome.storage.onChanged.addListener(refresh);
void refresh();
