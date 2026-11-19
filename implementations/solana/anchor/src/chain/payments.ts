import {
  address,
  getAddressDecoder,
  getBase16Encoder,
  getBase64Encoder,
  getU32Decoder,
  getU64Encoder,
  isSome,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  fetchToken,
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchProfile,
  fetchMaybeProfile,
  fetchMaybeEntry,
  fetchEntry,
  fetchAllActivity,
  fetchAllEntry,
  fetchDirectory,
  fetchAllMember,
  getApproveInstructionAsync,
  getDeclineInstructionAsync,
  getRegisterInstructionAsync,
  getRequestInstructionAsync,
  getSendInstructionAsync,
  getActivitySize,
  getEntrySize,
  getMemberSize,
  getProfileSize,
  Kind,
  State,
} from "./generated";
import { addressBytes, pda, rpc, type Deployment } from "./config";
import {
  accountFor,
  parseIntent,
  signerFor,
  type Intent,
  type Session,
} from "./session";
import {
  transact,
  ResultPending,
  RevertedTransaction,
  type Progress,
} from "./transactions";

const commitment = "confirmed" as const;
/** Activity records per activity account: `ACTIVITY_PAGE` in programs/paymvc/src/state.rs. */
export const ACTIVITY_PAGE = 32n;
const UPGRADEABLE_LOADER = address(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Deployments that passed verification in this page. The program cannot change. */
const verified = new Set<string>();

/**
 * Checks the network, that the program is immutable (no upgrade authority), and the demo
 * mint. A program with an upgrade authority could change under existing sessions.
 */
export async function verifyDeployment(c: Deployment) {
  if (verified.has(c.program)) return;
  const client = rpc(c);
  if ((await client.getGenesisHash().send()) !== c.genesisHash)
    throw new Error(
      "This RPC belongs to a different network. Check deployment configuration.",
    );
  const [program, mint] = await Promise.all([
    client.getAccountInfo(c.program, { encoding: "base64", commitment }).send(),
    fetchMint(client, await pda(c, "mint"), { commitment }),
  ]);
  const fail = () =>
    new Error(
      "Deployment verification failed. Check the program and demo mint.",
    );
  if (!program.value?.executable || program.value.owner !== UPGRADEABLE_LOADER)
    throw fail();
  // A loader-v3 program account holds `Program { programdata_address }`.
  const programBytes = getBase64Encoder().encode(program.value.data[0]);
  if (getU32Decoder().decode(programBytes) !== 2) throw fail();
  const programData = getAddressDecoder().decode(programBytes, 4);
  const data = await client
    .getAccountInfo(programData, { encoding: "base64", commitment })
    .send();
  // `ProgramData { slot, upgrade_authority_address: Option<Pubkey> }`: byte 12 is the option
  // tag. `solana program deploy --final` stores None. A local validator's "none" stores the
  // all-zero key, which nobody can sign for. Both mean that the program cannot change.
  const dataBytes = data.value
    ? getBase64Encoder().encode(data.value.data[0])
    : undefined;
  const frozen =
    dataBytes?.[12] === 0 ||
    (dataBytes?.[12] === 1 && dataBytes.slice(13, 45).every((byte) => !byte));
  if (
    !dataBytes ||
    data.value?.owner !== UPGRADEABLE_LOADER ||
    getU32Decoder().decode(dataBytes) !== 3 ||
    !frozen
  )
    throw fail();
  if (
    mint.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    mint.data.decimals !== 0 ||
    !isSome(mint.data.mintAuthority) ||
    mint.data.mintAuthority.value !== (await pda(c, "authority")) ||
    isSome(mint.data.freezeAuthority)
  )
    throw fail();
  verified.add(c.program);
}
export const profileAddress = (c: Deployment, owner: Address) =>
  pda(c, "profile", addressBytes.encode(owner));
export const entryAddress = (
  c: Deployment,
  owner: Address,
  operation: string,
) =>
  pda(
    c,
    "entry",
    addressBytes.encode(owner),
    getBase16Encoder().encode(operation),
  );
/** The activity account that holds record `index` of `owner`. */
export const activityAddress = (c: Deployment, owner: Address, index: bigint) =>
  pda(
    c,
    "activity",
    addressBytes.encode(owner),
    getU64Encoder().encode(index / ACTIVITY_PAGE),
  );
export async function tokenAddress(c: Deployment, owner: Address) {
  return (
    await findAssociatedTokenPda({
      owner,
      mint: await pda(c, "mint"),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
}
function verifyOwner(c: Deployment, account: { programAddress: Address }) {
  if (account.programAddress !== c.program)
    throw new Error(
      "Unexpected account owner. Check the deployment configuration.",
    );
}
export class FundingRequired extends Error {
  constructor(
    public address: Address,
    public required: bigint,
  ) {
    super(
      "Fund the saved wallet address with devnet SOL, then retry Start demo.",
    );
  }
}
export async function fundingBudget(c: Deployment, visitor: Address) {
  const client = rpc(c);
  const rent = (size: number) =>
    client.getMinimumBalanceForRentExemption(BigInt(size)).send();
  const [profile, token, member, entry, activity] = await Promise.all([
    rent(getProfileSize()),
    rent(getTokenSize()),
    rent(getMemberSize()),
    rent(getEntrySize()),
    rent(getActivitySize()),
  ]);
  // Registration, then eight payments: one entry each, and the first activity account of
  // this wallet and of one contact. Plus fees.
  const estimate =
    profile + token + member + 8n * entry + 2n * activity + 5_000_000n;
  const required = estimate > 50_000_000n ? estimate : 50_000_000n;
  const { value: balance } = await client
    .getBalance(visitor, { commitment })
    .send();
  return { balance, required };
}

/** A read that the RPC could not answer at the needed slot yet. */
const pending = (): never => {
  throw new ResultPending();
};

export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: Progress,
) {
  const client = rpc(c);
  const program = { programAddress: c.program };
  /** Fails before signing when the wallet cannot pay the fee and the new accounts' rent. */
  async function requireLamports(owner: Address, sizes: number[]) {
    const [{ value: balance }, ...rents] = await Promise.all([
      client.getBalance(owner, { commitment }).send(),
      ...sizes.map((size) =>
        client.getMinimumBalanceForRentExemption(BigInt(size)).send(),
      ),
    ]);
    const fee = 10_000n;
    if (balance < rents.reduce((sum, rent) => sum + rent, fee))
      throw new Error(
        "This wallet needs more devnet SOL for fees and account rent. Fund its address, then retry.",
      );
  }
  /** Creates `owner`'s credit account if it was closed, so that it can receive credits. */
  async function tokenAccountFor(payer: TransactionSigner, owner: Address) {
    const ata = await tokenAddress(c, owner);
    const exists = (
      await client
        .getAccountInfo(ata, { encoding: "base64", commitment })
        .send()
    ).value;
    const instructions: Instruction[] = exists
      ? []
      : [
          getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata,
            owner,
            mint: await pda(c, "mint"),
          }),
        ];
    return { instructions, size: exists ? 0 : getTokenSize() };
  }

  async function execute(intent: Intent) {
    const { amount } = parseIntent(intent);
    await verifyDeployment(c);
    const actor = accountFor(s).address;
    const signer = await signerFor(s);
    if (intent.action === "send" || intent.action === "request") {
      const recipient = address(intent.recipient);
      if (actor === recipient)
        throw new Error("Choose someone other than yourself.");
      const id = await entryAddress(c, actor, intent.operation);
      const kind = intent.action === "send" ? Kind.Transfer : Kind.Request;
      const verify = (account: Awaited<ReturnType<typeof fetchEntry>>) => {
        verifyOwner(c, account);
        if (
          account.data.from !== actor ||
          account.data.to !== recipient ||
          account.data.amount !== amount ||
          account.data.kind !== kind
        )
          throw new Error(
            "The saved operation does not match its on-chain record.",
          );
      };
      const read = (minContextSlot?: bigint) =>
        fetchMaybeEntry(client, id, { commitment, minContextSlot });
      const previous = await read();
      if (previous.exists) {
        verify(previous);
        // Reconcile the original signature even when state already exists.
        if (s.journal[intent.operation])
          await transact(
            c,
            s,
            persist,
            progress,
            intent.operation,
            async () => [],
          );
        return;
      }
      let slot: bigint;
      try {
        slot = await transact(
          c,
          s,
          persist,
          progress,
          intent.operation,
          async () => {
            const [fromProfile, toProfile] = await Promise.all([
              fetchProfile(client, await profileAddress(c, actor), {
                commitment,
              }),
              fetchMaybeProfile(client, await profileAddress(c, recipient), {
                commitment,
              }),
            ]);
            if (!toProfile.exists)
              throw new Error("Choose a registered PayMVC account.");
            verifyOwner(c, fromProfile);
            verifyOwner(c, toProfile);
            const counts = [
              fromProfile.data.activityCount,
              toProfile.data.activityCount,
            ];
            // An activity account is created with the first record of each page.
            const sizes = [
              getEntrySize(),
              ...counts
                .filter((count) => count % ACTIVITY_PAGE === 0n)
                .map(() => getActivitySize()),
            ];
            const fromActivity = await activityAddress(c, actor, counts[0]!);
            const toActivity = await activityAddress(c, recipient, counts[1]!);
            const operation = getBase16Encoder().encode(intent.operation);
            if (kind === Kind.Request) {
              await requireLamports(actor, sizes);
              return [
                await getRequestInstructionAsync(
                  {
                    from: signer,
                    fromActivity,
                    payerActivity: toActivity,
                    payer: recipient,
                    amount,
                    operation,
                  },
                  program,
                ),
              ];
            }
            const token = await fetchToken(
              client,
              await tokenAddress(c, actor),
              { commitment },
            );
            if (token.data.amount < amount)
              throw new Error(
                "Not enough demo credits. No payment was completed.",
              );
            const receiver = await tokenAccountFor(signer, recipient);
            await requireLamports(actor, [
              ...sizes,
              ...(receiver.size ? [receiver.size] : []),
            ]);
            return [
              ...receiver.instructions,
              await getSendInstructionAsync(
                {
                  from: signer,
                  fromActivity,
                  toActivity,
                  to: recipient,
                  amount,
                  operation,
                },
                program,
              ),
            ];
          },
        );
      } catch (error) {
        // A new attempt can land after an earlier one that a lagging RPC did not show.
        // It then fails because the entry exists. Read the entry from that slot on.
        if (!(error instanceof RevertedTransaction) || !error.slot) throw error;
        const landed = await read(error.slot);
        if (!landed.exists) throw error;
        verify(landed);
        return;
      }
      // A node behind the confirmation slot refuses the read. Recheck it later.
      const result = await read(slot).catch(pending);
      if (!result.exists) throw new ResultPending();
      verify(result);
    } else {
      const id = address(intent.id);
      const read = (minContextSlot?: bigint) =>
        fetchEntry(client, id, { commitment, minContextSlot });
      const entry = await read();
      verifyOwner(c, entry);
      if (entry.data.from !== intent.recipient || entry.data.amount !== amount)
        throw new Error(
          "The saved operation does not match its on-chain record.",
        );
      if (entry.data.to !== actor || entry.data.kind !== Kind.Request)
        throw new Error("Only the intended payer can resolve a request.");
      const approve = intent.action === "approve";
      const expected = approve ? State.Paid : State.Declined;
      if (entry.data.state !== State.Pending && entry.data.state !== expected)
        throw new Error(
          "This request has already been resolved. Refresh its status.",
        );
      let slot: bigint | undefined;
      if (s.journal[intent.operation] || entry.data.state === State.Pending) {
        try {
          slot = await transact(
            c,
            s,
            persist,
            progress,
            intent.operation,
            async () => {
              // The entry address is derived from (from, operation). Decline needs no token accounts.
              const input = {
                payer: signer,
                from: entry.data.from,
                operation: entry.data.operation,
              };
              if (!approve) {
                await requireLamports(actor, []);
                return [await getDeclineInstructionAsync(input, program)];
              }
              const token = await fetchToken(
                client,
                await tokenAddress(c, actor),
                { commitment },
              );
              if (token.data.amount < entry.data.amount)
                throw new Error(
                  "Not enough demo credits. No payment was completed.",
                );
              const receiver = await tokenAccountFor(signer, entry.data.from);
              await requireLamports(
                actor,
                receiver.size ? [receiver.size] : [],
              );
              return [
                ...receiver.instructions,
                await getApproveInstructionAsync(input, program),
              ];
            },
          );
        } catch (error) {
          // As for a payment: an earlier attempt may have resolved the request already.
          if (!(error instanceof RevertedTransaction) || !error.slot)
            throw error;
          if ((await read(error.slot)).data.state !== expected) throw error;
          return;
        }
      }
      const resolved = await read(slot).catch(pending);
      if (resolved.data.state !== expected) throw new ResultPending();
    }
  }

  async function setup() {
    progress("Checking deployment and testnet funding");
    await verifyDeployment(c);
    const visitor = accountFor(s).address;
    const budget = await fundingBudget(c, visitor);
    if (!Object.keys(s.journal).length && budget.balance < budget.required)
      throw new FundingRequired(visitor, budget.required);
    const owner = await signerFor(s);
    const saved = await fetchMaybeProfile(
      client,
      await profileAddress(c, owner.address),
      { commitment },
    );
    if (saved.exists) {
      verifyOwner(c, saved);
    }
    let slot: bigint | undefined;
    if (!saved.exists || s.journal.register)
      slot = await transact(
        c,
        s,
        persist,
        (status) => progress(`Registering your wallet — ${status}`),
        "register",
        async () => {
          const directory = await fetchDirectory(
            client,
            await pda(c, "directory"),
            { commitment },
          );
          verifyOwner(c, directory);
          return [
            await getRegisterInstructionAsync(
              {
                owner,
                member: await pda(
                  c,
                  "member",
                  getU64Encoder().encode(directory.data.count),
                ),
              },
              { programAddress: c.program },
            ),
          ];
        },
      );
    const registered = await fetchMaybeProfile(
      client,
      await profileAddress(c, owner.address),
      { commitment, minContextSlot: slot },
    ).catch(pending);
    if (!registered.exists) throw new ResultPending();
    verifyOwner(c, registered);
    if (registered.data.owner !== visitor)
      throw new Error("The registered wallet does not match this session.");
    s.ready = true;
    persist();
    progress("");
  }
  return { setup, execute };
}

export async function readContacts(c: Deployment, s: Session, offset: bigint) {
  const client = rpc(c);
  const directory = await fetchDirectory(client, await pda(c, "directory"), {
    commitment,
  });
  verifyOwner(c, directory);
  const remaining =
    directory.data.count > offset ? directory.data.count - offset : 0n;
  const size = Number(remaining > 6n ? 6n : remaining);
  const keys = await Promise.all(
    Array.from({ length: size }, (_, index) =>
      pda(c, "member", getU64Encoder().encode(offset + BigInt(index))),
    ),
  );
  const members = size
    ? await fetchAllMember(client, keys, { commitment })
    : [];
  const addresses: Address[] = [];
  let next = offset;
  for (const member of members) {
    verifyOwner(c, member);
    next++;
    if (member.data.owner !== accountFor(s).address)
      addresses.push(member.data.owner);
    if (addresses.length === 5) break;
  }
  return { addresses, next: next < directory.data.count ? next : undefined };
}

/** The verified credit balance and activity count of a registered owner. */
export async function readAccount(c: Deployment, owner: Address) {
  const client = rpc(c);
  const [profile, token] = await Promise.all([
    fetchProfile(client, await profileAddress(c, owner), { commitment }),
    fetchToken(client, await tokenAddress(c, owner), { commitment }),
  ]);
  verifyOwner(c, profile);
  if (
    token.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    token.data.owner !== owner ||
    token.data.mint !== (await pda(c, "mint"))
  )
    throw new Error("Token account verification failed.");
  return { balance: token.data.amount, count: profile.data.activityCount };
}

export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const visitor = accountFor(s).address;
  const { balance, count } = await readAccount(c, visitor);
  // Read pages with an absolute cursor: each page holds the records with index < `before`.
  // A record that lands between reads gets a new, higher index, so it never shifts a later page.
  const entries: Awaited<ReturnType<typeof readActivity>> = [];
  let before = count;
  while (before > 0n && entries.length < limit) {
    const page = await readActivity(
      c,
      visitor,
      before,
      Math.min(50, limit - entries.length),
    );
    entries.push(...page);
    before -= BigInt(page.length);
  }
  return {
    balance,
    count,
    entries: entries.map((a) => {
      verifyOwner(c, a);
      if (a.data.from !== visitor && a.data.to !== visitor)
        throw new Error("Activity participant verification failed.");
      return {
        id: a.address,
        from: a.data.from,
        to: a.data.to,
        amount: a.data.amount,
        kind: a.data.kind,
        state: a.data.state,
      };
    }),
  };
}

/** The entries of `owner` with activity index < `before`, newest first. At most 50 per read. */
export async function readActivity(
  c: Deployment,
  owner: Address,
  before: bigint,
  limit: number,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Read from 1 to 50 activity records at a time.");
  const client = rpc(c);
  const size = before < BigInt(limit) ? Number(before) : limit;
  if (!size) return [];
  const indexes = Array.from(
    { length: size },
    (_, i) => before - 1n - BigInt(i),
  );
  // Consecutive records share an activity account, so read each account once.
  const pages = [...new Set(indexes.map((index) => index / ACTIVITY_PAGE))];
  const accounts = await fetchAllActivity(
    client,
    await Promise.all(
      pages.map((page) => activityAddress(c, owner, page * ACTIVITY_PAGE)),
    ),
    { commitment },
  );
  accounts.forEach((account) => verifyOwner(c, account));
  const byPage = new Map(pages.map((page, i) => [page, accounts[i]!]));
  return fetchAllEntry(
    client,
    indexes.map(
      (index) =>
        byPage.get(index / ACTIVITY_PAGE)!.data.entries[
          Number(index % ACTIVITY_PAGE)
        ]!,
    ),
    { commitment },
  );
}
