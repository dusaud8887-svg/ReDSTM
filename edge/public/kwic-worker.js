import { runKwic } from "./kwic-core.js";

let active = null;
let parseId = 0;
const parses = new Map();
function cancel() {
  active?.controller.abort();
  for (const pending of parses.values()) pending.reject(new Error("cancelled"));
  parses.clear();
}
self.onmessage = ({ data }) => {
  if (data.type === "parsed") {
    const pending = parses.get(data.parseId);
    if (!pending || pending.queryId !== data.queryId) return;
    parses.delete(data.parseId);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.text);
    return;
  }
  cancel();
  if (data.type !== "search") return;
  const controller = new AbortController();
  active = { queryId: data.queryId, controller };
  const queryId = data.queryId;
  void runKwic(data.entries, {
    query: data.query, signal: controller.signal,
    async load(entry, signal) {
      const response = await fetch(entry.url, { credentials: "same-origin", redirect: "error", signal });
      if (!response.ok || response.redirected || (entry.type !== "typemoon" && /text\/html/i.test(response.headers.get("content-type") || ""))) throw new Error("본문을 확인하지 못했어요");
      const raw = await response.text();
      if (signal.aborted) throw new Error("cancelled");
      // The page uses the Reader's real HTML/text model extraction; workers have no DOMParser.
      return new Promise((resolve, reject) => {
        const id = ++parseId;
        parses.set(id, { queryId, resolve, reject });
        self.postMessage({ type: "parse", queryId, parseId: id, entry, raw });
      });
    },
    onResult: (result) => self.postMessage({ type: "result", queryId, ...result }),
  }).then(() => { if (!controller.signal.aborted) self.postMessage({ type: "done", queryId }); });
};
