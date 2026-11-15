import { resolve } from "node:path";
import { defaultNetwork, networkName, networkNamed } from "../src/networks";

export function selectedNetwork(
  args = process.argv.slice(2),
  env = process.env.PAYMVC_NETWORK,
) {
  const flags = args.filter(
    (arg) => arg === "--network" || arg.startsWith("--network="),
  );
  if (flags.length > 1) throw new Error("Select one network.");
  const flag = flags[0];
  const value =
    flag === "--network"
      ? args[args.indexOf(flag) + 1]
      : flag?.slice("--network=".length);
  if (flag && (!value || value.startsWith("--")))
    throw new Error("--network requires a network name.");
  return networkName(value ?? env ?? defaultNetwork);
}

export const networkId = selectedNetwork();
export const network = networkNamed(networkId);
export function networkPaths(name: string) {
  const id = networkName(name);
  return {
    deploymentPath: resolve("deployments", networkNamed(id).deployment),
    // Keep Ethereum's existing paths; imported journals have a network directory.
    privateDirectory: resolve(".local", ...(id === "ethereum" ? [] : [id])),
  };
}
export const { deploymentPath, privateDirectory } = networkPaths(networkId);
