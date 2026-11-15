import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { foundry } from "viem/chains";
import { zeroAddress, type Address, type Hex } from "viem";
import {
  deploymentKey,
  parseDeployment,
  publicClient,
} from "../src/chain/config";
import { newSession, type Session } from "../src/chain/session";
import { fundingBudget } from "../src/chain/payments";
import { transact } from "../src/chain/transactions";
import { liveDirectory } from "./live-directory";
import {
  deploymentPath,
  network,
  networkId,
  privateDirectory,
} from "./network";

/** LOCAL=1 runs the live commands against `npm run local` (Anvil). Its evidence stays private. */
export const local = process.env.LOCAL === "1";
export const evidenceNetwork = local ? "local" : networkId;
export const config = parseDeployment(
  JSON.parse(
    readFileSync(
      local ? resolve("public", "local.json") : deploymentPath,
      "utf8",
    ),
  ),
);
if (!local && process.env.LIVE_RPC_URL) {
  const url = new URL(process.env.LIVE_RPC_URL);
  if (url.protocol !== "https:")
    throw new Error("LIVE_RPC_URL must use HTTPS.");
  config.rpcUrl = url.href;
}
if (config.chainId !== (local ? foundry.id : network.chain.id))
  throw new Error("The deployment does not match the selected network.");
export const target = { network: evidenceNetwork, local, deployment: config };

mkdirSync(liveDirectory, { recursive: true, mode: 0o700 });

export function saveSession(path: string, session: Session) {
  writeFileSync(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// One scenario user signs five transactions: registration and four PayMVC or token calls.
// Fund 1.5x the app's budget: fees can rise between funding and registration.
export async function scenarioBudget(address: Address) {
  return ((await fundingBudget(config, address)).required * 3n) / 2n;
}

/**
 * Tops up `address` to `amount` from the deployer. The deployer journal saves each signed
 * transfer before broadcast, and the next run reconciles any transfer without a receipt.
 */
export async function fund(address: Address, amount: bigint) {
  const path = join(liveDirectory, `funder-${config.address}.json`);
  const keyPath = local
    ? resolve(".local", "local-deployer")
    : join(
        privateDirectory,
        `${networkId === "ethereum" ? "sepolia" : config.chainId}-deployer`,
      );
  const session: Session = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {
        ...newSession(config),
        key: readFileSync(keyPath, "utf8").trim() as Hex,
      };
  if (session.deployment !== deploymentKey(config))
    throw new Error("The funding journal belongs to another deployment.");
  const persist = () => saveSession(path, session);
  for (const [label, record] of Object.entries(session.journal))
    if (!record.confirmed)
      await transact(config, session, persist, () => {}, label, zeroAddress);
  const balance = await publicClient(config).getBalance({ address });
  if (balance >= amount) return;
  await transact(
    config,
    session,
    persist,
    () => {},
    `fund:${address}:${balance}`,
    address,
    "0x",
    amount - balance,
  );
}
