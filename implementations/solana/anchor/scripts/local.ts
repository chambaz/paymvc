import { spawn, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRpc } from "../src/chain/config";
import { PAYMVC_PROGRAM_ADDRESS } from "../src/chain/generated";

await mkdir(".local", { recursive: true, mode: 0o700 });
await mkdir("public", { recursive: true });
if (!existsSync(".local/deployer.json"))
  execFileSync(
    "solana-keygen",
    [
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      ".local/deployer.json",
    ],
    { stdio: "inherit" },
  );
const validator = spawn(
  "solana-test-validator",
  [
    "--reset",
    "--ledger",
    ".local/validator",
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    "8899",
    "--faucet-port",
    "9900",
    "--gossip-port",
    "10000",
    "--dynamic-port-range",
    "10000-10050",
    // Loader v3 with no upgrade authority, like the finalized devnet program.
    "--upgradeable-program",
    PAYMVC_PROGRAM_ADDRESS,
    "target/deploy/paymvc.so",
    "none",
    "--quiet",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
let vite: ReturnType<typeof spawn> | undefined;
const stop = () => {
  vite?.kill("SIGTERM");
  validator.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
validator.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
try {
  const rpc = createRpc("http://127.0.0.1:8899");
  let healthy = false;
  for (let i = 0; i < 120; i++) {
    if (validator.exitCode !== null)
      throw new Error("Local validator exited before startup.");
    try {
      await rpc.getHealth().send();
      healthy = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!healthy) throw new Error("Local validator did not start.");
  execFileSync(
    "solana",
    [
      "airdrop",
      "10",
      "--url",
      "http://127.0.0.1:8899",
      "--keypair",
      ".local/deployer.json",
    ],
    { stdio: "inherit" },
  );
  execFileSync("npx", ["tsx", "scripts/initialize.ts", "--local"], {
    stdio: "inherit",
  });
  vite = spawn(
    "npx",
    ["vite", "--host", "127.0.0.1", "--port", process.env.PORT ?? "5176"],
    {
      stdio: "inherit",
      env: { ...process.env, VITE_DEPLOYMENT_URL: "/local.json" },
    },
  );
  await new Promise<void>((resolve) => vite!.once("exit", () => resolve()));
} finally {
  stop();
}
