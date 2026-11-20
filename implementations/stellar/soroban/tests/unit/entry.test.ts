import { expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { parseEntry } from "../../src/chain/payments";
import { paymvcSpec } from "../../src/chain/generated/specs";

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

/** Decodes the result of `entry(from, operation)` with the contract's spec, as the app does. */
const decode = (value: xdr.ScVal) =>
  parseEntry(paymvcSpec.funcResToNative("entry", value));

it("decodes an entry and keys it by (from, operation)", () => {
  expect(decode(entry("Request", "Paid"))).toEqual({
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
  expect(() => decode(entry("Refund", "Paid"))).toThrow();
  expect(() => decode(entry("Request", "Expired"))).toThrow();
});
