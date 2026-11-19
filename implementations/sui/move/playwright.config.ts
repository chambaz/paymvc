import { defineConfig, devices } from "@playwright/test";
const live = process.env.LIVE === "1";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: live ? "http://127.0.0.1:5183" : "http://127.0.0.1:5184",
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
    command: live ? "npm run dev" : "npm run local",
    url: live ? "http://127.0.0.1:5183" : "http://127.0.0.1:5184",
    reuseExistingServer: live,
    timeout: 180_000,
  },
});
