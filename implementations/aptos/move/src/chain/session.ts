import {
  Account,
  Ed25519PrivateKey,
  Deserializer,
  SignedTransaction,
  SimpleTransaction,
  AccountAuthenticatorEd25519,
  generateUserTransactionHash,
  generateSigningMessageForTransaction,
  Hex,
} from "@aptos-labs/ts-sdk";
import { z } from "zod";
import { deploymentKey, type Deployment } from "./config";

// Whole credits from 1 to 1,000,000.
const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .refine((value) => BigInt(value) <= 1_000_000n);
// A nonzero 32-byte operation ID in lowercase hex.
const operationSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .refine((value) => !/^0+$/.test(value));
const intentSchema = z.object({
  action: z.enum(["send", "request", "approve", "decline"]),
  recipient: z.string().regex(/^0x[0-9a-f]{64}$/),
  amount: amountSchema,
  // The entry that the intent creates or resolves, from entryId.
  id: z.string().regex(/^0x[0-9a-f]{64}:[0-9a-f]{64}$/),
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
      hash: z.string().regex(/^0x[0-9a-f]{64}$/),
      preparedVersion: z.string().regex(/^\d+$/),
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
  Hex.fromHexInput(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toStringWithoutPrefix();
/** An entry's key `(from, operation)` as one string, for example "0xab…:01…". */
export const entryId = (from: string, operation: string) =>
  `${from}:${operation}`;
export function parseEntryId(id: string) {
  const [from = "", operation = ""] = id.split(":");
  return { from, operation };
}
export const signerFor = (s: Session) =>
  Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(s.key),
    legacy: true,
  });
export const accountFor = (s: Session) => ({
  address: signerFor(s).accountAddress.toStringLong(),
});
export function newSession(c: Deployment): Session {
  const signer = Account.generate({ legacy: true });
  return {
    version: 2,
    deployment: deploymentKey(c),
    key: signer.privateKey.toString(),
    ready: false,
    intent: null,
    journal: {},
  };
}
export function savedTransaction(raw: string) {
  const deserializer = new Deserializer(Hex.fromHexInput(raw).toUint8Array());
  const signed = SignedTransaction.deserialize(deserializer);
  if (!signed.authenticator.isEd25519())
    throw new Error("Unexpected transaction signer.");
  const transaction = new SimpleTransaction(signed.raw_txn);
  const senderAuthenticator = new AccountAuthenticatorEd25519(
    signed.authenticator.public_key,
    signed.authenticator.signature,
  );
  if (
    !signed.authenticator.public_key.verifySignature({
      message: generateSigningMessageForTransaction(transaction),
      signature: signed.authenticator.signature,
    })
  )
    throw new Error("Invalid saved transaction signature.");
  return { transaction, senderAuthenticator };
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
    const s = schema.parse(JSON.parse(raw));
    if (s.deployment !== deploymentKey(c)) throw new Error();
    const owner = accountFor(s).address;
    for (const record of Object.values(s.journal)) {
      const saved = savedTransaction(record.raw);
      if (
        saved.transaction.rawTransaction.sender.toStringLong() !== owner ||
        saved.transaction.rawTransaction.chain_id.chainId !== c.chainId ||
        generateUserTransactionHash(saved) !== record.hash
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
