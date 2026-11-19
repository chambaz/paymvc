import { SuiGrpcClient } from "@mysten/sui/grpc";
import { MIST_PER_SUI } from "@mysten/sui/utils";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-f]{64}$/);
const schema = z.object({
  network: z.enum(["testnet", "localnet"]),
  rpcUrl: z.url(),
  chainIdentifier: z.string().min(1),
  package: address,
  app: address,
  packageDigest: z.string().min(1),
  // The transaction that destroyed the package's UpgradeCap. On testnet it also published it.
  immutableDigest: z.string().min(1),
  faucetUrl: z.url(),
});
export type Deployment = z.infer<typeof schema>;
export const parseDeployment = (value: unknown) => schema.parse(value);
export const deploymentKey = (c: Deployment) =>
  `paymvc:sui:v2:${c.chainIdentifier}:${c.package}:${c.app}`;
const clients = new Map<string, SuiGrpcClient>();
/** One gRPC client per endpoint, shared by reads and writes. */
export function server(c: Pick<Deployment, "network" | "rpcUrl">) {
  let client = clients.get(c.rpcUrl);
  if (!client) {
    client = new SuiGrpcClient({ network: c.network, baseUrl: c.rpcUrl });
    clients.set(c.rpcUrl, client);
  }
  return client;
}
export const coinType = (c: Deployment) => `${c.package}::credits::CREDITS`;
/** Format exact MIST as SUI without floating point or trailing zeros, for example 100000000n → "0.1". */
export const formatNative = (_c: Deployment, mist: bigint) => {
  const fraction = (mist % MIST_PER_SUI)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction
    ? `${mist / MIST_PER_SUI}.${fraction}`
    : `${mist / MIST_PER_SUI}`;
};
