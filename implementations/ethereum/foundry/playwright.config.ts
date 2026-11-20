import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: "http://127.0.0.1:5174",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "npm run local",
    url: "http://127.0.0.1:5174",
    env: { PAYMVC_DEV_PORT: "5174" },
    reuseExistingServer: false,
    timeout: 600_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
