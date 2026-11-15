import { spawnSync } from "node:child_process";
import { networkId } from "./network";

// Playwright does not accept --network, so pass the selected network on as PAYMVC_NETWORK.
const args = process.argv
  .slice(2)
  .filter(
    (arg, index, all) =>
      !arg.startsWith("--network") && all[index - 1] !== "--network",
  );
const run = spawnSync(
  "playwright",
  ["test", "--config", "playwright.live.config.ts", ...args],
  { stdio: "inherit", env: { ...process.env, PAYMVC_NETWORK: networkId } },
);
process.exit(run.status ?? 1);
