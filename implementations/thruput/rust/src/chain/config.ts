import {
  addressFromBase58,
  createThruputClient,
  formatUnits,
  futurenet,
  localnet,
  hashFromBase58,
  JsonRpcError,
  NativeRpcErrorCode,
  toBase58,
} from "@thruputchain/client";
import { z } from "zod";
import { networkHash } from "@thruputchain/protocol";

export function normalizeAddress(value: string) {
  try {
    const address = toBase58(addressFromBase58(value));
    if (address !== value) throw new Error();
    return address;
  } catch {
    throw new Error("Enter a complete Thruput base58 address.");
  }
}
const address = z.string().refine((value) => {
  try {
    normalizeAddress(value);
    return true;
  } catch {
    return false;
  }
});
const schema = z.object({
  network: z.enum(["futurenet", "localnet"]),
  networkHash: address,
  /** The PayMVC contract and its code hash. */
  address,
  contractHash: address,
  /** The credits token and its code hash. */
  credits: address,
  creditsHash: address,
  rpcUrl: z.url(),
  faucetUrl: z.url(),
  explorerUrl: z.url(),
});
export type Deployment = z.infer<typeof schema>;
export const parseDeployment = (value: unknown) => schema.parse(value);
export const deploymentKey = (c: Deployment) =>
  `paymvc:thruput:v3:${c.networkHash}:${c.address}`;

/** One native token is 10,000,000 base units. */
const NATIVE_DECIMALS = 7;
/** Format exact native-token base units, for example 100000000n → "10". */
export const formatNative = (_c: Deployment, amount: bigint) =>
  formatUnits(amount, NATIVE_DECIMALS);

function connect(c: Deployment) {
  return createThruputClient({
    cluster: (c.network === "localnet" ? localnet : futurenet)({
      rpcUrl: c.rpcUrl,
      networkHash: networkHash(hashFromBase58(c.networkHash)),
    }),
  });
}
export type Client = Awaited<ReturnType<typeof connect>>;
const clients = new Map<string, ReturnType<typeof connect>>();
export function clientFor(c: Deployment) {
  const key = `${c.rpcUrl}:${c.networkHash}`;
  let client = clients.get(key);
  if (!client) {
    client = connect(c);
    clients.set(key, client);
    void client.catch(() => clients.delete(key));
  }
  return client;
}

const heightUnavailable = (error: unknown): boolean =>
  error instanceof JsonRpcError
    ? error.code === NativeRpcErrorCode.StateHeightUnavailable
    : error instanceof Error && heightUnavailable(error.cause);

/**
 * Run a read that needs a minimum state height. Right after a commit the node
 * may not serve that height yet; wait for it (up to about 5 s) instead of
 * reporting a failure. Every other error is thrown at once.
 */
export async function waitForHeight<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === 20 || !heightUnavailable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
