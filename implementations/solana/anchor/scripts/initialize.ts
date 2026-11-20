import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type Signature,
} from "@solana/kit";
import {
  getInitializeInstructionAsync,
  PAYMVC_PROGRAM_ADDRESS,
} from "../src/chain/generated";
import { createRpc, parseDeployment, pda } from "../src/chain/config";
import { verifyDeployment } from "../src/chain/payments";

const local = process.argv.includes("--local");
// RPC_URL selects the endpoint this script uses. It can hold a provider key, so the
// public record always gets the network's public URL.
const publicRpcUrl = local
  ? "http://127.0.0.1:8899"
  : "https://api.devnet.solana.com";
const rpcUrl = process.env.RPC_URL ?? publicRpcUrl;
const client = createRpc(rpcUrl);
const config = parseDeployment({
  network: local ? "localnet" : "devnet",
  rpcUrl,
  program: PAYMVC_PROGRAM_ADDRESS,
  genesisHash: await client.getGenesisHash().send(),
  faucetUrl: "https://faucet.solana.com",
});
const deployer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(".local/deployer.json", "utf8"))),
);
// The signed transaction, saved before broadcast. It holds no key material.
const path = `.local/initialize-${config.program}-${config.genesisHash}.json`;
type Saved = { raw: string; hash: Signature; lastValidBlockHeight: string };
const mint = await pda(config, "mint");
const existing = await client
  .getAccountInfo(mint, { encoding: "base64", commitment: "confirmed" })
  .send();

if (existing.value && existsSync(path)) rmSync(path);
if (!existing.value) {
  let saved: Saved;
  if (existsSync(path)) saved = JSON.parse(readFileSync(path, "utf8"));
  else {
    const instruction = await getInitializeInstructionAsync({
      payer: deployer,
    });
    const { value: lifetime } = await client
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(deployer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstruction(instruction, m),
      ),
    );
    saved = {
      raw: getBase64EncodedWireTransaction(tx),
      hash: getSignatureFromTransaction(tx),
      lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
    };
    writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
  }
  // Rebroadcast the same bytes until they confirm, fail, or expire.
  for (;;) {
    const [status] = (
      await client
        .getSignatureStatuses([saved.hash], { searchTransactionHistory: true })
        .send()
    ).value;
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (!status.err) break;
      rmSync(path);
      throw new Error("Initialization failed on-chain. Rerun to retry.");
    }
    const height = await client
      .getBlockHeight({ commitment: "finalized" })
      .send();
    if (height > BigInt(saved.lastValidBlockHeight)) {
      const final = await client
        .getSignatureStatuses([saved.hash], { searchTransactionHistory: true })
        .send();
      if (final.value[0]) continue;
      rmSync(path);
      throw new Error("Initialization expired. Rerun to sign a new one.");
    }
    await client
      .sendTransaction(saved.raw as Base64EncodedWireTransaction, {
        encoding: "base64",
        skipPreflight: true,
        maxRetries: 0n,
      })
      .send()
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  rmSync(path);
}

// The same checks as the browser: network, immutable program, and mint settings.
await verifyDeployment(config);
writeFileSync(
  local ? "public/local.json" : "public/deployment.json",
  JSON.stringify({ ...config, rpcUrl: publicRpcUrl }, null, 2) + "\n",
);
console.log(`Initialized ${config.network} mint: ${mint}`);
