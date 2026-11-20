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
/** `apiKey` is a provider key sent as a bearer token. It is not part of the record. */
export type Deployment = z.infer<typeof schema> & { apiKey?: string };
/**
 * `rpcUrl` replaces the public endpoint, for example with a keyed provider URL
 * from `VITE_RPC_URL`. `apiKey` is a key that the provider expects in the
 * Authorization header (Geomi), from `VITE_APTOS_API_KEY`. The public Aptos API
 * rate-limits anonymous browsers. Sessions do not depend on either, so
 * switching keeps them.
 */
export function parseDeployment(
  value: unknown,
  rpcUrl?: string,
  apiKey?: string,
): Deployment {
  const record = schema.parse(
    rpcUrl ? { ...(value as object), rpcUrl } : value,
  );
  return apiKey ? { ...record, apiKey } : record;
}
export const deploymentKey = (c: Deployment) =>
  `paymvc:aptos:v2:${c.chainId}:${c.package}:${c.publishHash}`;
const clients = new Map<string, Aptos>();
/** One client per endpoint and key, shared by reads and writes. */
export function server(c: Pick<Deployment, "rpcUrl" | "network" | "apiKey">) {
  const id = `${c.network}:${c.rpcUrl}:${c.apiKey ?? ""}`;
  let client = clients.get(id);
  if (!client) {
    client = new Aptos(
      new AptosConfig({
        network: c.network === "testnet" ? Network.TESTNET : Network.LOCAL,
        fullnode: c.rpcUrl,
        clientConfig: c.apiKey ? { API_KEY: c.apiKey } : undefined,
      }),
    );
    clients.set(id, client);
  }
  return client;
}
// Aptos.getLedgerInfo caches its result for 10 seconds. A read snapshot must
// include the user's latest transaction, so this reads the node directly.
export async function latestLedger(
  c: Pick<Deployment, "rpcUrl" | "network" | "apiKey">,
) {
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
