import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { browserResults } from "./live-directory";
import { liveDeployment } from "./live-network";
import { writeEvidence, type Run } from "./evidence";

// Run the canonical scenario in each viewport, then record every result.
rmSync(browserResults, { recursive: true, force: true });
mkdirSync(browserResults, { recursive: true, mode: 0o700 });
const { status } = spawnSync(
  "npx",
  ["playwright", "test", "--config", "playwright.live.config.ts"],
  { stdio: "inherit" },
);
const runs: Run[] = ["desktop", "mobile"]
  .map((viewport) => `${browserResults}/${viewport}.json`)
  .filter(existsSync)
  .map((path) => JSON.parse(readFileSync(path, "utf8")));
if (runs.length) await writeEvidence(liveDeployment(), { browser: runs });
if (status !== 0 || runs.length !== 2 || runs.some((run) => run.failure))
  throw new Error("The live browser scenario failed.");
console.log("Live browser scenario passed in both viewports.");
