import {
  AccountAddress,
  Aptos,
  AptosConfig,
  getAptosFullNode,
  Network,
  type LedgerInfo,
} from "@aptos-labs/ts-sdk";
import { z } from "zod";

export function normalizeAddress(value: string) {
  return AccountAddress.fromString(value.trim()).toStringLong();
}
const address = z.string().regex(/^0x[0-9a-f]{64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.object({
  network: z.enum(["testnet", "localnet"]),
  rpcUrl: z.url(),
  chainId: z.number().int().nonnegative(),
  package: address,
  metadata: address,
  // SHA-256 of each published module's bytecode.
  modules: z.object({ credits: sha256, paymvc: sha256 }),
  publishHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  faucetUrl: z.url(),
});
export type Deployment = z.infer<typeof schema>;
/**
 * `rpcUrl` replaces the public endpoint, for example with a keyed provider URL
 * from `VITE_RPC_URL`. The public Aptos API rate-limits anonymous browsers.
 * Sessions do not depend on the RPC URL, so switching keeps them.
 */
export const parseDeployment = (value: unknown, rpcUrl?: string) =>
  schema.parse(rpcUrl ? { ...(value as object), rpcUrl } : value);
export const deploymentKey = (c: Deployment) =>
  `paymvc:aptos:v2:${c.chainId}:${c.package}:${c.publishHash}`;
export const server = (c: Pick<Deployment, "rpcUrl" | "network">) =>
  new Aptos(
    new AptosConfig({
      network: c.network === "testnet" ? Network.TESTNET : Network.LOCAL,
      fullnode: c.rpcUrl,
    }),
  );
// Aptos.getLedgerInfo caches its result for 10 seconds. A read snapshot must
// include the user's latest transaction, so this reads the node directly.
export async function latestLedger(c: Pick<Deployment, "rpcUrl" | "network">) {
  const { data } = await getAptosFullNode<{}, LedgerInfo>({
    aptosConfig: server(c).config,
    originMethod: "getLedgerInfo",
    path: "",
  });
  return data;
}
const OCTAS_PER_APT = 100_000_000n;
/** Format exact octas as APT without floating point or trailing zeros, for example 10000000n → "0.1". */
export const formatNative = (_c: Deployment, octas: bigint) => {
  const fraction = (octas % OCTAS_PER_APT)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction
    ? `${octas / OCTAS_PER_APT}.${fraction}`
    : `${octas / OCTAS_PER_APT}`;
};
