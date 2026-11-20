import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: "http://127.0.0.1:5176",
    trace: "off",
    screenshot: "off",
    video: "off",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npm run local",
    url: "http://127.0.0.1:5176",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
