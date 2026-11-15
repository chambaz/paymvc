import {
  Keypair,
  StrKey,
  TransactionBuilder,
  Transaction,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { z } from "zod";
import { deploymentKey, type Deployment } from "./config";

// Accounts (G…) and contracts (C…) can both register, pay, and request.
export const isAddress = (value: string) =>
  StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
// A whole number of credits from 1 to 1,000,000.
const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .refine((value) => BigInt(value) <= 1_000_000n);
// A nonzero 32-byte operation ID, as hex. The contract reserves zero.
const operationSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .refine((value) => !/^0+$/.test(value));
const intentSchema = z
  .object({
    action: z.enum(["send", "request", "approve", "decline"]),
    recipient: z.string().refine(isAddress),
    amount: amountSchema,
    id: z.string(),
    operation: operationSchema,
  })
  // A request ID is `from:operation`. To resolve it, the requester `from` is the recipient.
  .refine(
    ({ action, recipient, id }) =>
      (action !== "approve" && action !== "decline") ||
      (id.startsWith(`${recipient}:`) &&
        operationSchema.safeParse(id.slice(recipient.length + 1)).success),
  );
const schema = z.object({
  version: z.literal(2),
  deployment: z.string(),
  key: z.string().refine(StrKey.isValidEd25519SecretSeed),
  ready: z.boolean(),
  intent: intentSchema.nullable(),
  journal: z.record(
    z.string(),
    z.object({
      raw: z.string(),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      preparedLedger: z.number().int().nonnegative(),
      confirmed: z.boolean(),
    }),
  ),
});
export type Session = z.infer<typeof schema>;
export type Intent = z.infer<typeof intentSchema>;
export function parseAmount(input: string) {
  if (!amountSchema.safeParse(input).success)
    throw new Error("Enter a whole amount from 1 to 1,000,000.");
  return BigInt(input);
}
export function validateOperation(value: string) {
  if (!operationSchema.safeParse(value).success)
    throw new Error("Use a nonzero 32-byte operation ID.");
}
export function newSession(c: Deployment): Session {
  return {
    version: 2,
    deployment: deploymentKey(c),
    key: Keypair.fromRawEd25519Seed(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    ).secret(),
    ready: false,
    intent: null,
    journal: {},
  };
}
// Decoding a secret derives its public key. Decode each key once.
const signers = new Map<string, Keypair>();
export function signerFor(s: Session) {
  let signer = signers.get(s.key);
  if (!signer) {
    signer = Keypair.fromSecret(s.key);
    signers.set(s.key, signer);
  }
  return signer;
}
export const accountFor = (s: Session) => ({
  address: signerFor(s).publicKey(),
});
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
  storage: Storage = localStorage,
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
    for (const record of Object.values(s.journal)) {
      const tx = TransactionBuilder.fromXDR(record.raw, c.passphrase);
      if (
        !(tx instanceof Transaction) ||
        Buffer.from(tx.hash()).toString("hex") !== record.hash ||
        accountFor(s).address !== tx.source ||
        !tx.timeBounds ||
        Number(tx.timeBounds.maxTime) <= 0 ||
        !tx.signatures.some(({ signature }) =>
          signerFor(s).verify(tx.hash(), signature.value),
        )
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
export const operationId = (label?: string) =>
  Buffer.from(
    label
      ? new TextEncoder().encode(label.padEnd(32, "\0"))
      : crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex");
