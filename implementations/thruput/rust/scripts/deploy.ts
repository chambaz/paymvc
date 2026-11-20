/**
 * Deploy the credits token and PayMVC with the Thruput CLI, then write the
 * deployment record.
 *
 *   npm run contracts:build
 *   npm run local                 # starts a local node and runs `deploy -- --local`
 *   npm run deploy                # Futurenet
 *
 * The CLI runs with a private configuration directory in `.local/`, so the
 * deployment key never mixes with global keys. On Futurenet, each CLI result
 * is saved in `.local/futurenet-cli/deployment.json` before the next step,
 * so a rerun resumes after the last completed step. The journal starts over
 * when the network or the built contracts change. A local chain is
 * disposable, so a local deployment always starts over.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseDeployment } from "../src/chain/config";
import { verifyDeployment } from "../src/chain/payments";
import { CliError, cliConfig, ensureKey, thruput as run } from "./cli";

const local = process.argv.includes("--local");
const network = local ? "local" : "futurenet";
const rpcUrl = local ? "http://127.0.0.1:9545" : "https://rpc.thruput.network";
/** Native tokens that fund each contract's storage. */
const CONTRACT_FUNDING = "25";
/** Native-token base units the deployer needs: both contracts plus scheduling capacity. */
const DEPLOYER_REQUIRED = 600_000_000n;
const { dir: configDir, env, keyName } = cliConfig(network);
const journalPath = `${configDir}/deployment.json`;

type Deployed = {
  txHash: string;
  address: string;
  nativeDeployment: { networkHash: string; contractHash: string };
};
type Journal = {
  deployer?: string;
  /** The network and the built artifacts that this journal deploys. */
  networkHash?: string;
  artifacts?: string;
  credits?: Deployed;
  paymvc?: Deployed;
};
const artifacts = ["credits", "paymvc"]
  .map((name) =>
    createHash("sha256")
      .update(readFileSync(`target/thruput/${name}.rv32a`))
      .digest("hex"),
  )
  .join(":");

const thruput = (args: string[]) => run(args, env);
const target = ["--profile", network, "--rpc-url", rpcUrl];

let journal: Journal = {};
if (!local)
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
const save = () => {
  writeFileSync(`${journalPath}.tmp`, JSON.stringify(journal, null, 2), {
    mode: 0o600,
  });
  renameSync(`${journalPath}.tmp`, journalPath);
};

const deployer = ensureKey(keyName, env);
journal.deployer = deployer;
save();
console.log("Deployment wallet:", deployer);

// The private profile signs with the deployer key for the network that the
// RPC serves. The CLI requires a pinned network hash. Config commands keep
// other CLI state, such as the runtime record of a running local node.
{
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getNetworkInfo",
      params: {},
    }),
  });
  const { networkHash } = (await response.json()).result;
  // A reset network or new contract code needs a new deployment. After a reset, the old
  // app no longer exists. New code on the same network would replace a live app, whose
  // wallets, directory, and evidence refer to it, so that needs --replace.
  if (journal.networkHash !== networkHash || journal.artifacts !== artifacts) {
    if (
      journal.paymvc &&
      journal.networkHash === networkHash &&
      !process.argv.includes("--replace")
    )
      throw new Error(
        "The contracts changed since the saved deployment. Nothing was deployed. Rerun with --replace to deploy a new app.",
      );
    if (journal.paymvc)
      console.log("The network or the contracts changed. Deploying again.");
    journal = { deployer: journal.deployer, networkHash, artifacts };
    save();
  }
  try {
    thruput(["config", "rm", network, "--global", "--yes"]);
  } catch (error) {
    if ((error as CliError).code !== "profile_not_found_in_scope") throw error;
  }
  thruput([
    "config",
    "new",
    network,
    "--network",
    network,
    "--rpc-url",
    rpcUrl,
    "--network-hash",
    networkHash,
    "--default-key",
    keyName,
    "--global",
  ]);
}

if (!journal.paymvc) {
  const { rawBalance } = thruput(["balance", deployer, ...target]);
  if (BigInt(rawBalance) < DEPLOYER_REQUIRED)
    throw new Error(
      local
        ? `${deployer} is not funded. Start the local node with \`npm run local\`, which funds it at genesis.`
        : `Fund ${deployer} with at least ${DEPLOYER_REQUIRED / 10_000_000n} native tokens, then rerun.`,
    );
}

// The token deploys uninitialized. PayMVC's initializer then makes PayMVC
// its only minter in the same transaction as PayMVC's deployment. If anyone
// initializes the token first, that deployment fails and nothing is bound.
journal.credits ??= thruput([
  "deploy",
  "--artifact",
  "target/thruput/credits.rv32a",
  "--fund",
  CONTRACT_FUNDING,
  "--yes",
  ...target,
]);
save();
try {
  journal.paymvc ??= thruput([
    "deploy",
    "--artifact",
    "target/thruput/paymvc.rv32a",
    "--fund",
    CONTRACT_FUNDING,
    "--init",
    "initialize",
    "--init-arg",
    journal.credits!.address,
    "--yes",
    ...target,
  ]);
} catch (error) {
  // The token was initialized before this PayMVC could bind it: by someone else, or by
  // an earlier PayMVC deploy that landed although the CLI reported an error. Drop it, so
  // that a rerun deploys a fresh token and PayMVC.
  if (/AlreadyInitialized/.test(String((error as Error).message))) {
    delete journal.credits;
    save();
    throw new Error(
      "The credits token is already initialized, by another account or by an earlier PayMVC deploy whose result was not saved. Rerun to deploy a new token and PayMVC.",
    );
  }
  throw error;
}
save();

const { credits, paymvc } = journal as Required<Journal>;
// The local node sends no CORS headers, so the app reads it through the
// development server's same-origin proxy (see vite.config.ts).
const record = {
  network: local ? "localnet" : "futurenet",
  networkHash: paymvc.nativeDeployment.networkHash,
  address: paymvc.address,
  contractHash: paymvc.nativeDeployment.contractHash,
  credits: credits.address,
  creditsHash: credits.nativeDeployment.contractHash,
  rpcUrl: local
    ? `http://127.0.0.1:${process.env.PAYMVC_DEV_PORT ?? "5190"}/thruput-rpc`
    : rpcUrl,
  faucetUrl: "https://thruput-faucet.up.railway.app",
  explorerUrl: "https://explorer.thruput.network",
};
// Check the record as the app does: the network hash, both code hashes,
// PayMVC's token, and the token's zero decimals. The local record's proxy is
// not running yet, so the check reads the node directly.
await verifyDeployment(parseDeployment({ ...record, rpcUrl }));
console.log("Verified the deployment record.");
const recordPath = local ? "public/local.json" : "public/deployment.json";
writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
console.log("Credits:", credits.address, "transaction:", credits.txHash);
console.log("PayMVC:", paymvc.address, "transaction:", paymvc.txHash);
console.log("Wrote", recordPath);
