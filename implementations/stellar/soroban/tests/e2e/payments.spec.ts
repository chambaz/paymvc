import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { Address, Contract, nativeToScVal } from "@stellar/stellar-sdk";
import { parseDeployment, deploymentKey } from "../../src/chain/config";
import { accountFor, newSession, type Session } from "../../src/chain/session";
import { payments } from "../../src/chain/payments";
import { transact } from "../../src/chain/transactions";
import { canonicalScenario, type User } from "../conformance/scenario";
import { recordEvidence, type Viewport } from "../../scripts/evidence";

const live = process.env.LIVE === "1";
async function config() {
  return parseDeployment(
    JSON.parse(
      await readFile(
        live && process.env.LOCAL !== "1"
          ? "public/deployment.json"
          : "public/local.json",
        "utf8",
      ),
    ),
  );
}
async function create(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const visitor = await page.getByTestId("funding-address").innerText();
  const c = await config();
  const response = await fetch(`${c.faucetUrl}?addr=${visitor}`);
  expect(response.ok).toBe(true);
  return visitor;
}
async function start(page: Page) {
  const visitor = await create(page);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  return visitor;
}
async function payment(
  page: Page,
  action: "Send" | "Request",
  contact: string,
  amount: string,
) {
  await page.getByRole("button", { name: action, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Recipient address", { exact: true }).fill(contact);
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
  viewport,
}, testInfo) => {
  const contexts = {
    a: await browser.newContext({ viewport }),
    b: await browser.newContext({ viewport }),
  };
  const pages = {
    a: await contexts.a.newPage(),
    b: await contexts.b.newPage(),
  };
  const owners = {} as Record<User, string>;
  const refresh = async (user: User) => {
    await pages[user]
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
  };
  let failure: unknown;
  try {
    await canonicalScenario({
      start: async (user) => {
        owners[user] = await start(pages[user]);
      },
      payment: async (user, action, amount) => {
        await refresh(user);
        await payment(
          pages[user],
          action,
          owners[user === "a" ? "b" : "a"],
          amount,
        );
        if (action === "Request")
          await expect(
            pages[user].getByRole("button", { name: "Approve", exact: true }),
          ).toHaveCount(0);
      },
      resolve: async (user, action) => {
        await refresh(user);
        await pages[user]
          .getByRole("button", { name: action, exact: true })
          .click();
        await expect(
          pages[user].getByRole("button", { name: action, exact: true }),
        ).toHaveCount(0);
      },
      expectState: async (user, balance, count) => {
        if (live)
          console.log(
            `Checking user ${user}: ${balance} credits, ${count} records`,
          );
        await refresh(user);
        await expect(pages[user].getByTestId("balance")).toHaveText(balance);
        await expect(pages[user].getByTestId("activity-row")).toHaveCount(
          count,
        );
      },
      reload: async (user) => {
        await pages[user].reload();
      },
      externalTransfer: async () => {
        const c = await config();
        const s: Session = await pages.b.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!),
          deploymentKey(c),
        );
        // The signed transfer is saved before broadcast, like every transaction.
        mkdirSync(".local/browser-sessions", { recursive: true, mode: 0o700 });
        await transact(
          c,
          s,
          () =>
            writeFileSync(
              `.local/browser-sessions/${owners.b}.json`,
              JSON.stringify(s),
              { mode: 0o600 },
            ),
          "external:test",
          async () => [
            new Contract(c.token).call(
              "transfer",
              new Address(owners.b).toScVal(),
              new Address(owners.a).toScVal(),
              nativeToScVal(3n, { type: "i128" }),
            ),
          ],
        );
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
          owners[user],
        );
      },
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await contexts.a.close();
    await contexts.b.close();
    // Both users must exist on chain before there is a run to record.
    if (live && owners.a && owners.b) {
      const run = await recordEvidence(await config(), owners, {
        viewport: testInfo.project.name as Viewport,
        failure,
      });
      if (!failure && run.result !== "passed") throw new Error(run.failure);
    }
  }
});

test("rejected submission retains signed bytes for explicit retry", async ({
  page,
}) => {
  await create(page);
  let reject = true;
  let raw: string | undefined;
  let recovered = false;
  await page.route("http://127.0.0.1:8000/rpc", async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "sendTransaction") {
      if (reject) {
        raw = body.params.transaction;
        await route.fulfill({ status: 429, body: "Busy" });
        return;
      }
      if (body.params.transaction === raw) recovered = true;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(
    page.getByText(
      "The RPC is busy or unavailable. Progress saved. Please retry.",
      { exact: true },
    ),
  ).toBeVisible();
  reject = false;
  await page.reload();
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(recovered).toBe(true);
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
});

test("directory pages omit self and contacts fill the recipient", async ({
  page,
}) => {
  const c = await config();
  for (let i = 0; i < 7; i++) {
    const s = newSession(c);
    const response = await fetch(
      `${c.faucetUrl}?addr=${accountFor(s).address}`,
    );
    expect(response.ok).toBe(true);
    await payments(
      c,
      s,
      () => {},
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
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue(values.at(-1)!);
});

test("accessible dashboard and failed reads retain the last balance", async ({
  page,
}) => {
  await start(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.route("http://127.0.0.1:8000/rpc", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Balance may be out of date")).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("100");
});

test("another tab is read-only and reload keeps the same identities", async ({
  page,
  context,
}) => {
  const visitor = await create(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeDisabled();
  await expect(other.getByTestId("funding-address")).toHaveText(visitor);
  await other.close();
  await page.reload();
  await expect(page.getByTestId("funding-address")).toHaveText(visitor);
  await expect(
    page.getByRole("button", { name: "Start demo", exact: true }),
  ).toBeEnabled();
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
  // Simulation refuses the overspend before anything is signed.
  await expect(dialog.getByRole("alert")).toContainText(
    "could not prepare this step",
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
