import { spawn, type ChildProcess } from "node:child_process";
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
// Forge reads the named endpoint from foundry.toml. RPC_URL overrides the endpoint that
// this script and forge use. It can hold a provider key, so it never goes in the public
// record or on forge's command line: the `private` endpoint reads it from the environment.
const publicRpcUrl = local ? "http://127.0.0.1:8545" : network.rpcUrl;
const endpoint = process.env.RPC_URL ? "private" : local ? "anvil" : networkId;
const rpcUrl = process.env.RPC_URL ?? publicRpcUrl;
const path = local ? resolve("public", "local.json") : deploymentPath;
const resume = process.argv.includes("--resume");
const replace = process.argv.includes("--replace");
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

// A public deployment is the app's identity: wallets and evidence refer to it. A rerun
// checks the existing record instead of deploying a new app, unless --replace is given.
if (!local && !resume && !replace) {
  let existing: { address: Address; codeHash: Hex } | undefined;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    const code = await client.getCode({ address: existing.address });
    if (!code || keccak256(code) !== existing.codeHash)
      throw new Error(
        `${path} does not match the code on chain. Rerun with --replace to deploy a new app.`,
      );
    console.log(
      `${path} matches the code on chain. Nothing was deployed. Rerun with --replace to deploy a new app.`,
    );
    process.exit(0);
  }
}
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
// command line, which other local users can read. Both files are removed afterwards,
// also after an interrupt: the handlers stop forge first, then cleanup runs.
const secrets = resolve(".local", `forge-${process.pid}`);
let forge: ChildProcess | undefined;
let interrupted = false;
const stop = (signal: NodeJS.Signals) => {
  interrupted = true;
  forge?.kill(signal);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
let status: number | null = null;
try {
  await mkdir(secrets, { mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  await writeFile(resolve(secrets, "password"), password, { mode: 0o600 });
  await writeFile(
    resolve(secrets, "keystore.json"),
    JSON.stringify(keystore(key, password)),
    { mode: 0o600 },
  );
  if (!interrupted) {
    // Foundry saves the transactions before broadcast; `--resume` sends any that did not land.
    const child = spawn(
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
        ...(resume ? ["--resume"] : []),
      ],
      { stdio: "inherit" },
    );
    forge = child;
    status = await new Promise<number | null>((done, failed) => {
      child.on("error", failed);
      child.on("close", done);
    });
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await rm(secrets, { recursive: true, force: true });
}
if (status !== 0)
  throw new Error(
    interrupted
      ? "Deployment interrupted. Rerun with --resume to continue it."
      : "forge script failed. Rerun with --resume to continue it.",
  );

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
  rpcUrl: publicRpcUrl,
  address,
  token,
  deploymentBlock: BigInt(receipt.blockNumber).toString(),
  codeHash: keccak256(code),
  faucetUrl: network.faucetUrl,
};
await mkdir(resolve(path, ".."), { recursive: true });
await writeFile(path, JSON.stringify(record, null, 2) + "\n");
console.log(
  JSON.stringify({ ...record, transactionHash: deployment.hash }, null, 2),
);
