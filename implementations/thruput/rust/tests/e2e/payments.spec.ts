import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseDeployment, deploymentKey } from "../../src/chain/config";
import { readDashboard } from "../../src/chain/payments";
import { loadSession, accountFor, type Session } from "../../src/chain/session";
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

test("selector retains all nine networks and links the other implementations", async ({
  page,
}) => {
  await page.goto("/");
  const selector = page.getByLabel("Implementation", { exact: true });
  await expect(selector).toHaveValue("thruput");
  await expect(selector.locator("option")).toHaveCount(9);
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
