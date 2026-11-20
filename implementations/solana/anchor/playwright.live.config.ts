import { defineConfig } from "@playwright/test";
import { local } from "./scripts/live-network";

// Live runs sign with real keys. Traces, screenshots, and videos stay off.
export default defineConfig({
  testDir: "tests/live",
  workers: 1,
  retries: 0,
  timeout: 1_200_000,
  expect: { timeout: 120_000 },
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: local ? "http://127.0.0.1:5176" : "http://127.0.0.1:5175",
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
  // Local mode reuses a running `npm run local`. Devnet always serves this checkout.
  webServer: local
    ? {
        command: "npm run local",
        url: "http://127.0.0.1:5176",
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:5175",
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
