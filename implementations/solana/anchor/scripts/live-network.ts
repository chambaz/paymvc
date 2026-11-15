import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  deploymentKey,
  formatNative,
  parseDeployment,
  rpc,
  type Deployment,
} from "../src/chain/config";
import { fundingBudget } from "../src/chain/payments";
import { signerFor, type Session } from "../src/chain/session";
import { transact } from "../src/chain/transactions";
import { liveDirectory } from "./live-directory";

/** LOCAL=1 selects the loopback validator from `npm run local`. Otherwise public devnet. */
export const local = process.env.LOCAL === "1";

export function liveDeployment() {
  const c = parseDeployment(
    JSON.parse(
      readFileSync(
        local ? "public/local.json" : "public/deployment.json",
        "utf8",
      ),
    ),
  );
  if (c.network !== (local ? "localnet" : "devnet"))
    throw new Error(
      local
        ? "LOCAL=1 requires the local validator. Run npm run local first."
        : "Live checks require public devnet.",
    );
  mkdirSync(liveDirectory, { recursive: true, mode: 0o700 });
  return c;
}

/**
 * Top up `owner` from the deployer to the app's funding budget. The signed
 * transfer is saved before broadcast and reconciled on rerun. Only the journal
 * is saved: the deployer key stays in `.local/deployer.json`.
 */
export async function fund(c: Deployment, owner: Address) {
  const bytes = new Uint8Array(
    JSON.parse(readFileSync(".local/deployer.json", "utf8")),
  );
  const path = `${liveDirectory}/funding-${c.genesisHash}-${c.program}.json`;
  const deployer: Session = {
    version: 2,
    deployment: deploymentKey(c),
    key: {
      seed: Array.from(bytes.subarray(0, 32)),
      address: (await createKeyPairSignerFromBytes(bytes)).address,
    },
    ready: true,
    intent: null,
    journal: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
  };
  const persist = () =>
    writeFileSync(path, JSON.stringify(deployer.journal), { mode: 0o600 });
  const label = `fund:${owner}`;
  const shortfall = async () => {
    const { balance, required } = await fundingBudget(c, owner);
    return balance < required ? required - balance : 0n;
  };
  if (!deployer.journal[label] && (await shortfall()) === 0n) return;
  await transact(
    c,
    deployer,
    persist,
    () => {},
    label,
    async () => {
      const amount = await shortfall();
      const { value: available } = await rpc(c)
        .getBalance(deployer.key.address as Address, {
          commitment: "confirmed",
        })
        .send();
      if (available < amount + 10_000n)
        throw new Error(
          `The deployer ${deployer.key.address} has ${formatNative(c, available)} SOL. Fund it with at least ${formatNative(c, amount)} SOL.`,
        );
      console.log(`Funding ${owner} with ${formatNative(c, amount)} SOL.`);
      return [
        getTransferSolInstruction({
          source: await signerFor(deployer),
          destination: owner,
          amount,
        }),
      ];
    },
  );
}
