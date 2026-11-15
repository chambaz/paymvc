import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { Account } from "@aptos-labs/ts-sdk";
import { server } from "../src/chain/config";

mkdirSync(".local", { recursive: true, mode: 0o700 });
const log = openSync(".local/validator.log", "w", 0o600);
writeFileSync(
  ".local/node-override.yaml",
  "api:\n  address: 127.0.0.1:8180\n",
  { mode: 0o600 },
);
const node = spawn(
  "aptos",
  [
    "node",
    "run-localnet",
    "--test-dir",
    ".local/node",
    "--force-restart",
    "--assume-yes",
    "--no-txn-stream",
    "--bind-to",
    "127.0.0.1",
    "--test-config-override",
    ".local/node-override.yaml",
    "--faucet-port",
    "8181",
    "--ready-server-listen-port",
    "8170",
  ],
  {
    stdio: ["ignore", log, log],
    detached: true,
    env: {
      ...process.env,
      // Host disk metrics can block startup on an unavailable FUSE mount.
      APTOS_DISABLE_PROMETHEUS_NODE_METRICS: "true",
      APTOS_DISABLE_TELEMETRY: "true",
    },
  },
);
let frontend: ChildProcess | undefined;
let deploy: ChildProcess | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  for (const child of [frontend, deploy, node]) {
    if (!child?.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (stopping) process.exit(0);
    if (node.exitCode !== null)
      throw new Error("Local Aptos node exited. Check .local/validator.log.");
    try {
      const response = await fetch("http://127.0.0.1:8170/", {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* The launcher waits for local services only. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Local Aptos services did not become ready.");
  const key = Account.generate({ legacy: true });
  const address = key.accountAddress.toStringLong();
  writeFileSync(
    ".local/local-deployer.json",
    JSON.stringify({
      network: "localnet",
      address,
      privateKey: key.privateKey.toString(),
    }),
    { mode: 0o600 },
  );
  const response = await fetch(
    `http://127.0.0.1:8181/mint?address=${address}&amount=1000000000`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Local faucet funding failed.");
  const client = server({
    network: "localnet",
    rpcUrl: "http://127.0.0.1:8180/v1",
  });
  for (const hash of (await response.json()) as string[])
    await client.waitForTransaction({ transactionHash: hash });
  await new Promise<void>((resolve, reject) => {
    deploy = spawn("npm", ["run", "deploy"], {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, LOCAL: "1" },
    });
    deploy.on("error", reject);
    deploy.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Local deployment failed.")),
    );
  });
  frontend = spawn("npm", ["run", "dev", "--", "--port", "5186"], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, VITE_DEPLOYMENT_URL: "/local.json" },
  });
  frontend.on("exit", stop);
} catch (error) {
  stop();
  throw error;
}
