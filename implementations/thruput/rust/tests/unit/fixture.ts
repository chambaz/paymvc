import { toBase58 } from "@thruputchain/client";
import type { Deployment } from "../../src/chain/config";
export const config: Deployment = {
  network: "futurenet",
  networkHash: toBase58(new Uint8Array(32).fill(1)),
  address: toBase58(new Uint8Array(32).fill(2)),
  contractHash: toBase58(new Uint8Array(32).fill(3)),
  credits: toBase58(new Uint8Array(32).fill(4)),
  creditsHash: toBase58(new Uint8Array(32).fill(5)),
  rpcUrl: "https://rpc.thruput.network",
  faucetUrl: "https://thruput-faucet.up.railway.app",
  explorerUrl: "https://explorer.thruput.network",
};
