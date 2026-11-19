import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Transaction } from "@mysten/sui/transactions";
import { canonicalScenario, type User } from "../conformance/scenario";
import {
  parseDeployment,
  deploymentKey,
  coinType,
  server,
} from "../../src/chain/config";
import {
  accountFor,
  newSession,
  loadSession,
  type Session,
} from "../../src/chain/session";
import { payments, paymentCoin } from "../../src/chain/payments";
import { transact } from "../../src/chain/transactions";
import { writeEvidence, type Viewport } from "../../scripts/evidence";

const live = process.env.LIVE === "1";
const config = () =>
  parseDeployment(
    JSON.parse(
      readFileSync(
        live ? "public/deployment.json" : "public/local.json",
        "utf8",
      ),
    ),
  );
function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function fund(address: string) {
  if (!live) {
    await requestSuiFromFaucetV2({
      host: "http://127.0.0.1:9123",
      recipient: address,
    });
    return;
  }
  // The deployment wallet funds browser users. Only its journal is saved.
  const c = config();
  const path = `.local/browser-funder-${c.network}-${c.app}.json`;
  const s: Session = {
    version: 2,
    deployment: deploymentKey(c),
    key: JSON.parse(readFileSync(".local/testnet-deployer.json", "utf8"))
      .privateKey,
    ready: true,
    intent: null,
    journal: existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")).journal
      : {},
  };
  await transact(
    c,
    s,
    `fund:${address}`,
    async () => {
      const tx = new Transaction();
      tx.transferObjects(
        [tx.splitCoins(tx.gas, [tx.pure.u64(130_000_000)])[0]],
        tx.pure.address(address),
      );
      return tx;
    },
    () => save(path, { journal: s.journal }),
  );
}
async function create(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const address = await page.getByTestId("funding-address").innerText();
  await fund(address);
  return address;
}
async function start(page: Page) {
  const address = await create(page);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  return address;
}
async function form(
  page: Page,
  action: "Send" | "Request",
  recipient: string,
  amount: string,
) {
  await page.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Recipient address")).toHaveValue("");
  await dialog.getByLabel("Recipient address").fill(recipient);
  await dialog.getByLabel("Amount", { exact: true }).fill(amount);
  await dialog
    .getByRole("button", {
      name: action === "Send" ? "Send credits" : "Create request",
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
}
test("canonical independent-user scenario, external transfer, reload, and reset", async ({
  browser,
}, info) => {
  const c = config();
  const a = await browser.newContext({ viewport: info.project.use.viewport });
  const b = await browser.newContext({ viewport: info.project.use.viewport });
  // The app removes saved transactions after it verifies them, so the test
  // collects each transaction hash when the app saves it.
  const seen = new Set<string>();
  const saved: Record<User, string[]> = { a: [], b: [] };
  for (const [user, context] of [
    ["a", a],
    ["b", b],
  ] as const) {
    await context.exposeFunction("saveHashes", (hashes: string[]) => {
      for (const hash of hashes)
        if (!seen.has(hash)) {
          seen.add(hash);
          saved[user].push(hash);
        }
    });
    await context.addInitScript((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        setItem.call(this, name, value);
        if (this !== localStorage || name !== key) return;
        const journal = JSON.parse(value).journal as Record<
          string,
          { hash: string }
        >;
        void (
          window as unknown as { saveHashes(hashes: string[]): Promise<void> }
        ).saveHashes(Object.values(journal).map((entry) => entry.hash));
      };
    }, deploymentKey(c));
  }
  const pages = { a: await a.newPage(), b: await b.newPage() };
  const addresses: Record<User, string> = { a: "", b: "" };
  // Transaction hashes in scenario order.
  const transactions: { step: string; hash: string }[] = [];
  let requested = "";
  function record(user: User, step: string) {
    for (const hash of saved[user].splice(0)) transactions.push({ step, hash });
  }
  try {
    await canonicalScenario({
      start: async (user) => {
        addresses[user] = await start(pages[user]);
        record(user, `register-${user}`);
      },
      payment: async (user, action, amount) => {
        await form(
          pages[user],
          action,
          addresses[user === "a" ? "b" : "a"],
          amount,
        );
        if (action === "Request") requested = amount;
        record(user, `${action.toLowerCase()}${amount}`);
      },
      resolve: async (user, action) => {
        const page = pages[user];
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.getByRole("button", { name: action, exact: true }).click();
        await expect(
          page.getByRole("button", { name: action, exact: true }),
        ).toHaveCount(0);
        record(user, `${action.toLowerCase()}${requested}`);
      },
      expectState: async (user, balance, count) => {
        const page = pages[user];
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await expect(page.getByTestId("balance")).toHaveText(balance);
        await expect(page.getByTestId("activity-row")).toHaveCount(count);
      },
      reload: async (user) => {
        await pages[user].reload();
        await expect(pages[user].getByTestId("balance")).toBeVisible();
      },
      externalTransfer: async () => {
        const raw = await pages.b.evaluate(
          (key) => localStorage.getItem(key)!,
          deploymentKey(c),
        );
        const s = loadSession(c, { getItem: () => raw } as unknown as Storage)!;
        const path = `.local/browser-external-${info.project.name}.json`;
        await transact(
          c,
          s,
          "external:3",
          async () => {
            const tx = new Transaction();
            tx.transferObjects(
              [await paymentCoin(c, tx, accountFor(s).address, 3n)],
              tx.pure.address(addresses.a),
            );
            return tx;
          },
          () => save(path, s),
        );
        await pages.b.evaluate(
          ({ key, raw }) => localStorage.setItem(key, raw),
          { key: deploymentKey(c), raw: JSON.stringify(s) },
        );
        record("b", "external3");
      },
      reset: async (user) => {
        await pages[user]
          .getByRole("button", { name: "Reset Demo", exact: true })
          .click();
        await pages[user]
          .getByRole("button", { name: "Reset and remove wallet" })
          .click();
        await pages[user]
          .getByRole("button", { name: "Create demo wallet", exact: true })
          .click();
        await expect(pages[user].getByTestId("funding-address")).not.toHaveText(
          addresses[user],
        );
      },
    });
    expect(transactions.map((entry) => entry.step)).toEqual([
      "register-a",
      "register-b",
      "send7",
      "request20",
      "approve20",
      "request5",
      "decline5",
      "request9",
      "approve9",
      "external3",
    ]);
    writeEvidence(
      c,
      !live,
      {
        result: "passed",
        balances: { a: "85", b: "115" },
        activity: { a: 4, b: 4 },
        transactions,
      },
      info.project.name as Viewport,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("native address-balance credits remain spendable", async () => {
  test.skip(live, "Additional fixtures use the local faucet.");
  const c = config();
  const a = newSession(c),
    b = newSession(c);
  const owner = accountFor(a).address;
  for (const s of [a, b]) {
    await fund(accountFor(s).address);
    await payments(
      c,
      s,
      () => save(`.local/address-balance-${accountFor(s).address}.json`, s),
      () => {},
    ).setup();
  }
  const persist = () => save(".local/address-balance-payment.json", a);
  await transact(
    c,
    a,
    "deposit",
    async () => {
      const tx = new Transaction();
      tx.moveCall({
        target: "0x2::coin::send_funds",
        typeArguments: [coinType(c)],
        arguments: [
          await paymentCoin(c, tx, owner, 100n),
          tx.pure.address(owner),
        ],
      });
      return tx;
    },
    persist,
  );
  expect(
    (await server(c).getBalance({ owner, coinType: coinType(c) })).balance
      .addressBalance,
  ).toBe("100");
  await payments(c, a, persist, () => {}).execute({
    action: "send",
    recipient: accountFor(b).address,
    amount: "7",
    id: "",
    operation: "1".repeat(64),
  });
  expect(
    (await server(c).getBalance({ owner, coinType: coinType(c) })).balance
      .balance,
  ).toBe("93");
});

test("directory pages, contact entry, and accessible light/dark layout", async ({
  page,
}) => {
  test.skip(live, "Additional fixture registrations use the local faucet.");
  const c = config();
  for (let i = 0; i < 7; i++) {
    const s = newSession(c);
    await fund(accountFor(s).address);
    const path = `.local/contact-${i}.json`;
    await payments(
      c,
      s,
      () => save(path, s),
      () => {},
    ).setup();
  }
  const owner = await start(page);
  const directory = page.getByRole("region", { name: "Your contacts" });
  const contacts = directory.getByRole("button", { name: /^Send to / });
  await expect(contacts).toHaveCount(5);
  await directory.getByRole("button", { name: "Load more contacts" }).click();
  await expect.poll(() => contacts.count()).toBeGreaterThan(5);
  const values = await contacts.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("title")),
  );
  expect(values).not.toContain(owner);
  expect(new Set(values).size).toBe(values.length);
  await contacts.last().click();
  await expect(page.getByLabel("Recipient address")).toHaveValue(
    values.at(-1)!,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Dark mode" }).click();
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("registration retains signed evidence after unavailable broadcast", async ({
  page,
}) => {
  test.skip(live, "Failure injection is local only.");
  const c = config();
  await create(page);
  let blocked = true;
  await page.route(
    "**/sui.rpc.v2.TransactionExecutionService/ExecuteTransaction",
    async (route) => {
      if (blocked) await route.abort();
      else await route.continue();
    },
  );
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const hash = await page.evaluate(
    (key) =>
      Object.values(
        JSON.parse(localStorage.getItem(key)!).journal as Record<
          string,
          { hash: string }
        >,
      )[0]!.hash,
    deploymentKey(c),
  );
  await page.reload();
  blocked = false;
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(
    await page.evaluate(
      (key) =>
        Object.values(
          JSON.parse(localStorage.getItem(key)!).journal as Record<
            string,
            { hash: string }
          >,
        )[0]!.hash,
      deploymentKey(c),
    ),
  ).toBe(hash);
});

test("lost registration acknowledgement reconciles saved evidence", async ({
  page,
}) => {
  test.skip(live, "Failure injection is local only.");
  const c = config();
  await create(page);
  let broadcasts = 0;
  await page.route(
    "**/sui.rpc.v2.TransactionExecutionService/ExecuteTransaction",
    async (route) => {
      broadcasts++;
      await route.fetch();
      await route.abort();
    },
  );
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(broadcasts).toBe(1);
  expect(
    await page.evaluate((key) => {
      const records = Object.values(
        JSON.parse(localStorage.getItem(key)!).journal,
      ) as { confirmed: boolean }[];
      return (
        records.length === 1 && records.every((record) => record.confirmed)
      );
    }, deploymentKey(c)),
  ).toBe(true);
});

test("second tab cannot write", async ({ page, context }) => {
  test.skip(live, "Local development server check.");
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(
    second.getByText("Read-only tab", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await second.close();
});

test("a check that fails before signing keeps the form editable", async ({
  browser,
  page,
}) => {
  test.skip(live, "Runs on the local network only.");
  const other = await browser.newContext();
  const recipient = await start(await other.newPage());
  await start(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Recipient address").fill(recipient);
  await dialog.getByLabel("Amount", { exact: true }).fill("101");
  await dialog
    .getByRole("button", { name: "Send credits", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Not enough demo credits",
  );
  await expect(dialog.getByLabel("Amount", { exact: true })).toHaveValue("101");
  // Nothing was signed, so the form stays editable and the next attempt succeeds.
  await dialog.getByLabel("Amount", { exact: true }).fill("7");
  await dialog
    .getByRole("button", { name: "Send credits", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await other.close();
});

test("storage failure stops before funding", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  await expect(
    page.getByText(
      "Browser storage is unavailable. Enable storage before continuing.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("funding-address")).not.toBeVisible();
});
