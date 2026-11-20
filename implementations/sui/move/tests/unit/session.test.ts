import { describe, expect, it } from "vitest";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  accountFor,
  entryId,
  loadSession,
  newSession,
  operationId,
  parseAmount,
  saveSession,
  validateOperation,
} from "../../src/chain/session";
import { deploymentKey, type Deployment } from "../../src/chain/config";

const config: Deployment = {
  network: "testnet",
  rpcUrl: "https://fullnode.testnet.sui.io:443",
  chainIdentifier: "test",
  package: normalizeSuiAddress("1"),
  app: normalizeSuiAddress("2"),
  packageDigest: "test",
  immutableDigest: "publish",
  faucetUrl: "https://faucet.sui.io/",
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
}
describe("single-wallet sessions", () => {
  it("round-trips one identity under its deployment", () => {
    const s = newSession(config);
    const store = storage();
    saveSession(s, store);
    expect(accountFor(loadSession(config, store)!)).toEqual(accountFor(s));
    expect(
      loadSession({ ...config, app: normalizeSuiAddress("3") }, store),
    ).toBeNull();
    expect(accountFor(newSession(config))).not.toEqual(accountFor(s));
  });
  it("rejects an unreadable key", () => {
    const s = newSession(config);
    s.key = "invalid";
    const store = storage();
    saveSession(s, store);
    expect(() => loadSession(config, store)).toThrow("unreadable");
  });
  it("rejects a substituted deployment", () => {
    const s = newSession(config);
    s.deployment = "other";
    const store = storage();
    store.setItem(deploymentKey(config), JSON.stringify(s));
    expect(() => loadSession(config, store)).toThrow("incompatible");
  });
  it.each([
    { amount: "1000001", operation: "1".repeat(64) },
    { amount: "1", operation: "0".repeat(64) },
    { amount: "1", operation: "1".repeat(64), id: "0" },
  ])("rejects a saved intent with invalid fields %o", (fields) => {
    const s = newSession(config);
    s.intent = {
      action: "send",
      recipient: normalizeSuiAddress("4"),
      id: "",
      ...fields,
    };
    const store = storage();
    saveSession(s, store);
    expect(() => loadSession(config, store)).toThrow("incompatible");
  });
  it("stops when durable storage fails", () => {
    const store = {
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(() => saveSession(newSession(config), store)).toThrow("storage");
  });
  it("reports blocked storage when reading a session", () => {
    const store = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;
    expect(() => loadSession(config, store)).toThrow(
      "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
    );
  });
  it("reports blocked storage when localStorage itself is inaccessible", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: blocked,
    });
    try {
      expect(() => loadSession(config)).toThrow("No wallet was created.");
      expect(() => saveSession(newSession(config))).toThrow(
        "Browser storage is unavailable.",
      );
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
  it("uses exact integer credit amounts", () => {
    expect(parseAmount("1000000")).toBe(1000000n);
  });
  it.each(["0", "-1", "1.5", "1e3", "01", "1000001", " 2", "NaN"])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => parseAmount(amount)).toThrow();
    },
  );
  it("uses nonzero 32-byte operation identifiers", () => {
    expect(() => validateOperation(operationId())).not.toThrow();
    expect(() => validateOperation("0".repeat(64))).toThrow();
    expect(() => validateOperation("f".repeat(32))).toThrow();
    expect(() => validateOperation("f".repeat(66))).toThrow();
  });
  it("names a saved request by its entry key", () => {
    const s = newSession(config);
    s.intent = {
      action: "approve",
      recipient: normalizeSuiAddress("4"),
      amount: "1",
      id: entryId(normalizeSuiAddress("4"), "1".repeat(64)),
      operation: operationId(),
    };
    const store = storage();
    saveSession(s, store);
    expect(loadSession(config, store)?.intent).toEqual(s.intent);
  });
});
