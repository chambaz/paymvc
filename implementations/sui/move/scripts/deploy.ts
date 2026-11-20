// Deploy with the Sui CLI. One transaction publishes the package and makes it
// immutable; a second one finalizes the coin's registry entry. This script only
// prepares the CLI's private config, saves each signed transaction before it is
// sent, and writes and verifies the public deployment record.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { server, parseDeployment } from "../src/chain/config";
import { verifyDeployment } from "../src/chain/payments";

const local = process.env.LOCAL === "1";
const network = local ? "localnet" : "testnet";
// RPC_URL selects the endpoint this script uses. It can hold a provider key, so the
// public record always gets the network's public URL.
const publicRpcUrl = local
  ? "http://127.0.0.1:9000"
  : "https://fullnode.testnet.sui.io:443";
const rpcUrl = process.env.RPC_URL ?? publicRpcUrl;
mkdirSync(".local", { recursive: true, mode: 0o700 });
const keyFile = `.local/${local ? "local" : "testnet"}-deployer.json`;
if (!existsSync(keyFile)) {
  const key = Ed25519Keypair.generate();
  writeFileSync(
    keyFile,
    JSON.stringify({
      network,
      address: key.toSuiAddress(),
      privateKey: key.getSecretKey(),
    }),
    { mode: 0o600, flag: "wx" },
  );
}
const deployer = JSON.parse(readFileSync(keyFile, "utf8"));
if (
  Ed25519Keypair.fromSecretKey(deployer.privateKey).toSuiAddress() !==
    deployer.address ||
  deployer.network !== network
)
  throw new Error("Deployment wallet does not match this network.");
console.log(`${network} deployment address: ${deployer.address}`);

// A private CLI config for this deployer. The key goes into a 0600 keystore
// file, never into command arguments or output.
const cli = resolve(`.local/sui-${network}`);
mkdirSync(cli, { recursive: true, mode: 0o700 });
const { secretKey } = decodeSuiPrivateKey(deployer.privateKey);
writeFileSync(
  `${cli}/sui.keystore`,
  JSON.stringify([Buffer.from([0, ...secretKey]).toString("base64")]),
  { mode: 0o600 },
);
writeFileSync(
  `${cli}/client.yaml`,
  `keystore:\n  File: ${cli}/sui.keystore\nenvs:\n  - alias: ${network}\n    rpc: "${rpcUrl}"\nactive_env: ${network}\nactive_address: "${deployer.address}"\n`,
  { mode: 0o600 },
);
const sui = (...args: string[]) =>
  execFileSync(
    "sui",
    ["client", "--client.config", `${cli}/client.yaml`, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

const client = server({ network, rpcUrl });
const { chainIdentifier } = await client.getChainIdentifier();
// The saved transactions belong to one build of the package, so new code gets new files
// and a rerun of the same code sends the same signed bytes.
const { digest } = JSON.parse(
  execFileSync(
    "sui",
    ["move", "build", "--path", "contracts", "--dump-bytecode-as-base64"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ),
) as { digest: number[] };
const build = Buffer.from(digest).toString("hex").slice(0, 16);
const txFile = (label: string) =>
  `.local/${network}-${chainIdentifier}-${build}-${label}.tx`;

/**
 * Sign the PTB once and save it before broadcast. A rerun sends the same
 * signed bytes, so it cannot create a second publication.
 */
function execute(label: string, command: string[]) {
  const file = txFile(label);
  if (!existsSync(file))
    writeFileSync(
      file,
      sui(...command, "--serialize-signed-transaction").trim(),
      {
        mode: 0o600,
      },
    );
  const result = JSON.parse(
    sui(
      "execute-combined-signed-tx",
      "--signed-tx-bytes",
      readFileSync(file, "utf8"),
      "--json",
    ),
  );
  if (result.effects?.status?.status !== "success")
    throw new Error(
      `${label} failed. Delete ${file} only if it can never execute, then rerun.`,
    );
  return result as {
    digest: string;
    objectChanges: {
      type: string;
      objectId?: string;
      objectType?: string;
      packageId?: string;
    }[];
  };
}

// A public deployment is the app's identity: wallets, the directory, and evidence refer
// to it. New code, or a CLI that compiles different bytecode, would publish a new app,
// so that needs --replace. A rerun of the same build resends its saved transactions.
const record = "public/deployment.json";
if (
  !local &&
  existsSync(record) &&
  !existsSync(txFile("publish")) &&
  !process.argv.includes("--replace")
)
  throw new Error(
    `${record} names package ${JSON.parse(readFileSync(record, "utf8")).package}, and this build was never published. Nothing was published. Rerun with --replace to publish a new app.`,
  );

if (!existsSync(txFile("publish"))) {
  const { balance } = await client.getBalance({ owner: deployer.address });
  console.log(`Balance: ${balance.balance} MIST`);
  if (BigInt(balance.balance) < 200_000_000n)
    throw new Error(
      "Fund the deployment address with at least 0.2 SUI, then rerun.",
    );
}
// Testnet: one transaction publishes and makes the package immutable. The
// package manager does not publish to an ephemeral local chain with `ptb`, so
// local runs use its `test-publish` command, then make the package immutable.
const publish = execute(
  "publish",
  local
    ? [
        "test-publish",
        "contracts",
        "--build-env",
        "testnet",
        "--pubfile-path",
        `.local/${network}-${chainIdentifier}-Pub.toml`,
      ]
    : [
        "ptb",
        "--publish",
        "contracts",
        "--assign",
        "upgrade_cap",
        "--move-call",
        "0x2::package::make_immutable",
        "upgrade_cap",
      ],
);
const packageId = publish.objectChanges.find(
  (c) => c.type === "published",
)?.packageId;
const created = (suffix: string) =>
  publish.objectChanges.find(
    (c) => c.type === "created" && c.objectType?.endsWith(suffix),
  )?.objectId;
const coin = `${packageId}::credits::CREDITS`;
const app = created(`::paymvc::App<${coin}>`);
const currency = created(`::coin_registry::Currency<${coin}>`);
if (!packageId || !app || !currency)
  throw new Error("Published package, app, or currency not found.");

// The package can never be upgraded once its UpgradeCap is destroyed. On testnet, the
// publish transaction passes the new cap to make_immutable, so no cap survives it.
let immutable = publish;
if (local) {
  const cap = publish.objectChanges.find((c) =>
    c.objectType?.endsWith("::package::UpgradeCap"),
  )?.objectId;
  if (!cap) throw new Error("Published upgrade capability not found.");
  immutable = execute("immutable", [
    "ptb",
    "--move-call",
    "0x2::package::make_immutable",
    `@${cap}`,
  ]);
  if (
    !immutable.objectChanges.some(
      (c) => c.type === "deleted" && c.objectId === cap,
    )
  )
    throw new Error("The upgrade capability was not destroyed.");
} else if (
  publish.objectChanges.some(
    (c) =>
      c.objectType?.endsWith("::package::UpgradeCap") && c.type !== "deleted",
  )
)
  throw new Error("The publish transaction left an upgrade capability.");
const metadata = execute("metadata", [
  "ptb",
  "--move-call",
  "0x2::coin_registry::finalize_registration",
  `<${coin}>`,
  "@0xc",
  `@${currency}`,
]);

const pkg = await client.getObject({ objectId: packageId });
const config = parseDeployment({
  network,
  rpcUrl,
  chainIdentifier,
  package: packageId,
  app,
  packageDigest: pkg.object.digest,
  immutableDigest: immutable.digest,
  faucetUrl: local ? "http://127.0.0.1:9123/gas" : "https://faucet.sui.io/",
});
await verifyDeployment(config);
writeFileSync(
  local ? "public/local.json" : "public/deployment.json",
  JSON.stringify({ ...config, rpcUrl: publicRpcUrl }, null, 2) + "\n",
);
console.log(
  `Verified immutable package ${packageId}, app ${app}. Publish ${publish.digest}, metadata ${metadata.digest}.`,
);
