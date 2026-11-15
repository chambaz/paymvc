/**
 * Start a local Thruput node, deploy both contracts to it, and serve the app
 * with the local deployment record.
 *
 *   npm run local
 *
 * The node is ephemeral and gets a new random network hash on each start, so
 * browser sessions and test state from an earlier chain never match it. The
 * node funds the private local deployer key at genesis. This launcher is not
 * part of the production bundle.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { toBase58 } from "@thruputchain/client";
import { cliConfig, ensureKey } from "./cli";

/** Native tokens for the deployer: both deployments and the browser-test users. */
const DEPLOYER_TOKENS = "1000";
const { env, keyName } = cliConfig("local");
const port = process.env.PAYMVC_DEV_PORT ?? "5190";

const children: ChildProcess[] = [];
/** Each child leads its own process group, so stopping it also stops its workers. */
function start(command: string, args: string[], options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
  children.push(child);
  return child;
}
function stop() {
  for (const child of children)
    if (child.pid && child.exitCode === null && child.signalCode === null)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function runStep(command: string, args: string[], failure: string) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, PAYMVC_DEV_PORT: port },
  });
  if (result.status !== 0) throw new Error(failure);
}

try {
  runStep("npm", ["run", "contracts:build"], "Contract build failed.");
  ensureKey(keyName, env);

  const node = start(
    "thruput",
    [
      "node",
      "--key",
      keyName,
      "--initial-account-tokens",
      DEPLOYER_TOKENS,
      "--init-network-hash",
      toBase58(crypto.getRandomValues(new Uint8Array(32))),
      // Produce blocks on a timer, as a hosted network does. The default
      // instant driver makes a block only after a transaction, so a read
      // at a confirmed receipt's height can wait for the next transaction.
      "--block-driver",
      "interval",
      "--block-interval-ms",
      "250",
      "--json",
      "--non-interactive",
    ],
    { env, stdio: ["ignore", "pipe", "inherit"] },
  );
  // `thruput node --json` prints one readiness result on stdout.
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: node.stdout! });
    node.on("error", reject);
    node.on("exit", () =>
      reject(new Error("The local Thruput node stopped before it was ready.")),
    );
    lines.on("line", (line) => {
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        return;
      }
      if (result.ok) {
        console.log("Local node:", result.data.rpcUrl);
        resolve();
      } else reject(new Error(`thruput node failed: ${line}`));
    });
  });
  node.on("exit", stop);

  runStep(
    process.execPath,
    ["--import", "tsx", "scripts/deploy.ts", "--local"],
    "Local deployment failed.",
  );

  const frontend = start("npm", ["run", "dev"], {
    env: {
      ...process.env,
      PAYMVC_DEV_PORT: port,
      VITE_DEPLOYMENT_URL: "/local.json",
    },
  });
  frontend.on("exit", stop);
} catch (error) {
  stop();
  throw error;
}
