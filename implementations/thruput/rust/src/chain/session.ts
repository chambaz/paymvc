import {
  createPubkeyAccount,
  Ed25519Signer,
  fromHex0x,
  toHex0x,
  toBase58,
  createSubmissionEvidence,
  hashFromBase58,
} from "@thruputchain/client";
import { deserializeSignedTransaction } from "@thruputchain/client/transaction";
import { z } from "zod";
import { deploymentKey, normalizeAddress, type Deployment } from "./config";

const intentSchema = z.object({
  action: z.enum(["send", "request", "approve", "decline"]),
  recipient: z.string(),
  amount: z.string(),
  /** The request's row ID `<from>:<operation>` for approve and decline; empty otherwise. */
  id: z.string().regex(/^$|^[1-9A-HJ-NP-Za-km-z]+:0x[0-9a-f]{64}$/),
  operation: z.string().regex(/^0x[0-9a-f]{64}$/),
});
const recordSchema = z.object({
  raw: z.string().regex(/^0x[0-9a-f]+$/),
  hash: z.string(),
  confirmed: z.boolean(),
  /** The commitment height, saved as soon as the chain reports it. */
  blockHeight: z.string().regex(/^\d+$/).optional(),
});
const schema = z.object({
  version: z.literal(4),
  deployment: z.string(),
  key: z.string().regex(/^0x[0-9a-f]{64}$/),
  ready: z.boolean(),
  /** The highest block with a confirmed transaction from this wallet. Later reads wait for it. */
  stateHeight: z.string().regex(/^\d+$/),
  intent: intentSchema.nullable(),
  /** One saved transaction per operation: "registration" or "<operation>:<action>". */
  journal: z.record(z.string(), recordSchema),
});
export type Session = z.infer<typeof schema>;
export type Intent = z.infer<typeof intentSchema>;
export function parseAmount(input: string) {
  if (!/^[1-9]\d{0,6}$/.test(input) || BigInt(input) > 1_000_000n)
    throw new Error("Enter a whole amount from 1 to 1,000,000.");
  return BigInt(input);
}
export const operationId = () =>
  toHex0x(crypto.getRandomValues(new Uint8Array(32)));
/** A new 32-byte Ed25519 seed. It is the wallet's private key. */
const randomSeed = () => toHex0x(crypto.getRandomValues(new Uint8Array(32)));
export const signerFor = (s: Session) =>
  createPubkeyAccount({ signer: Ed25519Signer.fromSeed(fromHex0x(s.key)) });
export const accountFor = (s: Session) => ({
  address: toBase58(signerFor(s).address),
});
export function newSession(c: Deployment): Session {
  return {
    version: 4,
    deployment: deploymentKey(c),
    key: randomSeed(),
    ready: false,
    stateHeight: "0",
    intent: null,
    journal: {},
  };
}
export function saveSession(s: Session, storage: Storage = localStorage) {
  try {
    storage.setItem(s.deployment, JSON.stringify(s));
  } catch {
    throw new Error(
      "Browser storage is unavailable. Enable storage before continuing.",
    );
  }
}
export function loadSession(
  c: Deployment,
  storage: Pick<Storage, "getItem"> = localStorage,
): Session | null {
  let raw: string | null;
  try {
    raw = storage.getItem(deploymentKey(c));
  } catch {
    throw new Error(
      "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
    );
  }
  if (!raw) return null;
  try {
    const s = schema.parse(JSON.parse(raw));
    if (s.deployment !== deploymentKey(c)) throw new Error();
    const owner = accountFor(s).address;
    if (s.intent) {
      parseAmount(s.intent.amount);
      normalizeAddress(s.intent.recipient);
    }
    for (const record of Object.values(s.journal)) {
      const bytes = fromHex0x(record.raw);
      const evidence = createSubmissionEvidence(
        bytes,
        hashFromBase58(c.networkHash),
      );
      const signed = deserializeSignedTransaction(bytes);
      if (
        toBase58(evidence.transactionHash) !== record.hash ||
        toBase58(signed.tx.invocation.invoked_address) !== owner
      )
        throw new Error();
    }
    return s;
  } catch {
    throw new Error(
      "This saved demo is unreadable or incompatible. Reset it to create a new session.",
    );
  }
}
export const confirmedHeight = (s: Session) => BigInt(s.stateHeight);
