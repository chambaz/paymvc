import { z } from "zod";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress, keccak256, toHex, type Hex } from "viem";
import { deploymentKey, type Deployment } from "./config";

const hex = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value),
);
const key = hex.refine((value) => value.length === 66);
const intentSchema = z.object({
  action: z.enum(["send", "request", "approve", "decline"]),
  recipient: z.string().refine(isAddress),
  amount: z.string().regex(/^\d+$/),
  // The entry that approve or decline resolves: "from:operation". Empty for a new entry.
  id: z.string().regex(/^(0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{64})?$/),
  operation: key,
});
const sessionSchema = z.object({
  version: z.literal(2),
  deployment: z.string(),
  key,
  ready: z.boolean(),
  journal: z.record(
    z.string(),
    z.object({
      raw: hex,
      hash: key,
      confirmed: z.boolean(),
      // Hashes of earlier versions with the same nonce and lower fees. Any one can be mined.
      earlier: z.array(key).optional(),
    }),
  ),
  intent: intentSchema.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
export type Intent = z.infer<typeof intentSchema>;
export function parseAmount(input: string) {
  if (!/^[1-9]\d{0,6}$/.test(input) || BigInt(input) > 1_000_000n) {
    throw new Error("Enter a whole amount from 1 to 1,000,000.");
  }
  return BigInt(input);
}
export function newSession(config: Deployment): Session {
  return {
    version: 2,
    deployment: deploymentKey(config),
    key: generatePrivateKey(),
    ready: false,
    journal: {},
    intent: null,
  };
}
export function accountFor(session: Session) {
  return privateKeyToAccount(session.key);
}
export function saveSession(session: Session, storage: Storage = localStorage) {
  storage.setItem(session.deployment, JSON.stringify(session));
}
export function loadSession(
  config: Deployment,
  storage: Storage = localStorage,
): Session | null {
  let raw: string | null;
  try {
    raw = storage.getItem(deploymentKey(config));
  } catch {
    throw new Error(
      "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
    );
  }
  if (!raw) return null;
  try {
    const session = sessionSchema.parse(JSON.parse(raw));
    if (session.deployment !== deploymentKey(config)) throw new Error();
    accountFor(session);
    for (const record of Object.values(session.journal)) {
      if (keccak256(record.raw) !== record.hash) throw new Error();
    }
    return session;
  } catch {
    // Parser/crypto errors can include input data. Never expose stored key material in UI errors.
    throw new Error(
      "This saved demo is unreadable or incompatible. Reset it to create a new session.",
    );
  }
}
/** A random 32-byte operation ID. Live tests pass a label to make it repeatable. */
export function operationId(label?: string): Hex {
  return label
    ? keccak256(toHex(label))
    : toHex(crypto.getRandomValues(new Uint8Array(32)));
}
export function validateOperation(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value))
    throw new Error("Use a nonzero 32-byte operation ID.");
}
