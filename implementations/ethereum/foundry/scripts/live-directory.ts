import { join } from "node:path";
import { privateDirectory } from "./network";

// A named run creates separate disposable wallets without deleting earlier evidence.
export function liveDirectoryFor(directory: string, run?: string) {
  if (run && !/^[a-zA-Z0-9_-]+$/.test(run))
    throw new Error(
      "LIVE_RUN must contain only letters, numbers, underscores, or hyphens.",
    );
  return join(directory, ...(run ? [`live-${run}`] : []));
}
export const liveDirectory = liveDirectoryFor(
  privateDirectory,
  process.env.LIVE_RUN,
);
