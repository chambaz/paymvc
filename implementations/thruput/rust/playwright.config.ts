import { defineConfig } from "@playwright/test";

// The default suite starts `npm run local`: a fresh local node, deployment,
// and frontend. LIVE=1 runs against the public Futurenet deployment.
const live = process.env.LIVE === "1";
const url = live ? "http://127.0.0.1:5189" : "http://127.0.0.1:5190";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 45_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: url,
    locale: "en-US",
    timezoneId: "UTC",
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    trace: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: live ? "npm run dev" : "npm run local",
    url,
    reuseExistingServer: false,
    timeout: 600_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
