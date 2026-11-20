// Deploys PayMVC with the Stellar CLI, then verifies it and writes the public record.
//
//   stellar contract upload --wasm demo_credits.wasm   (credits code)
//   stellar contract upload --wasm paymvc.wasm         (app code)
//   stellar contract deploy --wasm-hash <app> --salt <salt> -- --token_wasm <credits>
//
// The app constructor deploys the credits contract with the app as its only minter.
// Re-running is safe: an upload of existing code is a no-op, and the salt fixes the
// contract ID, so a confirmed deployment is found instead of deployed twice.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Contract, Networks } from "@stellar/stellar-sdk";
import { parseDeployment, server, type Deployment } from "../src/chain/config";
import { verifyDeployment } from "../src/chain/payments";
import { readApp } from "../src/chain/payments";

const local = process.env.LOCAL === "1";
// RPC_URL selects the endpoint this script uses. It can hold a provider key, so the
// public record always gets the network's public URL.
const publicRpcUrl = local
  ? "http://127.0.0.1:8000/rpc"
  : "https://soroban-testnet.stellar.org";
const c: Deployment = {
  network: local ? "localnet" : "testnet",
  passphrase: local ? Networks.STANDALONE : Networks.TESTNET,
  rpcUrl: process.env.RPC_URL ?? publicRpcUrl,
  horizonUrl: local
    ? "http://127.0.0.1:8000"
    : "https://horizon-testnet.stellar.org",
  faucetUrl: local
    ? "http://127.0.0.1:8000/friendbot"
    : "https://friendbot.stellar.org",
  contract: "",
  token: "",
  codeHash: "",
  tokenHash: "",
};
// Private CLI configuration: the deployer key and the deployment salts.
const directory = `.local/cli-${c.network}`;
await mkdir(directory, { recursive: true, mode: 0o700 });

const stellar = (...args: string[]) =>
  execFileSync("stellar", ["--config-dir", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const network = ["--rpc-url", c.rpcUrl, "--network-passphrase", c.passphrase];
const source = ["--source-account", "deployer", ...network];

if ((await server(c).getNetwork()).passphrase !== c.passphrase)
  throw new Error("Wrong deployment network.");

// 1. The deployer account. Friendbot funds it on test networks.
if (!existsSync(`${directory}/identity/deployer.toml`))
  stellar("keys", "generate", "deployer");
const deployer = stellar("keys", "address", "deployer");
console.log(`Deployer: ${deployer}`);
const required = 100n * 10_000_000n; // 100 XLM covers both uploads and the deploy.
const balance = async () => {
  const response = await fetch(`${c.horizonUrl}/accounts/${deployer}`);
  if (response.status === 404) return 0n;
  if (!response.ok) throw new Error("Cannot check the deployer balance.");
  const account = (await response.json()) as {
    balances: { asset_type: string; balance: string }[];
  };
  const xlm = account.balances.find((b) => b.asset_type === "native")!;
  return BigInt(xlm.balance.replace(".", ""));
};
if ((await balance()) < required) {
  try {
    stellar("keys", "fund", "deployer", ...network);
  } catch {
    throw new Error(
      `Fund ${deployer} with at least 100 XLM through ${c.faucetUrl}, then retry.`,
    );
  }
  if ((await balance()) < required)
    throw new Error(`Fund ${deployer} with at least 100 XLM, then retry.`);
}

// 2. Upload both contracts' code. Each upload returns the code hash.
const upload = async (path: string) => {
  const expected = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const hash = stellar(
    "contract",
    "upload",
    "--wasm",
    path,
    "--optimize=false",
    ...source,
  );
  if (hash !== expected) throw new Error(`Uploaded code hash differs: ${path}`);
  return hash;
};
c.tokenHash = await upload("target/wasm32v1-none/release/demo_credits.wasm");
c.codeHash = await upload("target/wasm32v1-none/release/paymvc.wasm");

// 3. Deploy the app. One salt per code version; delete its file for a fresh deployment.
const saltPath = `${directory}/${c.codeHash}-${c.tokenHash}.salt`;
const salt = await readFile(saltPath, "utf8").catch(async () => {
  const value = randomBytes(32).toString("hex");
  await writeFile(saltPath, value, { mode: 0o600 });
  return value;
});
c.contract = stellar("contract", "id", "wasm", "--salt", salt, ...source);
const existing = await server(c).getLedgerEntries(
  new Contract(c.contract).getFootprint(),
);
if (!existing.entries.length) {
  const deployed = stellar(
    "contract",
    "deploy",
    "--wasm-hash",
    c.codeHash,
    "--salt",
    salt,
    ...source,
    "--",
    "--token_wasm",
    c.tokenHash,
  );
  if (deployed !== c.contract)
    throw new Error(`Unexpected contract ID: ${deployed}`);
}

// 4. Verify network, code hashes, token address, and zero decimals, then publish.
c.token = await readApp<string>(c, deployer, "token");
await verifyDeployment(c);
const output = local ? "public/local.json" : "public/deployment.json";
await writeFile(
  output,
  JSON.stringify(parseDeployment({ ...c, rpcUrl: publicRpcUrl }), null, 2) +
    "\n",
);
console.log(`Deployment verified and saved to ${output}: ${c.contract}`);
