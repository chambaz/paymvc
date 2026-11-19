import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/networks",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 30000 },
  retries: 0,
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: "http://127.0.0.1:5191",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run preview -- --port 5191 --strictPort",
    url: "http://127.0.0.1:5191",
    reuseExistingServer: false,
    timeout: 180000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
