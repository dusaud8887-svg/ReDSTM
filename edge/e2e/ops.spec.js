import { mkdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const nextAutomatic = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const inventoryStarted = new Date(Date.now() - 60 * 60_000).toISOString();

function envelope(data) {
  return { api_version: 1, request_id: crypto.randomUUID(), server_time: now, data };
}

async function useOperationsFixture(page, received, fixture = {}) {
  await page.route("**/api/v1/ops/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (fixture.failures?.includes(url.pathname)) {
      return route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable" } } });
    }
    if (url.pathname === "/api/v1/ops/overview") {
      return route.fulfill({ json: envelope(fixture.overview || {
        runner: { state: "idle", heartbeat_at: now, next_scheduled_at: nextAutomatic, disk_free_bytes: 80 * 2 ** 30 },
        schedule_enabled: true,
        schedule_paused: false,
        active_run: null,
        latest_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now, changed_posts: 2, failed_posts: 0, boards_ok: 46, boards_failed: 0 },
        latest_automatic_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now, changed_posts: 2, failed_posts: 0, boards_ok: 46, boards_failed: 0 },
        recent_issue: null,
        archive_snapshot: {
          recorded_at: now,
          counters: {
            outline_only: 1831, frontier_pending: 12, frontier_running: 0, frontier_retry: 3,
            frontier_dead: 1, inventory_total_boards: 46, inventory_completed_boards: 44,
            inventory_in_progress_boards: 2,
          },
        },
        active_commands: 0,
      }) });
    }
    if (url.pathname === "/api/v1/ops/runs") {
      return route.fulfill({ json: envelope(fixture.runs || { items: [{
        run_id: "scheduled-fixture", kind: "scheduled", source: "systemd", state: "succeeded",
        started_at: now, changed_posts: 2, failed_posts: 0, boards_ok: 46, boards_failed: 0,
      }], next_cursor: null }) });
    }
    if (url.pathname === "/api/v1/ops/boards") {
      return route.fulfill({ json: envelope(fixture.boards || { items: [
        {
          board_id: "aa_19", last_outcome: "succeeded", last_scanned_at: now,
          board_name: "AA 장편", group_name: "aa", discovered: 2, changed: 1,
          pending: 0, running: 0, retry: 0, done: 120, dead: 0,
          inventory_next_page: 37, last_inventory_at: null, inventory_pass_started_at: now,
        },
        {
          board_id: "healthy_1", last_outcome: "succeeded", last_scanned_at: now,
          board_name: "정상 게시판", group_name: "archive", discovered: 0, changed: 0,
          pending: 0, running: 0, retry: 0, done: 20, dead: 0,
          inventory_next_page: 1, last_inventory_at: now, inventory_pass_started_at: inventoryStarted,
        },
      ], next_cursor: null }) });
    }
    if (url.pathname === "/api/v1/ops/releases") {
      return route.fulfill({ json: envelope(fixture.releases || {
        current: { release_id: "a".repeat(64), activated_at: now, counts: {
          post_count: 282239, unavailable_post_count: 1831,
          comment_count: 3707484, unavailable_comment_count: 22222,
          board_count: 46, collection_count: 1200,
        } },
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

  await expect(page.locator("#overview-title")).toHaveText("자동 수집 켜짐");
  await expect(page.locator("#automation-mode")).toHaveText("켜짐");
  await expect(page.locator("#last-automatic")).toContainText("성공");
  await expect(page.locator("#active-title")).toContainText("예약 실행 · 성공");
  await expect(page.locator("#boards-list")).toContainText("AA 장편");
  await expect(page.locator("#boards-list")).toContainText("36쪽까지 확인");
  await expect(page.locator(".healthy-boards > summary")).toHaveText("정상 게시판 1개");
  await expect(page.getByText("healthy_1")).toBeHidden();
  await expect(page.locator("#reader-posts")).toHaveText("282,239");
  await expect(page.locator("#outline-only")).toHaveText("1,831");
  await expect(page.locator("#collected-comments")).toHaveText("3,729,706");
  await expect(page.locator("#inventory-progress")).toHaveText("진행 중 · 44/46");
  await expect(page.locator("#issue-metrics")).toBeHidden();
  await expect(page.locator("#release-current")).toBeHidden();
  await expect(page.locator("#warning-line")).toBeHidden();
  await expect(page.locator("#command-result")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: `.wrangler/screenshots/${testInfo.project.name}-ops.png`,
    fullPage: true,
  });

  await page.locator(".release-evidence > summary").click();
  await expect(page.locator("#release-current")).toContainText("aaaaaaaaaaaa");
  await expect(page.locator("#release-counts")).toContainText("Reader 글 댓글");
  await page.locator(".healthy-boards > summary").click();
  await expect(page.getByText("healthy_1")).toBeVisible();

  await page.locator('[data-action="sync-now"]').click();
  await expect(page.getByRole("dialog", { name: "증분 수집 지금 실행" })).toBeVisible();
  await page.locator("#dialog-confirm").click();
  await expect(page.locator("#command-result")).toContainText("증분 수집 지금 실행 · 대기");
  await page.getByRole("button", { name: "대기 명령 취소" }).click();
  await expect(page.locator("#command-result")).toContainText("증분 수집 지금 실행 · 취소됨");
  expect(received).toHaveLength(2);
  expect(received[0].headers["x-redstm-command"]).toBe("1");
  expect(received[0].headers["idempotency-key"]).toMatch(/^web-[0-9a-f-]{36}$/);
  expect(received[0].body).toEqual({ action: "sync-now", args: {} });
  expect(received[1].headers["idempotency-key"]).toMatch(/^cancel-[0-9a-f-]{36}$/);
});

test("keeps stale runner, empty telemetry, and readable release distinct", async ({ page }) => {
  const stale = new Date(Date.now() - 24 * 60_000).toISOString();
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: stale, active_step: "idle", next_scheduled_at: now, disk_free_bytes: 80 * 2 ** 30 },
      schedule_enabled: true,
      active_run: null,
      latest_run: null,
      recent_issue: null,
      archive_snapshot: null,
      active_commands: 0,
    },
    runs: { items: [], next_cursor: null },
    boards: { items: [], next_cursor: null },
  });
  await page.goto("/ops");

  await expect(page.locator("#overview-title")).toHaveText("수집기 응답 없음");
  await expect(page.locator("#active-step-label")).toHaveText("마지막 보고 작업");
  await expect(page.locator("#reader-state")).toHaveText("Reader 사용 가능");
  await expect(page.locator("#active-title")).toHaveText("아직 보고된 실행 없음");
  await expect(page.locator("#latest-changed")).toHaveText("—");
  await expect(page.locator("#boards-list")).toContainText("운영 기록이 아직 보고되지 않았습니다");
  await expect(page.locator("[data-action]:disabled")).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("shows a connected runner with a disabled schedule as automation off", async ({ page }) => {
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: now, next_scheduled_at: null },
      schedule_enabled: false,
      schedule_paused: false,
      active_run: null,
      latest_run: null,
      recent_issue: null,
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator("#overview-title")).toHaveText("자동 수집 꺼짐");
  await expect(page.locator("#overview-reason")).toContainText("redstm-schedule.timer");
  await expect(page.locator("#next-schedule")).toHaveText("예약 없음");
  await expect(page.locator('[data-action="resume-schedule"] span')).toHaveText("일시정지 해제");
  await expect(page.locator('[data-action="sync-now"]')).toBeEnabled();
  await expect(page.locator('[data-action="pause-after-current"]')).toBeDisabled();
});

test("keeps automation state separate from the recent failure", async ({ page }) => {
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: now, next_scheduled_at: nextAutomatic },
      schedule_enabled: true,
      active_run: null,
      latest_run: { kind: "scheduled", source: "systemd", state: "partial", started_at: now, finished_at: now },
      latest_automatic_run: { kind: "scheduled", source: "systemd", state: "partial", started_at: now, finished_at: now },
      recent_issue: { kind: "scheduled", source: "systemd", state: "partial", started_at: now, finished_at: now, safe_summary_code: "parse_drift", failed_posts: 2, boards_failed: 1 },
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator("#overview-title")).toHaveText("자동 수집 켜짐");
  await expect(page.locator("#issue-title")).toContainText("원본 구조 변경");
  await expect(page.locator("#issue-metrics")).toBeVisible();
  await expect(page.locator("#issue-posts")).toHaveText("2");
});

test("shows when a recent issue was recovered", async ({ page }) => {
  const failedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: now, next_scheduled_at: nextAutomatic },
      schedule_enabled: true,
      active_run: null,
      latest_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now },
      latest_automatic_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now },
      recent_issue: {
        kind: "scheduled", state: "failed", started_at: failedAt, finished_at: failedAt,
        safe_summary_code: "site_unreachable", failed_posts: 3, boards_failed: 1,
        recovered: true, recovered_at: now,
      },
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator("#issue-title")).toContainText("정상화됨 · 원본 연결 실패");
  await expect(page.locator("#issue-reason")).toContainText("이후 자동 실행이 성공했습니다");
});

test("does not surface issues older than seven days", async ({ page }) => {
  const oldIssue = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: now, next_scheduled_at: nextAutomatic },
      schedule_enabled: true,
      active_run: null,
      latest_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now },
      latest_automatic_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: now, finished_at: now },
      recent_issue: {
        kind: "scheduled", state: "failed", started_at: oldIssue, finished_at: oldIssue,
        safe_summary_code: "site_unreachable", failed_posts: 3, boards_failed: 1,
      },
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator("#issue-title")).toHaveText("최근 7일 실패 없음");
  await expect(page.locator("#issue-metrics")).toBeHidden();
});

test("warns when the automatic schedule is overdue", async ({ page }) => {
  const oldAutomatic = new Date(Date.now() - 8 * 60 * 60_000).toISOString();
  const pastNext = new Date(Date.now() - 25 * 60_000).toISOString();
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "idle", heartbeat_at: now, next_scheduled_at: pastNext },
      schedule_enabled: true,
      active_run: null,
      latest_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: oldAutomatic, finished_at: oldAutomatic },
      latest_automatic_run: { kind: "scheduled", source: "systemd", state: "succeeded", started_at: oldAutomatic, finished_at: oldAutomatic },
      recent_issue: null,
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator("#overview-title")).toHaveText("자동 수집 지연");
  await expect(page.locator("#automation-mode")).toHaveText("켜짐 · 지연");
  await expect(page.locator("#next-schedule")).toContainText("지연");
  await expect(page.locator("#warning-line")).toBeVisible();
});

test("names the sections affected by a partial refresh failure", async ({ page }) => {
  await useOperationsFixture(page, [], { failures: ["/api/v1/ops/boards"] });
  await page.goto("/ops");

  await expect(page.locator("#error-banner")).toContainText("영향: 게시판별 진척");
  await expect(page.locator("#updated-at")).toContainText("일부 갱신 실패");
  await expect(page.locator("#reader-posts")).toHaveText("282,239");
});

test("only enables pause while the runner is working", async ({ page }) => {
  await useOperationsFixture(page, [], {
    overview: {
      runner: { state: "running", heartbeat_at: now, active_step: "crawling" },
      schedule_enabled: false,
      active_run: { kind: "manual-sync", source: "command", state: "running", started_at: now },
      latest_run: null,
      recent_issue: null,
      archive_snapshot: null,
      active_commands: 0,
    },
  });
  await page.goto("/ops");

  await expect(page.locator('[data-action="pause-after-current"]')).toBeEnabled();
  await expect(page.locator('[data-action]:not([data-action="pause-after-current"]):disabled')).toHaveCount(4);
  await expect(page.locator("#latest-changed")).toHaveText("—");
  await expect(page.locator("#active-reason")).toContainText("수치는 종료 후 집계");
});
