import { requireHumanAccess } from "./access.js";

const READER_URL = "https://redstm-edge.redstm-archive-private.workers.dev/text";

function redirect(request) {
  const target = new URL(READER_URL);
  const source = new URL(request.url).searchParams;
  const lane = source.get("lane");
  if (["novel", "arcalive", "saved"].includes(lane)) target.searchParams.set("lane", lane);
  for (const key of ["q", "work", "chapter", "item"]) {
    const value = source.get(key);
    if (value && value.length <= 256) target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "private, no-store",
      "Location": target.href,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleAuthedRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Allow": "GET, HEAD", "Cache-Control": "private, no-store" },
    });
  }
  return redirect(request);
}

export default {
  async fetch(request, env) {
    try {
      await requireHumanAccess(request, env);
    } catch {
      return new Response("Access required", {
        status: 401,
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    return handleAuthedRequest(request);
  },
};
