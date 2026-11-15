import { execFileSync } from "node:child_process";
import { createRpc, DEVNET_GENESIS_HASH } from "../src/chain/config";
import { existsSync, mkdirSync } from "node:fs";
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
if ((await createRpc(url).getGenesisHash().send()) !== DEVNET_GENESIS_HASH)
  throw new Error("Deployment requires Solana devnet.");
const common = ["--url", url, "--keypair", ".local/deployer.json"];
execFileSync("solana", ["address", ...common], { stdio: "inherit" });
execFileSync("solana", ["balance", ...common], { stdio: "inherit" });
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
    "--commitment",
    "confirmed",
    "--with-compute-unit-price",
    "1000",
    ...common,
  ],
  { stdio: "inherit" },
);
execFileSync("npx", ["tsx", "scripts/initialize.ts"], {
  stdio: "inherit",
  env: { ...process.env, RPC_URL: url },
});
