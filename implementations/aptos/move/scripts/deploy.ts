// Publish the immutable package with the Aptos CLI, then verify it and write
// the public deployment record. Rerunning after a publish skips to verification.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Account, Ed25519PrivateKey, Hex } from "@aptos-labs/ts-sdk";
import { normalizeAddress, parseDeployment, server } from "../src/chain/config";
import { moduleHash, verifyDeployment, view } from "../src/chain/payments";

const local = process.env.LOCAL === "1";
const network = local ? ("localnet" as const) : ("testnet" as const);
// RPC_URL selects the endpoint this script uses. It can hold a provider key, so the
// public record always gets the network's public URL.
const publicRpcUrl = local
  ? "http://127.0.0.1:8180/v1"
  : "https://api.testnet.aptoslabs.com/v1";
const rpcUrl = process.env.RPC_URL ?? publicRpcUrl;
// Publishing used 64,059 gas units (about 0.064 APT at 100 octas per unit). Keep a margin.
const REQUIRED_OCTAS = 10_000_000n;

mkdirSync(".local", { recursive: true, mode: 0o700 });
const keyFile = `.local/${network === "localnet" ? "local" : "testnet"}-deployer.json`;
if (!existsSync(keyFile)) {
  const key = Account.generate({ legacy: true });
  writeFileSync(
    keyFile,
    JSON.stringify({
      network,
      address: key.accountAddress.toStringLong(),
      privateKey: key.privateKey.toString(),
    }),
    { mode: 0o600, flag: "wx" },
  );
}
const wallet = JSON.parse(readFileSync(keyFile, "utf8"));
const privateKey = new Ed25519PrivateKey(wallet.privateKey);
const deployer = Account.fromPrivateKey({ privateKey, legacy: true });
const owner = deployer.accountAddress.toStringLong();
if (wallet.network !== network || owner !== wallet.address)
  throw new Error("Deployment wallet does not match this network.");
console.log(`${network} deployment address: ${owner}`);

const client = server({ rpcUrl, network });
const ledger = await client.getLedgerInfo();
const published = await client
  .getAccountResource({
    accountAddress: owner,
    resourceType: "0x1::code::PackageRegistry",
  })
  .then(
    (registry: { packages: { name: string }[] }) =>
      registry.packages.some((p) => p.name === "paymvc"),
    () => false,
  );
if (!published) {
  const balance = BigInt(
    await client.getBalance({
      accountAddress: owner,
      asset: "0x1::aptos_coin::AptosCoin",
    }),
  );
  if (balance < REQUIRED_OCTAS) {
    const needed = REQUIRED_OCTAS - balance;
    console.error(
      `Fund ${owner} with at least ${needed} octas (1 APT = 100000000 octas), then rerun.`,
    );
    process.exit(1);
  }
  // The CLI reads the key and the endpoint from a private temporary profile, never
  // from arguments, which other local users can read. The endpoint can hold a key.
  const dir = resolve(mkdtempSync(".local/publish-"));
  try {
    mkdirSync(`${dir}/.aptos`, { mode: 0o700 });
    writeFileSync(
      `${dir}/.aptos/config.yaml`,
      [
        "---",
        "profiles:",
        "  publish:",
        "    network: Custom",
        `    private_key: "${privateKey.toAIP80String()}"`,
        `    public_key: "ed25519-pub-${deployer.publicKey.toString()}"`,
        `    account: ${owner.slice(2)}`,
        `    rest_url: "${rpcUrl.replace(/\/v1\/?$/, "")}"`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    execFileSync(
      "aptos",
      [
        "move",
        "publish",
        "--package-dir",
        resolve("contracts"),
        "--named-addresses",
        `paymvc=${owner}`,
        "--profile",
        "publish",
        "--assume-yes",
      ],
      { stdio: "inherit", cwd: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The publish transaction is the deployer's successful call to publish_package_txn.
// It is among the deployer's first transactions; later ones fund live test users.
const transactions = await client.getAccountTransactions({
  accountAddress: owner,
  options: { offset: 0, limit: 100 },
});
const publication = transactions.find(
  (t) =>
    t.type === "user_transaction" &&
    t.success &&
    "function" in t.payload &&
    t.payload.function === "0x1::code::publish_package_txn",
);
if (!publication) throw new Error("Publish transaction not found.");
const hash = async (moduleName: string) =>
  moduleHash(
    (await client.getAccountModule({ accountAddress: owner, moduleName }))
      .bytecode,
  );
// Tie the published bytecode to this source: compile it for the deployer's address and
// compare each module with the chain.
execFileSync(
  "aptos",
  [
    "move",
    "compile",
    "--package-dir",
    "contracts",
    "--named-addresses",
    `paymvc=${owner}`,
  ],
  { stdio: "inherit" },
);
for (const name of ["credits", "paymvc"]) {
  const built = await moduleHash(
    Hex.fromHexInput(
      readFileSync(`contracts/build/paymvc/bytecode_modules/${name}.mv`),
    ).toString(),
  );
  if (built !== (await hash(name)))
    throw new Error(`The published ${name} module does not match this source.`);
}
const base = {
  network,
  rpcUrl,
  chainId: ledger.chain_id,
  package: owner,
  modules: { credits: await hash("credits"), paymvc: await hash("paymvc") },
  publishHash: publication.hash,
  faucetUrl: local
    ? "http://127.0.0.1:8181"
    : "https://aptos.dev/network/faucet",
};
const asset = (await view(
  { ...base, metadata: owner },
  "credits::metadata",
)) as { inner: string };
const config = parseDeployment({
  ...base,
  metadata: normalizeAddress(asset.inner),
});
await verifyDeployment(config);
mkdirSync("public", { recursive: true });
writeFileSync(
  local ? "public/local.json" : "public/deployment.json",
  JSON.stringify({ ...config, rpcUrl: publicRpcUrl }, null, 2) + "\n",
);
console.log(
  `Verified immutable package ${owner}; publish transaction ${publication.hash}`,
);
