import {
  address,
  getBase16Encoder,
  getU64Encoder,
  isSome,
  type Address,
} from "@solana/kit";
import {
  fetchToken,
  fetchMint,
  findAssociatedTokenPda,
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
import { transact, ResultPending, type Progress } from "./transactions";

const commitment = "confirmed" as const;
export async function verifyDeployment(c: Deployment) {
  const client = rpc(c);
  if ((await client.getGenesisHash().send()) !== c.genesisHash)
    throw new Error(
      "This RPC belongs to a different network. Check deployment configuration.",
    );
  const [program, mint] = await Promise.all([
    client.getAccountInfo(c.program, { encoding: "base64", commitment }).send(),
    fetchMint(client, await pda(c, "mint"), { commitment }),
  ]);
  if (
    !program.value?.executable ||
    mint.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    mint.data.decimals !== 0 ||
    !isSome(mint.data.mintAuthority) ||
    mint.data.mintAuthority.value !== (await pda(c, "authority")) ||
    isSome(mint.data.freezeAuthority)
  )
    throw new Error(
      "Deployment verification failed. Check the program and demo mint.",
    );
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
export const activityAddress = (c: Deployment, owner: Address, index: bigint) =>
  pda(c, "activity", addressBytes.encode(owner), getU64Encoder().encode(index));
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
  // Registration, then eight payments (one entry and two activity records each), plus fees.
  const estimate =
    profile + token + member + 8n * (entry + 2n * activity) + 5_000_000n;
  const required = estimate > 50_000_000n ? estimate : 50_000_000n;
  const { value: balance } = await client
    .getBalance(visitor, { commitment })
    .send();
  return { balance, required };
}

export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: Progress,
) {
  const client = rpc(c);
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
      const previous = await fetchMaybeEntry(client, id, { commitment });
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
      await transact(c, s, persist, progress, intent.operation, async () => {
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
        if (kind === Kind.Transfer) {
          const token = await fetchToken(client, await tokenAddress(c, actor), {
            commitment,
          });
          if (token.data.amount < amount)
            throw new Error(
              "Not enough demo credits. No payment was completed.",
            );
        }
        const operation = getBase16Encoder().encode(intent.operation);
        const fromActivity = await activityAddress(
          c,
          actor,
          fromProfile.data.activityCount,
        );
        const toActivity = await activityAddress(
          c,
          recipient,
          toProfile.data.activityCount,
        );
        const program = { programAddress: c.program };
        return [
          kind === Kind.Transfer
            ? await getSendInstructionAsync(
                {
                  from: signer,
                  fromActivity,
                  toActivity,
                  to: recipient,
                  amount,
                  operation,
                },
                program,
              )
            : await getRequestInstructionAsync(
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
      });
      const result = await fetchMaybeEntry(client, id, { commitment });
      if (!result.exists) throw new ResultPending();
      verify(result);
    } else {
      const id = address(intent.id);
      const entry = await fetchEntry(client, id, { commitment });
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
      if (s.journal[intent.operation] || entry.data.state === State.Pending) {
        await transact(c, s, persist, progress, intent.operation, async () => {
          if (
            approve &&
            (
              await fetchToken(client, await tokenAddress(c, actor), {
                commitment,
              })
            ).data.amount < entry.data.amount
          )
            throw new Error(
              "Not enough demo credits. No payment was completed.",
            );
          // The entry address is derived from (from, operation). Decline needs no token accounts.
          const input = {
            payer: signer,
            from: entry.data.from,
            operation: entry.data.operation,
          };
          const program = { programAddress: c.program };
          return [
            approve
              ? await getApproveInstructionAsync(input, program)
              : await getDeclineInstructionAsync(input, program),
          ];
        });
      }
      const resolved = await fetchEntry(client, id, { commitment });
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
    if (!saved.exists || s.journal.register)
      await transact(
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
      { commitment },
    );
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
  const indexes = await Promise.all(
    Array.from({ length: size }, (_, i) =>
      activityAddress(c, owner, before - 1n - BigInt(i)),
    ),
  );
  const activities = size
    ? await fetchAllActivity(client, indexes, { commitment })
    : [];
  activities.forEach((a) => verifyOwner(c, a));
  return size
    ? await fetchAllEntry(
        client,
        activities.map((a) => a.data.entry),
        { commitment },
      )
    : [];
}
