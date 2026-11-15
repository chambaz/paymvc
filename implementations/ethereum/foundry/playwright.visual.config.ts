import { defineConfig, devices } from "@playwright/test";

// Run only inside the Playwright Docker image (npm run test:visual), so every machine renders the same pixels.
export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" },
  },
  use: {
    baseURL: "http://127.0.0.1:5199",
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
    command: "npx vite --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199/reference.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
