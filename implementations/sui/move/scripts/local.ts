import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  openSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { server } from "../src/chain/config";

mkdirSync(".local", { recursive: true, mode: 0o700 });
const log = openSync(".local/validator.log", "w", 0o600);
const node = spawn(
  "sui",
  [
    "start",
    "--force-regenesis",
    "--with-faucet=127.0.0.1:9123",
    "--epoch-duration-ms",
    "600000",
    "--committee-size",
    "1",
  ],
  { stdio: ["ignore", log, log] },
);
let frontend: ChildProcess | undefined;
let deploy: ChildProcess | undefined;
function stop() {
  frontend?.kill("SIGTERM");
  deploy?.kill("SIGTERM");
  node.kill("SIGTERM");
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const client = server({ network: "localnet", rpcUrl: "http://127.0.0.1:9000" });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (node.exitCode !== null)
      throw new Error("Local Sui node exited. Check .local/validator.log.");
    try {
      await client.getChainIdentifier();
      const faucet = await fetch("http://127.0.0.1:9123/", {
        signal: AbortSignal.timeout(2000),
      });
      await faucet.body?.cancel();
      if (!faucet.ok) throw new Error("Local faucet is not ready.");
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!ready) throw new Error("Local Sui node did not become ready.");
  const path = ".local/local-deployer.json";
  if (!existsSync(path)) {
    const key = Ed25519Keypair.generate();
    writeFileSync(
      path,
      JSON.stringify({
        network: "localnet",
        address: key.toSuiAddress(),
        privateKey: key.getSecretKey(),
      }),
      { mode: 0o600, flag: "wx" },
    );
  }
  const { address } = JSON.parse(readFileSync(path, "utf8"));
  await requestSuiFromFaucetV2({
    host: "http://127.0.0.1:9123",
    recipient: address,
  });
  await new Promise<void>((resolve, reject) => {
    deploy = spawn("npm", ["run", "deploy"], {
      stdio: "inherit",
      env: { ...process.env, LOCAL: "1" },
    });
    deploy.on("error", reject);
    deploy.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Local deployment failed.")),
    );
  });
  frontend = spawn(
    "npm",
    ["run", "dev", "--", "--port", process.env.PORT ?? "5184"],
    {
      stdio: "inherit",
      env: { ...process.env, VITE_DEPLOYMENT_URL: "/local.json" },
    },
  );
  frontend.on("exit", () => node.kill("SIGTERM"));
} catch (error) {
  stop();
  throw error;
}
