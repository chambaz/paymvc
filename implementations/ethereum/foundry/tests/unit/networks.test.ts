import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultNetwork,
  networkForLocation,
  evmChain,
  networkFor,
  networkNamed,
  networks,
} from "../../src/networks";
import { selectedNetwork } from "../../scripts/network";
import { deploymentKey, parseDeployment } from "../../src/chain/config";

it("only selects explicit test networks", () => {
  expect(networkNamed().chain.id).toBe(networks[defaultNetwork].chain.id);
  expect(networkNamed("base").chain.id).toBe(84532);
  expect(networkNamed("monad").chain.id).toBe(10143);
  expect(networkNamed("robinhood").chain.id).toBe(46630);
  for (const name of ["mainnet", "toString", "__proto__", ""]) {
    expect(() => networkNamed(name)).toThrow("Unsupported test network");
  }
  for (const id of [1, 8453, 143, 4663, 0]) {
    expect(() => evmChain(id)).toThrow("Unsupported test chain");
  }
});

it("labels each chain and maps it to its implementation", () => {
  expect(networkFor(31337)).toMatchObject({
    id: "ethereum",
    label: "Anvil (local test)",
  });
  expect(networkFor(11155111)).toMatchObject({
    id: "ethereum",
    label: "Sepolia",
  });
  expect(networkFor(84532)).toMatchObject({
    id: "base",
    label: "Base Sepolia",
    fundingMinimum: "0.00005",
  });
  expect(networkFor(10143).id).toBe("monad");
  expect(networkFor(46630).id).toBe("robinhood");
});

it("keeps sessions isolated even when contract addresses match across networks", () => {
  const keys = [11155111, 84532, 10143, 46630, 31337].map((chainId) => {
    const config = parseDeployment({
      chainId,
      rpcUrl: "https://example.com",
      address: `0x${"1".repeat(40)}`,
      token: `0x${"2".repeat(40)}`,
      codeHash: `0x${"3".repeat(64)}`,
      deploymentBlock: "1",
      faucetUrl: "https://example.com/faucet",
    });
    expect(evmChain(config.chainId).id).toBe(chainId);
    return deploymentKey(config);
  });
  expect(new Set(keys).size).toBe(5);
});

it("rejects missing, duplicate, and unknown CLI selections", () => {
  expect(selectedNetwork(["--network", "base"], "ethereum")).toBe("base");
  expect(selectedNetwork(["--network=robinhood"])).toBe("robinhood");
  expect(selectedNetwork([], "monad")).toBe("monad");
  for (const args of [
    ["--network"],
    ["--network="],
    ["--network", "--local"],
    ["--network=base", "--network=monad"],
    ["--network", "mainnet"],
  ]) {
    expect(() => selectedNetwork(args)).toThrow();
  }
});

it("names the same RPC endpoints in foundry.toml for forge script", () => {
  const toml = readFileSync("foundry.toml", "utf8");
  for (const [name, network] of Object.entries(networks))
    expect(toml).toContain(`${name} = "${network.rpcUrl}"`);
});

describe("networkForLocation", () => {
  const at = (hostname: string, search = "") => ({ hostname, search });
  it("reads the network from a subdomain", () => {
    expect(networkForLocation(at("base.paymvc.com")).name).toBe("Base");
    expect(networkForLocation(at("robinhood.paymvc.com")).name).toBe(
      "Robinhood",
    );
  });
  it("prefers ?network= over the subdomain", () => {
    expect(
      networkForLocation(at("base.paymvc.com", "?network=monad")).name,
    ).toBe("Monad");
  });
  it("falls back to the build default on other hosts", () => {
    expect(networkForLocation(at("127.0.0.1")).name).toBe("Ethereum");
    expect(
      networkForLocation(at("evm-production.up.railway.app"), "base").name,
    ).toBe("Base");
  });
  it("rejects an unknown ?network=", () => {
    expect(() => networkForLocation(at("paymvc.com", "?network=foo"))).toThrow(
      "Unsupported test network",
    );
  });
});
