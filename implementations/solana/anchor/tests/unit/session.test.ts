import { describe, expect, it } from "vitest";
import { parseDeployment } from "../../src/chain/config";
import {
  accountFor,
  loadSession,
  newSession,
  operationId,
  parseAmount,
  saveSession,
  signerFor,
} from "../../src/chain/session";

const config = parseDeployment({
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  program: "C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
function storage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
    key: (i) => [...data.keys()][i] ?? null,
  };
}
describe("session boundaries", () => {
  it("accepts the full devnet identity and rejects other networks", () => {
    expect(parseDeployment(config).network).toBe("devnet");
    for (const genesisHash of [
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]) {
      expect(() => parseDeployment({ ...config, genesisHash })).toThrow();
    }
  });
  it("persists one identity before any transaction", async () => {
    const s = await newSession(config);
    const store = storage();
    saveSession(s, store);
    const restored = loadSession(config, store)!;
    expect(restored.key.address).toBe(s.key.address);
    expect(restored.journal).toEqual({});
    expect((await signerFor(restored)).address).toBe(accountFor(s).address);
  });
  it("does not expose invalid signing material in errors", async () => {
    const s = await newSession(config);
    s.key.address = (await newSession(config)).key.address;
    await expect(signerFor(s)).rejects.toThrow("unreadable");
    const store = storage();
    store.setItem(s.deployment, "SECRET INVALID DATA");
    expect(() => loadSession(config, store)).toThrow(
      "This saved demo is unreadable or incompatible.",
    );
  });
  it("rejects missing storage before broadcast", async () => {
    const store = storage();
    store.setItem = () => {
      throw new Error("quota");
    };
    expect(() => saveSession({} as never, store)).toThrow(
      "Browser storage is unavailable",
    );
  });
  it("reports blocked storage separately from an unreadable session", () => {
    const store = storage();
    store.getItem = () => {
      throw new Error("SecurityError");
    };
    expect(() => loadSession(config, store)).toThrow(
      "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
    );
  });
  it("uses exact bounded integer amounts", () => {
    for (const invalid of [
      "0",
      "01",
      "1.5",
      "-1",
      "1e3",
      "1000001",
      "9007199254740993",
    ])
      expect(() => parseAmount(invalid)).toThrow();
    expect(parseAmount("1000000")).toBe(1_000_000n);
  });
  it("rejects corrupted signed transaction evidence without exposing it", async () => {
    const saved = await newSession(config);
    saved.journal.test = {
      raw: "INVALID",
      hash: "INVALID",
      lastValidBlockHeight: "10",
      confirmed: false,
    };
    const store = storage();
    saveSession(saved, store);
    expect(() => loadSession(config, store)).toThrow(
      "This saved demo is unreadable or incompatible.",
    );
  });
  it("keeps new operations distinct", () => {
    expect(operationId()).not.toBe(operationId());
  });
});
