import { execFileSync } from "node:child_process";
import { createRpc, DEVNET_GENESIS_HASH } from "../src/chain/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PAYMVC_PROGRAM_ADDRESS } from "../src/chain/generated";

mkdirSync(".local", { recursive: true, mode: 0o700 });
mkdirSync("public", { recursive: true });
const programKey = ".local/paymvc-program.json";
if (!existsSync(programKey))
  throw new Error(
    `Save the program key in ${programKey}, set its address in declare_id! and Anchor.toml, and rebuild.`,
  );
const program = execFileSync("solana-keygen", ["pubkey", programKey], {
  encoding: "utf8",
}).trim();
if (program !== PAYMVC_PROGRAM_ADDRESS)
  throw new Error(
    "The program key does not match the built client. Sync the program identity and rebuild before deployment.",
  );
for (const file of ["deployer", "paymvc-buffer"]) {
  const path = `.local/${file}.json`;
  if (!existsSync(path))
    execFileSync(
      "solana-keygen",
      ["new", "--no-bip39-passphrase", "--silent", "--outfile", path],
      { stdio: "inherit" },
    );
}
const url = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const client = createRpc(url);
if ((await client.getGenesisHash().send()) !== DEVNET_GENESIS_HASH)
  throw new Error("Deployment requires Solana devnet.");
// The CLI reads the endpoint from a private config file, never from arguments, which
// other local users can read. The endpoint can hold a provider key.
const config = resolve(".local/solana-cli.yml");
writeFileSync(
  config,
  [
    `json_rpc_url: ${JSON.stringify(url)}`,
    'websocket_url: ""',
    `keypair_path: ${JSON.stringify(resolve(".local/deployer.json"))}`,
    "commitment: confirmed",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const common = ["--config", config];
execFileSync("solana", ["address", ...common], { stdio: "inherit" });
execFileSync("solana", ["balance", ...common], { stdio: "inherit" });
// The program address is fixed and the program is final, so a finished upload cannot
// run again. A rerun skips it and continues with initialization.
const { value: deployed } = await client
  .getAccountInfo(PAYMVC_PROGRAM_ADDRESS, { encoding: "base64" })
  .send();
if (deployed?.executable) {
  console.log(`Program ${PAYMVC_PROGRAM_ADDRESS} is already deployed.`);
} else {
  // A fixed program key and buffer let the CLI resume an interrupted upload.
  execFileSync(
    "solana",
    [
      "program",
      "deploy",
      "target/deploy/paymvc.so",
      "--program-id",
      programKey,
      "--buffer",
      ".local/paymvc-buffer.json",
      "--use-tpu-client",
      // No upgrade authority: the program cannot change under existing sessions.
      "--final",
      "--commitment",
      "confirmed",
      "--with-compute-unit-price",
      "1000",
      ...common,
    ],
    { stdio: "inherit" },
  );
}
execFileSync("npx", ["tsx", "scripts/initialize.ts"], {
  stdio: "inherit",
  env: { ...process.env, RPC_URL: url },
});
