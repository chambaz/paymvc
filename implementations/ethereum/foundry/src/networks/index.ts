import { baseSepolia, foundry, monadTestnet, sepolia } from "viem/chains";
import { defineChain } from "viem";

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

export const defaultNetwork = "ethereum";
export const networks = {
  ethereum: {
    name: "Ethereum",
    label: "Sepolia",
    deployment: "sepolia.json",
    chain: sepolia,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    faucetUrl:
      "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
    port: 5173,
    fundingMinimum: "0.0005",
    // Sepolia prices new storage far above other networks: a request uses about 1.25M gas.
    fundingGas: 5_000_000n,
  },
  base: {
    name: "Base",
    label: "Base Sepolia",
    deployment: "base-sepolia.json",
    chain: baseSepolia,
    rpcUrl: "https://sepolia.base.org",
    faucetUrl: "https://portal.cdp.coinbase.com/onchain-tools/faucet",
    port: 5177,
    // Base Sepolia fees are low, so a smaller reserve covers the demo.
    fundingMinimum: "0.00005",
    fundingGas: 1_500_000n,
  },
  monad: {
    name: "Monad",
    label: "Monad Testnet",
    deployment: "monad-testnet.json",
    chain: monadTestnet,
    rpcUrl: "https://testnet-rpc.monad.xyz",
    faucetUrl: "https://faucet.monad.xyz",
    port: 5179,
    fundingMinimum: "0.0005",
    // Monad charges the gas limit, not the gas used.
    fundingGas: 1_500_000n,
  },
  robinhood: {
    name: "Robinhood",
    label: "Robinhood Chain Testnet",
    deployment: "robinhood-testnet.json",
    chain: robinhoodTestnet,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    faucetUrl: "https://faucet.testnet.chain.robinhood.com",
    port: 5187,
    fundingMinimum: "0.0005",
    fundingGas: 1_500_000n,
  },
} as const;

export type NetworkName = keyof typeof networks;

export function networkName(name: string): NetworkName {
  if (!Object.hasOwn(networks, name))
    throw new Error(`Unsupported test network: ${name}`);
  return name as NetworkName;
}

export function networkNamed(name: string = defaultNetwork) {
  return networks[networkName(name)];
}

// Anvil is for local development and tests only. It uses the Ethereum implementation.
const anvil = {
  id: "ethereum",
  label: "Anvil (local test)",
  chain: foundry,
  fundingMinimum: "0.0005",
  fundingGas: 1_500_000n,
} as const;

/** The network for a deployment's chain ID: its implementation ID, display label, chain, and funding. */
export function networkFor(chainId: number) {
  if (chainId === anvil.chain.id) return anvil;
  const entry = Object.entries(networks).find(
    ([, network]) => network.chain.id === chainId,
  );
  if (!entry) throw new Error(`Unsupported test chain: ${chainId}`);
  const [id, network] = entry;
  return {
    id: id as NetworkName,
    label: network.label,
    chain: network.chain,
    fundingMinimum: network.fundingMinimum,
    fundingGas: network.fundingGas,
  };
}

export function evmChain(chainId: number) {
  return networkFor(chainId).chain;
}
