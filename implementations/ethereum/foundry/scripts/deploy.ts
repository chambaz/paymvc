import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  network,
  networkId,
  deploymentPath,
  privateDirectory,
} from "./network";
import { paymvcAbi } from "../src/chain/generated/paymvcAbi";
import { keystore } from "./keystore";

// Foundry deploys: `forge script script/Deploy.s.sol --broadcast`. This file only selects the key,
// runs that command, and writes the verified public deployment record from its broadcast output.
const local = process.argv.includes("--local");
const chain = local ? foundry : network.chain;
// Forge reads the named endpoint from foundry.toml. RPC_URL overrides it for both tools.
const endpoint = process.env.RPC_URL ?? (local ? "anvil" : networkId);
const rpcUrl =
  process.env.RPC_URL ?? (local ? "http://127.0.0.1:8545" : network.rpcUrl);
const keyPath = local
  ? resolve(".local", "local-deployer")
  : resolve(
      privateDirectory,
      `${networkId === "ethereum" ? "sepolia" : chain.id}-deployer`,
    );

await mkdir(resolve(keyPath, ".."), { recursive: true, mode: 0o700 });
let key: Hex;
try {
  key = (await readFile(keyPath, "utf8")).trim() as Hex;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  key = generatePrivateKey();
  await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
}
const deployer = privateKeyToAccount(key).address;
const client = createPublicClient({ chain, transport: http(rpcUrl) });
if ((await client.getChainId()) !== chain.id)
  throw new Error("RPC chain does not match the selected test network.");
if (local)
  await client.request({
    method: "anvil_setBalance" as never,
    params: [deployer, "0x8ac7230489e80000"] as never,
  });
const balance = await client.getBalance({ address: deployer });
console.log(
  JSON.stringify({
    network: chain.name,
    deployer,
    balanceWei: balance.toString(),
  }),
);
if (balance === 0n)
  throw new Error(
    "Fund the testnet deployer address above, then rerun. The key is stored locally and has not been printed.",
  );

// Forge reads the key from an encrypted keystore and a password file, never from the
// command line, which other local users can read. Both files are removed afterwards.
const secrets = resolve(".local", `forge-${process.pid}`);
await mkdir(secrets, { mode: 0o700 });
const password = randomBytes(32).toString("hex");
await writeFile(resolve(secrets, "password"), password, { mode: 0o600 });
await writeFile(
  resolve(secrets, "keystore.json"),
  JSON.stringify(keystore(key, password)),
  { mode: 0o600 },
);
// Foundry saves the transactions before broadcast; `--resume` sends any that did not land.
const forge = spawnSync(
  "forge",
  [
    "script",
    "script/Deploy.s.sol",
    "--rpc-url",
    endpoint,
    "--broadcast",
    // Gas comes from the network's own estimate, not Foundry's local EVM: forks can price state
    // creation differently (Sepolia estimates 7x the local figure). 110% stays below the
    // per-transaction gas cap.
    "--skip-simulation",
    "--gas-estimate-multiplier",
    "110",
    "--keystore",
    resolve(secrets, "keystore.json"),
    "--password-file",
    resolve(secrets, "password"),
    ...(process.argv.includes("--resume") ? ["--resume"] : []),
  ],
  { stdio: "inherit" },
);
await rm(secrets, { recursive: true, force: true });
if (forge.status !== 0)
  throw new Error("forge script failed. Rerun with --resume to continue it.");

type Broadcast = {
  transactions: {
    hash: Hex;
    contractName: string;
    contractAddress: Address;
  }[];
  receipts: { transactionHash: Hex; blockNumber: Hex; status: Hex }[];
};
const broadcast: Broadcast = JSON.parse(
  await readFile(`broadcast/Deploy.s.sol/${chain.id}/run-latest.json`, "utf8"),
);
const deployment = broadcast.transactions.find(
  (transaction) => transaction.contractName === "PayMVC",
);
const receipt = broadcast.receipts.find(
  (receipt) => receipt.transactionHash === deployment?.hash,
);
if (!deployment || receipt?.status !== "0x1")
  throw new Error("The broadcast has no successful PayMVC deployment.");

const address = deployment.contractAddress;
// Public RPCs balance load across nodes. Wait until this node also has the deployment.
await client.waitForTransactionReceipt({ hash: deployment.hash });
const [token, code] = await Promise.all([
  client.readContract({ address, abi: paymvcAbi, functionName: "token" }),
  client.getCode({ address }),
]);
if (!code) throw new Error("Deployed bytecode not available.");
const record = {
  chainId: chain.id,
  rpcUrl,
  address,
  token,
  deploymentBlock: BigInt(receipt.blockNumber).toString(),
  codeHash: keccak256(code),
  faucetUrl: network.faucetUrl,
};
const path = local ? resolve("public", "local.json") : deploymentPath;
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, JSON.stringify(record, null, 2) + "\n");
console.log(
  JSON.stringify({ ...record, transactionHash: deployment.hash }, null, 2),
);
