import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const now = new Date().toISOString();

function envelope(data) {
  return { api_version: 1, request_id: crypto.randomUUID(), server_time: now, data };
}

async function useOperationsFixture(page, received) {
  await page.route("**/api/v1/ops/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/ops/overview") {
      return route.fulfill({ json: envelope({
        runner: { state: "idle", heartbeat_at: now, next_scheduled_at: "2026-07-12T06:17:00Z", disk_free_bytes: 80 * 2 ** 30 },
        latest_run: { kind: "scheduled", state: "succeeded", started_at: now, changed_posts: 2, failed_posts: 0 },
        active_commands: 0,
      }) });
    }
    if (url.pathname === "/api/v1/ops/runs") {
      return route.fulfill({ json: envelope({ items: [{
        run_id: "scheduled-fixture", kind: "scheduled", source: "systemd", state: "succeeded",
        started_at: now, changed_posts: 2, failed_posts: 0, boards_ok: 46, boards_failed: 0,
      }], next_cursor: null }) });
    }
    if (url.pathname === "/api/v1/ops/boards") {
      return route.fulfill({ json: envelope({ items: [{
        board_id: "aa_19", last_outcome: "succeeded", last_scanned_at: now,
        discovered: 2, changed: 1, pending: 0, retry: 0, dead: 0,
      }], next_cursor: null }) });
    }
    if (url.pathname === "/api/v1/ops/releases") {
      return route.fulfill({ json: envelope({
        current: { release_id: "a".repeat(64), activated_at: now, counts: { post_count: 282239, comment_count: 3729706, board_count: 46, collection_count: 1200 } },
        previous: null,
      }) });
    }
    if (url.pathname === "/api/v1/ops/commands" && request.method() === "POST") {
      received.push({ headers: request.headers(), body: request.postDataJSON() });
      return route.fulfill({ status: 202, json: envelope({
        command_id: "11111111-1111-4111-8111-111111111111", action: "sync-now",
        state: "queued", requested_at: now, expires_at: "2026-07-12T06:30:00Z",
      }) });
    }
    if (url.pathname.endsWith("11111111-1111-4111-8111-111111111111") && request.method() === "DELETE") {
      received.push({ headers: request.headers(), body: null });
      return route.fulfill({ json: envelope({
        command_id: "11111111-1111-4111-8111-111111111111", action: "sync-now",
        state: "cancelled", requested_at: now, expires_at: "2026-07-12T06:30:00Z",
      }) });
    }
    return route.fulfill({ status: 404, json: { error: { code: "fixture_missing" } } });
  });
}

test.beforeAll(async () => {
  await mkdir(".wrangler/screenshots", { recursive: true });
});

test("renders bounded operations and confirms a fixed command", async ({ page }, testInfo) => {
  const received = [];
  await useOperationsFixture(page, received);
  await page.goto("/ops");

  await expect(page.locator("#overview-title")).toHaveText("대기 중");
  await expect(page.locator("#active-title")).toContainText("예약 실행 · 성공");
  await expect(page.locator("#boards-body")).toContainText("aa_19");
  await expect(page.locator("#release-current")).toContainText("aaaaaaaaaaaa");
  await expect(page.locator("#warning-line")).toBeHidden();
  await expect(page.locator("#command-result")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.wrangler/screenshots/${testInfo.project.name}-ops.png` });

  await page.locator('[data-action="sync-now"]').click();
  await expect(page.locator("#command-dialog")).toBeVisible();
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#command-result")).toContainText("지금 동기화 · 대기");
  await page.getByRole("button", { name: "대기 명령 취소" }).click();
  await expect(page.locator("#command-result")).toContainText("지금 동기화 · 취소됨");
  expect(received).toHaveLength(2);
  expect(received[0].headers["x-redstm-command"]).toBe("1");
  expect(received[0].headers["idempotency-key"]).toMatch(/^web-[0-9a-f-]{36}$/);
  expect(received[0].body).toEqual({ action: "sync-now", args: {} });
  expect(received[1].headers["idempotency-key"]).toMatch(/^cancel-[0-9a-f-]{36}$/);
});
