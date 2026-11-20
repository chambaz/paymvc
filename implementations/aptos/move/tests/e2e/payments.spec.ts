import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  failureText,
  writeEvidence,
  type Viewport,
} from "../../scripts/evidence";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { canonicalScenario, type User } from "../conformance/scenario";
import { parseDeployment, server, deploymentKey } from "../../src/chain/config";
import {
  accountFor,
  newSession,
  loadSession,
  type Session,
} from "../../src/chain/session";
import {
  payments,
  buildCall,
  MAX_GAS_AMOUNT,
  readDashboard,
  readEntry,
  operationBytes,
} from "../../src/chain/payments";
import { transact, RevertedTransaction } from "../../src/chain/transactions";

const live = process.env.LIVE === "1";
const config = () =>
  parseDeployment(
    JSON.parse(
      readFileSync(
        live ? "public/deployment.json" : "public/local.json",
        "utf8",
      ),
    ),
    live ? process.env.VITE_RPC_URL : undefined,
  );
function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
/** Funds a fixture user and returns the funding transaction hashes. */
async function fund(address: string): Promise<string[]> {
  const c = config();
  if (!live) {
    const response = await fetch(
      `http://127.0.0.1:8181/mint?address=${address}&amount=30000000`,
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Local funding failed.");
    const hashes = (await response.json()) as string[];
    for (const hash of hashes)
      await server(c).waitForTransaction({ transactionHash: hash });
    return hashes;
  }
  // The funder always signs with the current deployer. Only its journal is
  // saved, per deployment, so a redeploy never reuses an old signer.
  const path = `.local/browser-funder-${c.package}.json`;
  const wallet = JSON.parse(
    readFileSync(".local/testnet-deployer.json", "utf8"),
  );
  const s: Session = {
    ...newSession(c),
    key: wallet.privateKey,
    journal: existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")).journal
      : {},
  };
  const hash = await transact(
    c,
    s,
    () => save(path, { journal: s.journal }),
    () => {},
    `fund:${address}`,
    () =>
      server(c).transaction.build.simple({
        sender: accountFor(s).address,
        data: {
          function: "0x1::aptos_account::transfer",
          functionArguments: [address, 30000000n],
        },
        options: { maxGasAmount: MAX_GAS_AMOUNT },
      }),
  );
  return [hash];
}
async function create(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const address = await page.getByTestId("funding-address").innerText();
  const funding = await fund(address);
  return { address, funding };
}
async function start(page: Page) {
  const created = await create(page);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  return created;
}
test("canonical independent-user scenario, external transfer, reload, and reset", async ({
  browser,
}, info) => {
  const c = config();
  const a = await browser.newContext({ viewport: info.project.use.viewport });
  const b = await browser.newContext({ viewport: info.project.use.viewport });
  const pages = { a: await a.newPage(), b: await b.newPage() };
  const addresses: Record<User, string> = { a: "", b: "" };
  const sessions: Partial<Record<User, Session>> = {};
  const transactions: { step: string; hash: string }[] = [];
  // The app clears finished journal entries, so collect the hashes that each
  // page submits and assign them to the scenario step that sent them.
  const submitted: Record<User, Promise<string | undefined>[]> = {
    a: [],
    b: [],
  };
  for (const user of ["a", "b"] as const)
    pages[user].on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/v1/transactions") &&
        response.ok()
      )
        submitted[user].push(
          response.json().then(
            (body: { hash?: string }) => body.hash,
            () => undefined,
          ),
        );
    });
  const record = async (user: User, step: string) => {
    for (const hash of await Promise.all(submitted[user].splice(0)))
      if (hash && !transactions.some((t) => t.hash === hash))
        transactions.push({ step, hash });
    // Keep the session, so the final balances can be read after a reset.
    const raw = await pages[user].evaluate(
      (key) => localStorage.getItem(key),
      deploymentKey(c),
    );
    sessions[user] =
      loadSession(c, { getItem: () => raw } as unknown as Storage) ??
      sessions[user];
  };
  let pending = "";
  let failure: unknown;
  try {
    await canonicalScenario({
      start: async (user) => {
        const created = await start(pages[user]);
        addresses[user] = created.address;
        for (const hash of created.funding)
          transactions.push({ step: `fund-${user}`, hash });
        await record(user, `register-${user}`);
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
        if (action === "Request") pending = amount;
        await record(user, `${action.toLowerCase()}${amount}`);
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
        await record(user, `${action.toLowerCase()}${pending}`);
      },
      expectState: async (user, balance, count) => {
        await pages[user]
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await expect(pages[user].getByTestId("balance")).toHaveText(balance);
        await expect(pages[user].getByTestId("activity-row")).toHaveCount(
          count,
        );
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
        const hash = await transact(
          c,
          s,
          () => save(`.local/browser-external-${info.project.name}.json`, s),
          () => {},
          "external:3",
          () =>
            server(c).transaction.build.simple({
              sender: accountFor(s).address,
              data: {
                function: "0x1::primary_fungible_store::transfer",
                typeArguments: ["0x1::fungible_asset::Metadata"],
                functionArguments: [c.metadata, addresses.a, 3n],
              },
              options: { maxGasAmount: 20000 },
            }),
        );
        await pages.b.evaluate(
          ({ key, raw }) => localStorage.setItem(key, raw),
          { key: deploymentKey(c), raw: JSON.stringify(s) },
        );
        transactions.push({ step: "external3", hash });
        sessions.b = s;
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
  } catch (error) {
    failure = error;
  }
  try {
    // Record what the chain shows now, for a pass or a failure.
    if (sessions.a && sessions.b) {
      const [x, y] = await Promise.all([
        readDashboard(c, sessions.a),
        readDashboard(c, sessions.b),
      ]);
      writeEvidence(
        c,
        !live,
        {
          result: failure ? "failed" : "passed",
          ...(failure ? { failure: failureText(failure) } : {}),
          balances: { a: x.balance.toString(), b: y.balance.toString() },
          activity: { a: Number(x.count), b: Number(y.count) },
          transactions,
        },
        info.project.name as Viewport,
      );
    }
    if (failure) throw failure;
  } finally {
    await a.close();
    await b.close();
  }
});

test("directory pagination and accessible light/dark layout", async ({
  page,
}) => {
  test.skip(live, "Additional registrations use the local faucet.");
  const c = config();
  for (let i = 0; i < 7; i++) {
    const s = newSession(c);
    await fund(accountFor(s).address);
    await payments(
      c,
      s,
      () => save(`.local/contact-${i}.json`, s),
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

test("lost registration acknowledgement confirms the original transaction", async ({
  page,
}) => {
  test.skip(live, "Failure injection is local only.");
  const c = config();
  await create(page);
  let broadcasts = 0;
  await page.route("**/v1/transactions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    broadcasts++;
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(broadcasts).toBe(1);
  expect(
    await page.evaluate(
      (key) =>
        Object.values(JSON.parse(localStorage.getItem(key)!).journal).every(
          (r) => (r as { confirmed: boolean }).confirmed,
        ),
      deploymentKey(c),
    ),
  ).toBe(true);
});

test("second tab cannot write and private files cannot be served", async ({
  page,
  context,
  request,
}) => {
  test.skip(live, "Local server check.");
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(
    second.getByText("Read-only tab", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  expect((await request.get("/.local/local-deployer.json")).status()).toBe(403);
  await second.close();
});

test("failed payments roll back state and competing resolutions settle once", async () => {
  test.skip(live, "Adversarial fixtures use the local faucet.");
  const c = config();
  const a = newSession(c),
    b = newSession(c);
  const persist = (s: Session) => () =>
    save(`.local/adversarial-${accountFor(s).address}.json`, s);
  for (const s of [a, b]) {
    await fund(accountFor(s).address);
    await payments(c, s, persist(s), () => {}).setup();
  }
  const op = (n: number) => n.toString(16).padStart(64, "0");
  const submit = (
    s: Session,
    label: string,
    name: string,
    args: (string | bigint | Uint8Array)[],
  ) =>
    transact(
      c,
      s,
      persist(s),
      () => {},
      label,
      (ledger) => buildCall(c, s, ledger, name, args),
    );
  const requester = accountFor(a).address;
  await expect(
    submit(a, "overspend", "send", [
      accountFor(b).address,
      101n,
      operationBytes(op(1)),
    ]),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  expect(await readEntry(c, requester, op(1))).toBeUndefined();
  expect((await readDashboard(c, a)).count).toBe(0n);
  expect((await readDashboard(c, a)).balance).toBe(100n);
  expect((await readDashboard(c, b)).balance).toBe(100n);
  await submit(a, "request", "request", [
    accountFor(b).address,
    101n,
    operationBytes(op(1)),
  ]);
  const key = [requester, operationBytes(op(1))];
  await expect(
    submit(b, "approve-too-much", "approve", key),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  expect((await readEntry(c, requester, op(1)))?.state).toBe("Pending");
  expect((await readDashboard(c, b)).balance).toBe(100n);
  await expect(
    submit(a, "unauthorized", "decline", key),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  await submit(a, "fund-payer", "send", [
    accountFor(b).address,
    1n,
    operationBytes(op(2)),
  ]);
  // Separate signed sequence numbers race to resolve the same pending request.
  const client = server(c);
  const account = await client.getAccountInfo({
    accountAddress: accountFor(b).address,
  });
  const results = await Promise.allSettled(
    ["approve", "decline"].map((action, offset) =>
      transact(
        c,
        b,
        persist(b),
        () => {},
        `race:${action}`,
        () =>
          client.transaction.build.simple({
            sender: accountFor(b).address,
            data: {
              function: `${c.package}::paymvc::${action}`,
              functionArguments: key,
            },
            options: {
              maxGasAmount: 20000,
              accountSequenceNumber:
                BigInt(account.sequence_number) + BigInt(offset),
            },
          }),
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failed = results.find((result) => result.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(
    RevertedTransaction,
  );
  expect((await readEntry(c, requester, op(1)))?.state).toBe("Paid");
  expect((await readDashboard(c, a)).balance).toBe(200n);
  expect((await readDashboard(c, b)).balance).toBe(0n);
  expect((await readDashboard(c, a)).count).toBe(2n);
});

test("a check that fails before signing keeps the form editable", async ({
  browser,
  page,
}) => {
  test.skip(live, "Runs on the local network only.");
  const other = await browser.newContext();
  const recipient = (await start(await other.newPage())).address;
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

test("unreadable browser storage stops before a wallet is created", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };
  });
  await page.goto("/");
  const message = page.getByRole("alert").filter({
    hasText: "Browser storage is unavailable",
  });
  await expect(message).toBeVisible();
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  await expect(message).toBeVisible();
  await expect(page.getByTestId("funding-address")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset Demo", exact: true }),
  ).toHaveCount(0);
});
