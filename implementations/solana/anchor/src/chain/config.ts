import {
  address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type ReadonlyUint8Array,
  type RpcTransport,
} from "@solana/kit";
import { z } from "zod";

export const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const schema = z.object({
  network: z.enum(["devnet", "localnet"]),
  rpcUrl: z.url(),
  program: z.string().refine(isAddress),
  genesisHash: z.string().min(32),
  faucetUrl: z.url(),
});
export type Deployment = ReturnType<typeof parseDeployment>;
export function parseDeployment(input: unknown) {
  const config = schema.parse(input);
  if (config.network === "devnet" && config.genesisHash !== DEVNET_GENESIS_HASH)
    throw new Error("Public demos require Solana devnet.");
  return { ...config, program: address(config.program) };
}
export const deploymentKey = (c: Deployment) =>
  `paymvc:solana:2:${c.genesisHash}:${c.program}`;
/**
 * Retry a request that a rate-limited (429) or unavailable (503) RPC rejected.
 * Wait for `Retry-After` when the response has it, otherwise 1, 2, 4, then 8 s.
 * Browsers cannot read devnet's `Retry-After`, so the fallback (15 s in total)
 * must outlast devnet's 10 s rate-limit block.
 */
export function withRetry(transport: RpcTransport): RpcTransport {
  return async (request) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(request);
      } catch (error) {
        if (
          attempt === 4 ||
          !isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ||
          (error.context.statusCode !== 429 && error.context.statusCode !== 503)
        )
          throw error;
        const after = error.context.headers?.get("retry-after");
        const delay = after
          ? Number(after) * 1000 || Date.parse(after) - Date.now()
          : 1_000 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
      }
    }
  };
}
/** A Solana RPC client that backs off when the RPC is rate-limited. */
export const createRpc = (url: string) =>
  createSolanaRpcFromTransport(withRetry(createDefaultRpcTransport({ url })));
const clients = new Map<string, ReturnType<typeof createRpc>>();
export function rpc(c: Deployment) {
  let client = clients.get(c.rpcUrl);
  if (!client) {
    client = createRpc(c.rpcUrl);
    clients.set(c.rpcUrl, client);
  }
  return client;
}
export const addressBytes = getAddressEncoder();
export async function pda(
  c: Deployment,
  ...seeds: (string | ReadonlyUint8Array)[]
) {
  return (
    await getProgramDerivedAddress({ programAddress: c.program, seeds })
  )[0];
}
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Format exact lamports as SOL without floating point, for example 50000000n → "0.050000000". */
export const formatNative = (_c: Deployment, lamports: bigint) =>
  `${lamports / LAMPORTS_PER_SOL}.${(lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0")}`;
