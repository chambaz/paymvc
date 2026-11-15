import { defineConfig } from "@playwright/test";
import { network, networkId } from "./scripts/network";

// LOCAL=1 uses the running `npm run local` frontend and Anvil. Otherwise this config serves
// the production build for the selected public network.
const local = process.env.LOCAL === "1";
const port = Number(process.env.LIVE_PORT ?? (local ? 5173 : network.port));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("LIVE_PORT must be a valid TCP port.");

export default defineConfig({
  testDir: "tests/live",
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 90000 },
  use: {
    baseURL: `http://127.0.0.1:${port}/${local ? "" : `?network=${networkId}`}`,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: local
    ? undefined
    : {
        command: `npm run preview -- --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: false,
        timeout: 180000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      },
});
