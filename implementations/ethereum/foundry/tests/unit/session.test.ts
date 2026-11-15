import { describe, expect, it } from "vitest";
import {
  parseAmount,
  newSession,
  loadSession,
  saveSession,
  accountFor,
} from "../../src/chain/session";
import { parseDeployment } from "../../src/chain/config";

const config = parseDeployment({
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  address: "0x0000000000000000000000000000000000000001",
  token: "0x0000000000000000000000000000000000000002",
  deploymentBlock: "1",
  codeHash: `0x${"0".repeat(64)}`,
  faucetUrl: "https://example.com",
});
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
describe("input boundaries", () => {
  it.each([
    "0",
    "-1",
    "1.1",
    "1e3",
    "1000001",
    "",
    " 1",
    "Infinity",
    "999999999999999999999",
  ])("rejects amount %s", (value) =>
    expect(() => parseAmount(value)).toThrow(),
  );
  it("uses exact integer amounts", () => {
    expect(parseAmount("1000000")).toBe(1_000_000n);
  });
});
describe("session persistence", () => {
  it("restores one identity and binds it to a deployment", () => {
    const storage = memoryStorage();
    const session = newSession(config);
    saveSession(session, storage);
    expect(loadSession(config, storage)).toEqual(session);
    expect(accountFor(loadSession(config, storage)!).address).toBe(
      accountFor(session).address,
    );
    expect(accountFor(newSession(config)).address).not.toBe(
      accountFor(session).address,
    );
    expect(
      loadSession(
        { ...config, address: "0x0000000000000000000000000000000000000003" },
        storage,
      ),
    ).toBeNull();
  });
  it("does not hide storage failure", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("Storage unavailable");
    };
    expect(() => saveSession(newSession(config), storage)).toThrow(
      "Storage unavailable",
    );
  });
  it("explains when browser storage is blocked", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new Error("SecurityError");
    };
    expect(() => loadSession(config, storage)).toThrow(
      "Browser storage is unavailable",
    );
  });
});
