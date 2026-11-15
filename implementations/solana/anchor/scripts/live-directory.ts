import { join } from "node:path";

// A named run creates new disposable wallets and keeps the sessions of earlier runs.
const run = process.env.LIVE_RUN;
if (run && !/^[a-zA-Z0-9_-]+$/.test(run))
  throw new Error(
    "LIVE_RUN must contain only letters, numbers, underscores, or hyphens.",
  );
export const liveDirectory = run ? join(".local", `live-${run}`) : ".local";
/** Per-viewport results of `npm run test:live:browser`, collected into evidence. */
export const browserResults = join(liveDirectory, "browser-results");
