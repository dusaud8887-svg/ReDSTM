import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  webServer: {
    command: "npx wrangler dev --local --port 8791 --var VIEWER_USERNAME:reader --var VIEWER_PASSWORD:test-secret",
    url: "http://127.0.0.1:8791/health",
    reuseExistingServer: true,
  },
  use: {
    baseURL: process.env.REDSTM_E2E_URL || "http://127.0.0.1:8791",
    httpCredentials: {
      username: process.env.REDSTM_E2E_USERNAME || "reader",
      password: process.env.REDSTM_E2E_PASSWORD || "test-secret",
    },
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" } },
  ],
});
