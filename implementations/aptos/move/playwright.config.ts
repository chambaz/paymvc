import { defineConfig, devices } from "@playwright/test";
const live = process.env.LIVE === "1";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180000,
  expect: { timeout: 30000 },
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: live ? "http://127.0.0.1:5185" : "http://127.0.0.1:5186",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    command: live ? "npm run dev" : "npm run local",
    url: live ? "http://127.0.0.1:5185" : "http://127.0.0.1:5186",
    reuseExistingServer: live,
    timeout: 180000,
  },
});
