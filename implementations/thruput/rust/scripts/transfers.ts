/**
 * Test-only transfers for the live scenarios: native-token funding from the
 * deployer key, and the credits transfer outside PayMVC. The app never funds
 * wallets or moves credits outside PayMVC.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { addressFromBase58, gasAmount } from "@thruputchain/client";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import type { Deployment } from "../src/chain/config";
import { ERC20 } from "../src/chain/generated/credits";
import { verifyDeployment } from "../src/chain/payments";
import { newSession, type Session } from "../src/chain/session";
import { transact } from "../src/chain/transactions";

/** Native-token base units for each user: 20 native tokens, twice the app's 10-token budget. */
const USER_FUNDING = 200_000_000n;

/** Write a private file atomically, readable only by its owner. */
export function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * Load the funder's session from `path`, or create it from the deploy
 * script's private CLI key. The funder keeps its own journal.
 */
export function funderSession(
  c: Deployment,
  network: "local" | "futurenet",
  path: string,
): Session {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  // The first 32 bytes of the CLI keypair are the Ed25519 seed.
  const { keypair_hex } = JSON.parse(
    readFileSync(
      `.local/${network}-cli/thruput/keys/${network}-deployer.json`,
      "utf8",
    ),
  );
  const s = { ...newSession(c), key: `0x${keypair_hex.slice(0, 64)}` };
  save(path, s);
  return s;
}

/** Send `address` its native tokens and return the transaction hash. */
export async function fund(
  c: Deployment,
  funder: Session,
  address: string,
  persist: () => void,
) {
  const label = `fund:${address}`;
  await transact(
    c,
    funder,
    persist,
    () => {},
    label,
    await verifyDeployment(c),
    [
      ERC20.v0_1.transfer.invocation(
        NATIVE_TOKEN_ADDRESS,
        gasAmount(1_000_000n),
        { receiver: addressFromBase58(address), amount: USER_FUNDING },
      ),
    ],
    async () => false, // Never replace a funding transfer.
  );
  return funder.journal[label]!.hash;
}

/** Transfer credits directly on the token, outside PayMVC, and return the transaction hash. */
export async function transferCredits(
  c: Deployment,
  s: Session,
  to: string,
  amount: bigint,
  persist: () => void,
) {
  const label = `external:${amount}`;
  await transact(
    c,
    s,
    persist,
    () => {},
    label,
    await verifyDeployment(c),
    [
      ERC20.v0_1.transfer.invocation(
        addressFromBase58(c.credits),
        gasAmount(1_000_000n),
        { receiver: addressFromBase58(to), amount },
      ),
    ],
    async () => false, // Never replace the transfer.
  );
  return s.journal[label]!.hash;
}
