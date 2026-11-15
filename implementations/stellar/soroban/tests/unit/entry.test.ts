import { expect, it } from "vitest";
import {
  Address,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { parseEntry } from "../../src/chain/payments";

const from = Keypair.random().publicKey();
const to = Keypair.random().publicKey();
const operation = Buffer.alloc(32, 9);
// The XDR that contracts/paymvc returns for an Entry. A unit enum variant is a
// vector that holds its name as a symbol.
const entry = (kind: string, state: string) =>
  xdr.ScVal.scvMap(
    [
      ["amount", nativeToScVal(12n, { type: "i128" })],
      ["from", new Address(from).toScVal()],
      ["kind", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)])],
      ["operation", nativeToScVal(operation, { type: "bytes" })],
      ["state", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(state)])],
      ["to", new Address(to).toScVal()],
    ].map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key as string),
          val: val as xdr.ScVal,
        }),
    ),
  );

it("decodes an entry and keys it by (from, operation)", () => {
  expect(parseEntry(scValToNative(entry("Request", "Paid")))).toEqual({
    from,
    to,
    operation: operation.toString("hex"),
    amount: 12n,
    kind: "Request",
    state: "Paid",
    id: `${from}:${operation.toString("hex")}`,
  });
});

it("rejects unknown kinds and states", () => {
  expect(() => parseEntry(scValToNative(entry("Refund", "Paid")))).toThrow();
  expect(() =>
    parseEntry(scValToNative(entry("Request", "Expired"))),
  ).toThrow();
});
