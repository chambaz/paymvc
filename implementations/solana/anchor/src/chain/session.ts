import { z } from "zod";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
  isAddress,
} from "@solana/kit";
import { deploymentKey, type Deployment } from "./config";

/** A whole number of credits from 1 to 1,000,000. */
const amount = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .refine((value) => BigInt(value) <= 1_000_000n);
/** A nonzero 32-byte operation ID in hex. The program rejects zero. */
const operation = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .refine((value) => !/^0+$/.test(value));
const intentSchema = z.object({
  action: z.enum(["send", "request", "approve", "decline"]),
  recipient: z.string().refine(isAddress),
  amount,
  id: z.string(),
  operation,
});
const sessionSchema = z.object({
  version: z.literal(2),
  deployment: z.string(),
  key: z.object({
    seed: z.array(z.number().int().min(0).max(255)).length(32),
    address: z.string().refine(isAddress),
  }),
  ready: z.boolean(),
  intent: intentSchema.nullable(),
  journal: z.record(
    z.string(),
    z.object({
      raw: z.string(),
      hash: z.string(),
      lastValidBlockHeight: z.string().regex(/^\d+$/),
      confirmed: z.boolean(),
    }),
  ),
});
export type Session = z.infer<typeof sessionSchema>;
export type Intent = z.infer<typeof intentSchema>;
export function parseAmount(input: string) {
  if (!amount.safeParse(input).success)
    throw new Error("Enter a whole amount from 1 to 1,000,000.");
  return BigInt(input);
}
/** Check an intent before it is signed. Saved intents are checked by loadSession. */
export function parseIntent(input: Intent) {
  if (!intentSchema.safeParse(input).success)
    throw new Error("This operation is invalid. Dismiss it and try again.");
  return { ...input, amount: BigInt(input.amount) };
}
export async function newSession(c: Deployment): Promise<Session> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return {
    version: 2,
    deployment: deploymentKey(c),
    key: { seed: Array.from(seed), address: signer.address },
    ready: false,
    journal: {},
    intent: null,
  };
}
export function accountFor(s: Session) {
  return { address: address(s.key.address) };
}
export async function signerFor(s: Session) {
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(
      new Uint8Array(s.key.seed),
    );
    if (signer.address !== accountFor(s).address) throw new Error();
    return signer;
  } catch {
    throw new Error("This saved demo identity is unreadable. Reset this demo.");
  }
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
    const saved = sessionSchema.parse(JSON.parse(raw));
    if (saved.deployment !== deploymentKey(c)) throw new Error();
    for (const record of Object.values(saved.journal)) {
      const transaction = getTransactionDecoder().decode(
        getBase64Encoder().encode(record.raw),
      );
      if (getSignatureFromTransaction(transaction) !== record.hash)
        throw new Error();
    }
    return saved;
  } catch {
    throw new Error(
      "This saved demo is unreadable or incompatible. Reset it to create a new session.",
    );
  }
}
export function operationId(label?: string) {
  const bytes = label
    ? new TextEncoder().encode(label.padEnd(32, "\0"))
    : crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
