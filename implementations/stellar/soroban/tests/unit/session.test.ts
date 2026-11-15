import { expect, it } from "vitest";
import {
  Account,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import deployment from "../../public/deployment.json";
import { parseDeployment } from "../../src/chain/config";
import {
  parseAmount,
  validateOperation,
  operationId,
  newSession,
  saveSession,
  loadSession,
  signerFor,
} from "../../src/chain/session";

it("accepts exact whole credits only", () => {
  for (const input of ["0", "-1", "1.5", "01", "1000001", "1e2"])
    expect(() => parseAmount(input)).toThrow();
  expect(parseAmount("1000000")).toBe(1_000_000n);
});

function fixture() {
  const config = parseDeployment(deployment);
  const session = newSession(config);
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return { config, session, storage };
}

it("reload restores one identity and stays bound to the deployment", () => {
  const { config, session, storage } = fixture();
  saveSession(session, storage);
  expect(loadSession(config, storage)).toEqual(session);
  expect(
    loadSession({ ...config, codeHash: "0".repeat(64) }, storage),
  ).toBeNull();
});

it("restores a request intent from a contract address", () => {
  const { config, session, storage } = fixture();
  const requester = StrKey.encodeContract(Buffer.alloc(32, 3));
  const operation = operationId();
  session.intent = {
    action: "approve",
    recipient: requester,
    amount: "5",
    id: `${requester}:${operation}`,
    operation: operationId(),
  };
  saveSession(session, storage);
  expect(loadSession(config, storage)).toEqual(session);
});

it("reports blocked storage separately from an unreadable session", () => {
  const { config, session, storage } = fixture();
  const blocked = {
    ...storage,
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  expect(() => loadSession(config, blocked)).toThrow(
    "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
  );
  expect(() => saveSession(session, blocked)).toThrow(
    "Browser storage is unavailable",
  );
});

it("rejects an invalid saved key", () => {
  const { config, session, storage } = fixture();
  session.key = "invalid";
  saveSession(session, storage);
  expect(() => loadSession(config, storage)).toThrow("unreadable");
});

it("rejects altered signed evidence", () => {
  const { config, session, storage } = fixture();
  const signer = signerFor(session);
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: config.passphrase,
  })
    .addOperation(Operation.manageData({ name: "test", value: "x" }))
    .setTimebounds(0, 200)
    .build();
  tx.sign(signer);
  session.journal.test = {
    raw: tx.toXDR(),
    hash: Buffer.from(tx.hash()).toString("hex"),
    confirmed: false,
    preparedLedger: 10,
  };
  saveSession(session, storage);
  expect(loadSession(config, storage)?.journal).toEqual(session.journal);
  session.journal.test.hash = "0".repeat(64);
  saveSession(session, storage);
  expect(() => loadSession(config, storage)).toThrow("unreadable");
});
it("reserves zero operation IDs and creates distinct operations", () => {
  expect(() => validateOperation("0".repeat(64))).toThrow();
  expect(operationId()).not.toBe(operationId());
  expect(() => validateOperation(operationId())).not.toThrow();
});
it("rejects a saved intent with an invalid amount, operation, or request ID", () => {
  const { config, session, storage } = fixture();
  const requester = StrKey.encodeContract(Buffer.alloc(32, 3));
  const valid = {
    action: "approve" as const,
    recipient: requester,
    amount: "5",
    id: `${requester}:${operationId()}`,
    operation: operationId(),
  };
  for (const intent of [
    { ...valid, amount: "0" },
    { ...valid, amount: "1000001" },
    { ...valid, operation: "0".repeat(64) },
    { ...valid, id: `${requester}:${"0".repeat(64)}` },
    { ...valid, id: `${requester}:${operationId()}:extra` },
    {
      ...valid,
      id: `${StrKey.encodeContract(Buffer.alloc(32, 4))}:${operationId()}`,
    },
  ]) {
    session.intent = intent;
    saveSession(session, storage);
    expect(() => loadSession(config, storage)).toThrow("unreadable");
  }
});
