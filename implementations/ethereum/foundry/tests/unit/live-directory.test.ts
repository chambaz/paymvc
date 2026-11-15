import { expect, it } from "vitest";
import { resolve } from "node:path";
import { networkPaths } from "../../scripts/network";
import { liveDirectoryFor } from "../../scripts/live-directory";

it("preserves Ethereum's existing private paths", () => {
  const paths = networkPaths("ethereum");
  expect(liveDirectoryFor(paths.privateDirectory, "release-1")).toBe(
    resolve(".local/live-release-1"),
  );
  expect(paths.deploymentPath).toBe(resolve("deployments/sepolia.json"));
});

it("keeps each network's private journals and deployments separate", () => {
  const directories = ["ethereum", "base", "monad", "robinhood"].map(
    (id) => networkPaths(id).privateDirectory,
  );
  expect(new Set(directories).size).toBe(4);
  const paths = networkPaths("robinhood");
  expect(liveDirectoryFor(paths.privateDirectory, "release-1")).toBe(
    resolve(".local/robinhood/live-release-1"),
  );
  expect(paths.deploymentPath).toBe(
    resolve("deployments/robinhood-testnet.json"),
  );
});

it("rejects names that could escape private network directories", () => {
  expect(() =>
    liveDirectoryFor(
      networkPaths("base").privateDirectory,
      "../../another-session",
    ),
  ).toThrow("LIVE_RUN must contain");
  expect(() => networkPaths("../base")).toThrow("Unsupported test network");
});
