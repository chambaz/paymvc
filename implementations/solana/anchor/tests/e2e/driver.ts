import { expect, type Page } from "@playwright/test";
import {
  address,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signature,
  type Address,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import {
  deploymentKey,
  pda,
  rpc,
  type Deployment,
} from "../../src/chain/config";
import { signerFor, type Session } from "../../src/chain/session";
import { transact } from "../../src/chain/transactions";
import { tokenAddress } from "../../src/chain/payments";
import type { ScenarioDriver, User } from "../conformance/scenario";

/** Funds a displayed wallet address before Start demo. */
export type Fund = (owner: Address) => Promise<void>;

export async function create(page: Page, fund: Fund) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const owner = address(await page.getByTestId("funding-address").innerText());
  await fund(owner);
  return owner;
}
export async function start(page: Page, fund: Fund) {
  const owner = await create(page, fund);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
  return owner;
}
export async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
}
export async function select(page: Page, recipient: string) {
  await page.getByLabel("Recipient address", { exact: true }).fill(recipient);
}
export async function form(
  page: Page,
  action: "Send" | "Request",
  recipient: string,
  amount: string,
) {
  await refresh(page);
  await page
    .getByRole("button", {
      name: action === "Send" ? "Request" : "Send",
      exact: true,
    })
    .click();
  await select(page, recipient);
  await page.getByLabel("Amount", { exact: true }).fill(amount);
  await page.getByRole("radio", { name: action, exact: true }).click();
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue(recipient);
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue(amount);
  await page
    .getByRole("button", {
      name: action === "Send" ? "Send credits" : "Create request",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}

/**
 * Drive the canonical scenario through two browser sessions. `transactions`
 * lists each successful signature in scenario order. The signatures come from
 * the transactions that each page broadcasts; nothing is saved.
 */
export function browserScenario(
  c: Deployment,
  pages: Record<User, Page>,
  fund: Fund,
) {
  const owners: Partial<Record<User, Address>> = {};
  const transactions: { step: string; hash: string }[] = [];
  const sent: Record<User, Set<string>> = { a: new Set(), b: new Set() };
  for (const user of ["a", "b"] as const)
    pages[user].on("request", (request) => {
      if (
        request.url() !== new URL(c.rpcUrl).href ||
        request.method() !== "POST"
      )
        return;
      const body = request.postDataJSON();
      if (body?.method !== "sendTransaction") return;
      const bytes = getBase64Encoder().encode(body.params[0]);
      sent[user].add(
        getSignatureFromTransaction(getTransactionDecoder().decode(bytes)),
      );
    });
  const other = (user: User) => (user === "a" ? "b" : "a");
  let requested = "";
  /** Record the signatures `user` broadcast in this step that landed without error. */
  async function record(user: User, step: string) {
    const hashes = [...sent[user]];
    sent[user].clear();
    if (!hashes.length) return;
    const { value } = await rpc(c)
      .getSignatureStatuses(
        hashes.map((hash) => signature(hash)),
        {
          searchTransactionHistory: true,
        },
      )
      .send();
    hashes.forEach((hash, index) => {
      const status = value[index];
      if (status && !status.err)
        transactions.push({ step: `${user}:${step}`, hash });
    });
  }
  const driver: ScenarioDriver = {
    start: async (user) => {
      owners[user] = await start(pages[user], fund);
      await record(user, "register");
    },
    payment: async (user, action, amount) => {
      await form(pages[user], action, owners[other(user)]!, amount);
      if (action === "Request") {
        requested = amount;
        await expect(
          pages[user].getByRole("button", { name: "Approve", exact: true }),
        ).toHaveCount(0);
      }
      await record(user, `${action.toLowerCase()} ${amount}`);
    },
    resolve: async (user, action) => {
      await refresh(pages[user]);
      await pages[user]
        .getByRole("button", { name: action, exact: true })
        .click();
      await expect(
        pages[user].getByRole("button", { name: action, exact: true }),
      ).toHaveCount(0);
      await record(user, `${action.toLowerCase()} ${requested}`);
    },
    expectState: async (user, balance, count) => {
      await refresh(pages[user]);
      await expect(pages[user].getByTestId("balance")).toHaveText(balance);
      await expect(pages[user].getByTestId("activity-row")).toHaveCount(count);
    },
    reload: async (user) => {
      await pages[user].reload();
    },
    externalTransfer: async () => {
      const s: Session = await pages.b.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        deploymentKey(c),
      );
      await transact(
        c,
        s,
        () => {},
        () => {},
        "external",
        async () => [
          getTransferCheckedInstruction({
            source: await tokenAddress(c, owners.b!),
            destination: await tokenAddress(c, owners.a!),
            mint: await pda(c, "mint"),
            authority: await signerFor(s),
            amount: 3n,
            decimals: 0,
          }),
        ],
      );
      transactions.push({
        step: "b:external transfer 3",
        hash: s.journal.external!.hash,
      });
    },
    reset: async (user) => {
      await pages[user]
        .getByRole("button", { name: "Reset Demo", exact: true })
        .click();
      await pages[user]
        .getByRole("button", { name: "Reset and remove wallet", exact: true })
        .click();
      await pages[user]
        .getByRole("button", { name: "Create demo wallet", exact: true })
        .click();
      await expect(pages[user].getByTestId("funding-address")).not.toHaveText(
        owners[user]!,
      );
    },
  };
  return { driver, owners, transactions };
}
