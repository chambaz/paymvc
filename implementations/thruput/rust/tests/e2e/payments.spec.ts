import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { parseDeployment, deploymentKey } from "../../src/chain/config";
import { payments, readDashboard } from "../../src/chain/payments";
import {
  loadSession,
  accountFor,
  newSession,
  type Session,
} from "../../src/chain/session";
import {
  failureText,
  writeEvidence,
  type Viewport,
} from "../../scripts/evidence";
import {
  fund,
  funderSession,
  save,
  transferCredits,
} from "../../scripts/transfers";
import { canonicalScenario, type User } from "../conformance/scenario";

// The default suite uses the local node from `npm run local`. LIVE=1 uses Futurenet.
const live = process.env.LIVE === "1";
const network = live ? "futurenet" : "local";
const c = parseDeployment(
  JSON.parse(
    readFileSync(live ? "public/deployment.json" : "public/local.json", "utf8"),
  ),
);

test("selector keeps every network and links the other implementations", async ({
  page,
}) => {
  await page.goto("/");
  const selector = page.getByLabel("Implementation", { exact: true });
  await expect(selector).toHaveValue("thruput");
  const destinations = new Map([
    ["ethereum", "http://127.0.0.1:5173/?network=ethereum"],
    ["solana", "http://127.0.0.1:5175/"],
    ["base", "http://127.0.0.1:5177/?network=base"],
    ["monad", "http://127.0.0.1:5179/?network=monad"],
    ["robinhood", "http://127.0.0.1:5187/?network=robinhood"],
    ["stellar", "http://127.0.0.1:5181/"],
    ["sui", "http://127.0.0.1:5183/"],
    ["aptos", "http://127.0.0.1:5185/"],
  ]);
  // A new implementation adds an option, so check membership, not the count.
  const values = await selector
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(values).toEqual(
    expect.arrayContaining(["thruput", ...destinations.keys()]),
  );
  for (const [network, url] of destinations) {
    await page.route(url, (route) => route.fulfill({ status: 204 }));
    const request = page.waitForRequest(url);
    await selector.selectOption(network);
    await request;
  }
});
const funderPath = `.local/browser-funder-${c.networkHash}-${c.address}.json`;

type RpcMessage = { id?: unknown; method?: string; result?: unknown };
const messages = (body: unknown): RpcMessage[] =>
  (Array.isArray(body) ? body : [body]).filter(
    (message) => typeof message === "object" && message !== null,
  );
/** The JSON-RPC IDs of the `sendTransaction` calls in a request body. */
function sendIds(body: string | null) {
  if (!body?.includes('"sendTransaction"')) return new Set<unknown>();
  return new Set(
    messages(JSON.parse(body))
      .filter((message) => message.method === "sendTransaction")
      .map((message) => message.id),
  );
}
/** The transaction hashes that the RPC returned for `ids`. */
function sentHashes(body: unknown, ids: Set<unknown>) {
  return messages(body).flatMap((message) => {
    const result = message.result as { transactionHash?: unknown } | undefined;
    return ids.has(message.id) && typeof result?.transactionHash === "string"
      ? [result.transactionHash]
      : [];
  });
}
test("canonical independent-user scenario, external transfer, reload, and reset", async ({
  browser,
}, info) => {
  const a = await browser.newContext({ viewport: info.project.use.viewport });
  const b = await browser.newContext({ viewport: info.project.use.viewport });
  const pages = { a: await a.newPage(), b: await b.newPage() };
  const addresses: Record<User, string> = { a: "", b: "" };
  // The original wallets, kept after a reset to read the final state.
  const sessions: Partial<Record<User, Session>> = {};
  // Transaction hashes in scenario order.
  const transactions: { step: string; hash: string }[] = [];
  const snapshot = async (user: User) => {
    const raw = await pages[user].evaluate(
      (key) => localStorage.getItem(key)!,
      deploymentKey(c),
    );
    const session = loadSession(c, { getItem: () => raw })!;
    const address = accountFor(session).address;
    save(`.local/browser-${address}.json`, session);
    if (address === addresses[user]) sessions[user] = session;
    return session;
  };
  // The app deletes a payment's saved transaction once its effect is
  // verified, so the hashes come from the page's `sendTransaction` calls.
  const submitted: Record<User, Promise<string[]>[]> = { a: [], b: [] };
  for (const user of ["a", "b"] as const)
    pages[user].on("response", (response) => {
      const ids = sendIds(response.request().postData());
      if (ids.size)
        submitted[user].push(
          response.json().then(
            (body) => sentHashes(body, ids),
            () => [],
          ),
        );
    });
  /** Save the session and record its new transactions under `step`. */
  const record = async (user: User, step: string) => {
    await snapshot(user);
    for (const hash of (await Promise.all(submitted[user].splice(0))).flat())
      if (!transactions.some((t) => t.hash === hash))
        transactions.push({ step, hash });
  };
  let pending = "";
  let failure: unknown;
  try {
    await canonicalScenario({
      start: async (user) => {
        const page = pages[user];
        await page.goto("/");
        await page
          .getByRole("button", { name: "Create demo wallet", exact: true })
          .click();
        addresses[user] = await page.getByTestId("funding-address").innerText();
        await snapshot(user);
        const funder = funderSession(c, network, funderPath);
        transactions.push({
          step: `fund-${user}`,
          hash: await fund(c, funder, addresses[user], () =>
            save(funderPath, funder),
          ),
        });
        await page
          .getByRole("button", { name: "Start demo", exact: true })
          .click();
        await expect(page.getByTestId("balance")).toHaveText("100");
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
        const s = await snapshot("b");
        transactions.push({
          step: "external3",
          hash: await transferCredits(c, s, addresses.a, 3n, () =>
            save(`.local/browser-${addresses.b}.json`, s),
          ),
        });
        await pages.b.evaluate(
          ({ key, raw }) => localStorage.setItem(key, raw),
          { key: deploymentKey(c), raw: JSON.stringify(s) },
        );
      },
      reset: async (user) => {
        await snapshot(user);
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
      const height = [sessions.a, sessions.b]
        .map((s) => BigInt(s.stateHeight))
        .reduce((x, y) => (x > y ? x : y))
        .toString();
      const [x, y] = await Promise.all([
        readDashboard(c, { ...sessions.a, stateHeight: height }),
        readDashboard(c, { ...sessions.b, stateHeight: height }),
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
    for (const user of ["a", "b"] as const)
      if (addresses[user]) await snapshot(user).catch(() => {});
    await a.close();
    await b.close();
  }
});

test("wallet creation is transaction-free and a second tab is read-only", async ({
  page,
  context,
}) => {
  let writes = 0;
  page.on("request", (request) => {
    if (request.postData()?.includes('"sendTransaction"')) writes++;
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  await expect(page.getByTestId("funding-address")).toBeVisible();
  const address = await page.getByTestId("funding-address").innerText();
  const second: Page = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("funding-address")).toHaveText(address);
  await expect(
    second.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(0);
});

/** Fund `address` from the local deployer. */
async function fundAddress(address: string) {
  const funder = funderSession(c, network, funderPath);
  await fund(c, funder, address, () => save(funderPath, funder));
}
/** Create, fund, and start a wallet in `page`. Returns its address. */
async function startWallet(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const address = await page.getByTestId("funding-address").innerText();
  await fundAddress(address);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  return address;
}
/** Register another user outside the browser. Returns its address. */
async function registeredContact() {
  const s = newSession(c);
  const address = accountFor(s).address;
  await fundAddress(address);
  const persist = () => save(`.local/contact-${address}.json`, s);
  persist();
  await payments(c, s, persist, () => {}).setup();
  return address;
}

test.describe("local failure paths", () => {
  test.skip(live, "These tests fund wallets from the local deployer.");

  test("failed writes keep input, failed reads keep the balance, and the dashboard is accessible", async ({
    page,
  }) => {
    const recipient = await registeredContact();
    await startWallet(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    }
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
    // Switching modes keeps both fields, and nothing was signed.
    await dialog.getByRole("radio", { name: "Request", exact: true }).click();
    await dialog.getByRole("radio", { name: "Send", exact: true }).click();
    await expect(dialog.getByLabel("Recipient address")).toHaveValue(recipient);
    await expect(dialog.getByLabel("Amount", { exact: true })).toHaveValue(
      "101",
    );
    await dialog.getByLabel("Amount", { exact: true }).fill("7");
    await dialog
      .getByRole("button", { name: "Send credits", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("balance")).toHaveText("93");
    await page.route(c.rpcUrl, (route) => route.abort("failed"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Balance may be out of date")).toBeVisible();
    await expect(page.getByTestId("balance")).toHaveText("93");
    await page.unrouteAll({ behavior: "wait" });
  });

  test("directory pages omit self and contacts fill the recipient", async ({
    page,
  }) => {
    for (let i = 0; i < 7; i++) await registeredContact();
    const owner = await startWallet(page);
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
  });

  test("a rejected submission keeps the signed bytes and recheck sends them again", async ({
    page,
  }) => {
    const recipient = await registeredContact();
    await startWallet(page);
    const sent: unknown[] = [];
    let reject = true;
    await page.route(c.rpcUrl, async (route) => {
      const body = route.request().postData();
      if (!body?.includes('"sendTransaction"')) return route.continue();
      const calls = messages(JSON.parse(body)) as {
        id?: unknown;
        method?: string;
        params?: { signedTransaction?: unknown };
      }[];
      for (const call of calls)
        if (call.method === "sendTransaction")
          sent.push(call.params?.signedTransaction);
      if (!reject) return route.continue();
      const errors = calls.map((call) => ({
        jsonrpc: "2.0",
        id: call.id,
        error: { code: -32000, message: "Unavailable" },
      }));
      await route.fulfill({
        json: Array.isArray(JSON.parse(body)) ? errors : errors[0],
      });
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Recipient address").fill(recipient);
    await dialog.getByLabel("Amount", { exact: true }).fill("7");
    await dialog
      .getByRole("button", { name: "Send credits", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await page.keyboard.press("Escape");
    reject = false;
    await page
      .getByRole("button", { name: "Recheck original operation", exact: true })
      .click();
    await expect(page.getByTestId("balance")).toHaveText("93");
    await expect(page.getByTestId("activity-row")).toHaveCount(1);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((bytes) => JSON.stringify(bytes))).size).toBe(1);
    await page.unrouteAll({ behavior: "wait" });
  });

  test("storage failure stops before a wallet is funded", async ({ page }) => {
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
      page.getByText("Browser storage is unavailable", { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId("funding-address")).toHaveCount(0);
  });
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
