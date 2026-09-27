import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.REDSTM_E2E_PORT || 8791);
if (!Number.isInteger(e2ePort) || e2ePort < 1024 || e2ePort > 65535) throw new Error("Invalid E2E port");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  webServer: {
    command: `npx wrangler dev --local --port ${e2ePort} --var TEAM_DOMAIN: --var POLICY_AUD: --var VIEWER_USERNAME:reader --var VIEWER_PASSWORD:test-secret`,
    url: `http://127.0.0.1:${e2ePort}/health`,
    reuseExistingServer: true,
  },
  use: {
    baseURL: process.env.REDSTM_E2E_URL || `http://127.0.0.1:${e2ePort}`,
    httpCredentials: {
      username: process.env.REDSTM_E2E_USERNAME || "reader",
      password: process.env.REDSTM_E2E_PASSWORD || "test-secret",
    },
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "medium", use: { viewport: { width: 768, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, channel: "chrome" } },
    { name: "compact", use: { viewport: { width: 320, height: 800 } } },
  ],
});
