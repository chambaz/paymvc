import { Networks, rpc, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

const schema = z.object({
  network: z.enum(["testnet", "localnet"]),
  passphrase: z.string(),
  rpcUrl: z.url(),
  horizonUrl: z.url(),
  faucetUrl: z.url(),
  contract: z.string().refine(StrKey.isValidContract),
  token: z.string().refine(StrKey.isValidContract),
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Deployment = z.infer<typeof schema>;
export function parseDeployment(input: unknown): Deployment {
  const c = schema.parse(input);
  if (
    c.passphrase !==
    (c.network === "testnet" ? Networks.TESTNET : Networks.STANDALONE)
  )
    throw new Error("Unsupported test network.");
  if (
    c.network === "localnet" &&
    !["127.0.0.1", "localhost"].includes(new URL(c.rpcUrl).hostname)
  )
    throw new Error("Local RPC must use loopback.");
  return c;
}
export const deploymentKey = (c: Deployment) =>
  `paymvc:stellar:v2:${c.network}:${c.contract}:${c.codeHash}`;
export const server = (c: Deployment) =>
  new rpc.Server(c.rpcUrl, {
    allowHttp: c.network === "localnet",
    timeout: 15_000,
  });
const STROOPS_PER_XLM = 10_000_000n;
/** Format exact stroops as XLM without floating point or trailing zeros, for example 20000000n → "2". */
export const formatNative = (_c: Deployment, stroops: bigint) => {
  const fraction = (stroops % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return fraction
    ? `${stroops / STROOPS_PER_XLM}.${fraction}`
    : `${stroops / STROOPS_PER_XLM}`;
};
