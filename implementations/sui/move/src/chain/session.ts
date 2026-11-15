import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, toHex, isValidSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { deploymentKey, type Deployment } from "./config";

const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .refine((value) => BigInt(value) <= 1_000_000n);
const operationSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .refine((value) => !/^0+$/.test(value));
const intentSchema = z.object({
  action: z.enum(["send", "request", "approve", "decline"]),
  recipient: z.string().refine(isValidSuiAddress),
  amount: amountSchema,
  // The request to resolve, as `entryId(from, operation)`. Empty for send and request.
  id: z.string().regex(/^(0x[0-9a-f]{64}:[0-9a-f]{64})?$/),
  operation: operationSchema,
});
const schema = z.object({
  version: z.literal(2),
  deployment: z.string(),
  key: z.string(),
  ready: z.boolean(),
  intent: intentSchema.nullable(),
  journal: z.record(
    z.string(),
    z.object({
      raw: z.string(),
      signature: z.string(),
      hash: z.string(),
      epoch: z.string().regex(/^\d+$/),
      checkpoint: z.string().regex(/^\d+$/),
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
export const operationId = () =>
  toHex(crypto.getRandomValues(new Uint8Array(32)));
/** The stable ID of an entry: its key `(from, operation)`. */
export const entryId = (from: string, operation: string) =>
  `${from}:${operation}`;
export function newSession(c: Deployment): Session {
  return {
    version: 2,
    deployment: deploymentKey(c),
    key: Ed25519Keypair.generate().getSecretKey(),
    ready: false,
    intent: null,
    journal: {},
  };
}
export const signerFor = (s: Session) => Ed25519Keypair.fromSecretKey(s.key);
export const accountFor = (s: Session) => ({
  address: signerFor(s).toSuiAddress(),
});
// Reading `localStorage` itself throws when storage is blocked, so resolve it inside each try.
export function saveSession(s: Session, storage?: Storage) {
  try {
    (storage ?? localStorage).setItem(s.deployment, JSON.stringify(s));
  } catch {
    throw new Error(
      "Browser storage is unavailable. Enable storage before continuing.",
    );
  }
}
export function loadSession(c: Deployment, storage?: Storage): Session | null {
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(deploymentKey(c));
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
    for (const record of Object.values(s.journal)) {
      const bytes = fromBase64(record.raw);
      const data = Transaction.from(bytes).getData();
      if (
        data.sender !== owner ||
        TransactionDataBuilder.getDigestFromBytes(bytes) !== record.hash ||
        data.expiration?.ValidDuring?.maxEpoch !== record.epoch ||
        data.expiration.ValidDuring.chain !== c.chainIdentifier
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
