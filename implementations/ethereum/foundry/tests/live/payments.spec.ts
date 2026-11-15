import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { network } from "../../scripts/network";
import { liveDirectory } from "../../scripts/live-directory";
import {
  config,
  fund,
  local,
  saveSession,
  scenarioBudget,
  target,
} from "../../scripts/live-target";
import {
  writeEvidence,
  type Step,
  type Viewport,
} from "../../scripts/evidence";
import { deploymentKey } from "../../src/chain/config";
import { accountFor, type Session } from "../../src/chain/session";
import { transact } from "../../src/chain/transactions";
import { canonicalScenario, type User } from "../conformance/scenario";

const privatePath = join(liveDirectory, "canonical-browser");
mkdirSync(privatePath, { recursive: true, mode: 0o700 });

test("public canonical scenario, external balance, reload, and reset", async ({
  browser,
  viewport,
  baseURL,
}, info) => {
  if (!baseURL) throw new Error("Live browser base URL is required.");
  const contexts = {
    a: await browser.newContext({ viewport }),
    b: await browser.newContext({ viewport }),
  };
  const pages = {
    a: await contexts.a.newPage(),
    b: await contexts.b.newPage(),
  };
  const addresses = {} as Record<User, Address>;
  const observed = {} as Record<User, { balance: string; count: number }>;
  const steps: Step[] = [];
  let requested = "";
  const session = async (user: User): Promise<Session> =>
    pages[user].evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      deploymentKey(config),
    );
  // The app deletes verified transactions from its journal, so each page's broadcasts give the
  // hashes. Only the public hash is kept.
  const broadcasts: Record<User, Hex[]> = { a: [], b: [] };
  for (const user of ["a", "b"] as const)
    pages[user].on("request", (request) => {
      const body: unknown = request.postDataJSON?.();
      for (const call of [body].flat() as { method?: string; params?: Hex[] }[])
        if (call?.method === "eth_sendRawTransaction" && call.params?.[0])
          broadcasts[user].push(keccak256(call.params[0]));
    });
  const record = (user: User, step: string) => {
    for (const hash of broadcasts[user].splice(0))
      if (!steps.some((saved) => saved.hash === hash))
        steps.push({ step: `${user} ${step}`, hash });
  };
  // Keep each browser wallet's journal so that an interrupted run can be reconciled.
  const keep = async (user: User) => {
    const saved = await session(user).catch(() => null);
    if (saved)
      saveSession(
        join(privatePath, `session-${accountFor(saved).address}.json`),
        saved,
      );
  };
  const refresh = async (user: User) => {
    await pages[user]
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
  };
  try {
    if (process.env.LIVE_RPC_URL && !local) {
      for (const context of Object.values(contexts)) {
        await context.route(`**/deployments/${network.deployment}`, (route) =>
          route.fulfill({ json: config }),
        );
      }
    }
    await canonicalScenario({
      start: async (user) => {
        await pages[user].goto(baseURL);
        await pages[user]
          .getByRole("button", { name: "Create demo wallet", exact: true })
          .click();
        const address = await pages[user]
          .getByTestId("funding-address")
          .innerText();
        if (!isAddress(address)) throw new Error("Invalid fixture address.");
        addresses[user] = address;
        await fund(address, await scenarioBudget(address));
        // Act like a user: start once the app itself sees the funding.
        const page = pages[user];
        const startDemo = page.getByRole("button", {
          name: "Start demo",
          exact: true,
        });
        await expect(page.getByText(/^Funding received/)).toBeVisible({
          timeout: 120_000,
        });
        await startDemo.click();
        // Public RPCs can lag behind the funding block. Recover once, with the app's own
        // controls: they reuse the saved transaction and never sign a new one.
        const balance = page.getByTestId("balance");
        const problem = page.getByText(
          /^(Outcome unknown|A step needs attention)$/,
        );
        await expect(balance.or(problem).first()).toBeVisible();
        if (await problem.isVisible()) {
          await page.waitForTimeout(10_000);
          const recheck = page.getByRole("button", {
            name: "Recheck original operation",
            exact: true,
          });
          await ((await recheck.isVisible()) ? recheck : startDemo).click();
        }
        await expect(balance).toHaveText("100");
        record(user, "register");
      },
      payment: async (user, action, amount) => {
        const page = pages[user];
        await page.getByRole("button", { name: action, exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByLabel("Recipient address")).toHaveValue("");
        await dialog
          .getByLabel("Recipient address")
          .fill(addresses[user === "a" ? "b" : "a"]);
        await dialog.getByLabel("Amount", { exact: true }).fill(amount);
        await dialog
          .getByRole("button", {
            name: action === "Send" ? "Send credits" : "Create request",
            exact: true,
          })
          .click();
        await expect(dialog).not.toBeVisible();
        if (action === "Request") requested = amount;
        record(user, `${action.toLowerCase()} ${amount}`);
      },
      resolve: async (user, action) => {
        await refresh(user);
        await pages[user]
          .getByRole("button", { name: action, exact: true })
          .click();
        await expect(
          pages[user].getByRole("button", { name: action, exact: true }),
        ).toHaveCount(0);
        record(user, `${action.toLowerCase()} ${requested}`);
      },
      expectState: async (user, balance, count) => {
        await refresh(user);
        await expect(pages[user].getByTestId("balance")).toHaveText(balance);
        await expect(pages[user].getByTestId("activity-row")).toHaveCount(
          count,
        );
        observed[user] = { balance, count };
      },
      reload: async (user) => {
        await pages[user].reload();
      },
      externalTransfer: async () => {
        const saved = await session("b");
        const receipt = await transact(
          config,
          saved,
          () =>
            saveSession(
              join(privatePath, `external-${addresses.b}.json`),
              saved,
            ),
          () => {},
          "external:3",
          config.token,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [addresses.a, 3n],
          }),
        );
        steps.push({
          step: "b external transfer 3",
          hash: receipt.transactionHash,
        });
      },
      reset: async (user) => {
        await keep(user);
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
          addresses[user],
        );
      },
    });
    writeEvidence(
      target,
      {
        balances: { a: observed.a.balance, b: observed.b.balance },
        activity: { a: observed.a.count, b: observed.b.count },
        transactions: steps,
      },
      info.project.name as Viewport,
    );
  } finally {
    await keep("a");
    await keep("b");
    await contexts.a.close();
    await contexts.b.close();
  }
});
