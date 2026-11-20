import { defineConfig, devices } from "@playwright/test";
// LIVE=1 uses Testnet; add LOCAL=1 to run the live command on the local network.
const testnet = process.env.LIVE === "1" && process.env.LOCAL !== "1";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: process.env.LIVE === "1" ? 900_000 : 180_000,
  expect: { timeout: process.env.LIVE === "1" ? 180_000 : 90_000 },
  use: {
    // Dialogs open without animation, so that axe checks the final colors.
    reducedMotion: "reduce",
    baseURL: "http://127.0.0.1:5182",
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5182",
    url: "http://127.0.0.1:5182",
    reuseExistingServer: false,
    env: {
      VITE_DEPLOYMENT_URL: testnet ? "/deployment.json" : "/local.json",
    },
  },
});
