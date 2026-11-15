import { expect, it } from "vitest";
import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { isAddress } from "../../src/chain/session";

const account = Keypair.random().publicKey();
const contract = StrKey.encodeContract(Buffer.alloc(32, 7));

it("accepts account and contract addresses only", () => {
  expect(isAddress(account)).toBe(true);
  expect(isAddress(contract)).toBe(true);
  for (const value of [
    "",
    Keypair.random().secret(),
    account.slice(0, -1),
    contract.toLowerCase(),
    StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1)),
  ])
    expect(isAddress(value)).toBe(false);
});

it("builds contract arguments for both address kinds", () => {
  for (const [value, kind] of [
    [account, "scAddressTypeAccount"],
    [contract, "scAddressTypeContract"],
  ]) {
    const scVal = new Address(value!).toScVal();
    expect(Address.fromScVal(scVal).toString()).toBe(value);
    expect(new Address(value!).toScAddress().type).toBe(kind);
  }
});
