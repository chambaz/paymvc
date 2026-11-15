import { z } from "zod";
import {
  isAddress,
  createPublicClient,
  formatUnits,
  http,
  type Address,
  type Chain,
} from "viem";
import { evmChain } from "../networks";

const schema = z.object({
  chainId: z.union([
    z.literal(11155111),
    z.literal(31337),
    z.literal(84532),
    z.literal(10143),
    z.literal(46630),
  ]),
  rpcUrl: z.url(),
  address: z.string().refine(isAddress),
  token: z.string().refine(isAddress),
  deploymentBlock: z.string().regex(/^\d+$/),
  codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  faucetUrl: z.url(),
});
export type Deployment = z.infer<typeof schema> & {
  address: Address;
  token: Address;
};

export function parseDeployment(input: unknown): Deployment {
  return schema.parse(input) as Deployment;
}
export function chainFor(config: Deployment): Chain {
  return evmChain(config.chainId);
}
/** Formats a native token amount, such as a funding reserve, in whole units. */
export function formatNative(config: Deployment, amount: bigint) {
  return formatUnits(amount, chainFor(config).nativeCurrency.decimals);
}
function makePublicClient(config: Deployment) {
  return createPublicClient({
    chain: chainFor(config),
    transport: http(config.rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 15_000,
    }),
    pollingInterval: config.chainId === 31337 ? 100 : 4_000,
  });
}
// Share receipt/block polling across reads and writes.
const clients = new Map<string, ReturnType<typeof makePublicClient>>();
export function publicClient(config: Deployment) {
  const key = `${config.chainId}:${config.rpcUrl}`;
  let client = clients.get(key);
  if (!client) {
    client = makePublicClient(config);
    clients.set(key, client);
  }
  return client;
}
export function deploymentKey(config: Deployment) {
  return `paymvc:v2:${config.chainId}:${config.address.toLowerCase()}:${config.codeHash}`;
}
