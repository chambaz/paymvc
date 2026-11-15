import { describe, it, expect } from "vitest";
import { deploymentKey, normalizeAddress } from "../../src/chain/config";
import {
  newSession,
  accountFor,
  parseAmount,
  saveSession,
  loadSession,
} from "../../src/chain/session";

import { config } from "./fixture";
describe("disposable sessions", () => {
  it("restores one identity and isolates deployments and network resets", () => {
    const session = newSession(config);
    const storage = { getItem: () => JSON.stringify(session) };
    expect(accountFor(loadSession(config, storage)!)).toEqual(
      accountFor(session),
    );
    expect(accountFor(newSession(config))).not.toEqual(accountFor(session));
    expect(session.journal).toEqual({});
    expect(session.ready).toBe(false);
    expect(deploymentKey({ ...config, networkHash: config.address })).not.toBe(
      session.deployment,
    );
    expect(() =>
      loadSession({ ...config, address: config.contractHash }, storage),
    ).toThrow("unreadable");
  });
  it("rejects corrupt storage and reports save failures", () => {
    expect(() => loadSession(config, { getItem: () => "{" })).toThrow(
      "unreadable",
    );
    expect(() =>
      saveSession(newSession(config), {
        setItem() {
          throw new Error();
        },
      } as unknown as Storage),
    ).toThrow("storage");
  });
  it("reports blocked storage separately from corrupt data", () => {
    expect(() =>
      loadSession(config, {
        getItem() {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).toThrow(
      "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
    );
  });
  it("accepts only exact whole bounded payment amounts", () => {
    expect(parseAmount("1000000")).toBe(1_000_000n);
    for (const value of [
      "0",
      "-1",
      "1.5",
      "01",
      "1e3",
      " 1",
      "1000001",
      "9007199254740993",
    ])
      expect(() => parseAmount(value)).toThrow();
  });
  it("validates complete case-sensitive base58 addresses", () => {
    expect(normalizeAddress(config.address)).toBe(config.address);
    for (const value of ["", "0x1234", "111", "abc…xyz"])
      expect(() => normalizeAddress(value)).toThrow();
  });
});
