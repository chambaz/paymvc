import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  createWalletClient,
  http,
  erc20Abi,
  parseEther,
  decodeFunctionData,
  encodeErrorResult,
  parseTransaction,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFile } from "node:fs/promises";
import {
  deploymentKey,
  parseDeployment,
  publicClient,
} from "../../src/chain/config";
import { paymvcAbi } from "../../src/chain/generated/paymvcAbi";
import {
  accountFor,
  newSession,
  operationId,
  type Session,
} from "../../src/chain/session";
import { payments } from "../../src/chain/payments";
import { canonicalScenario, type User } from "../conformance/scenario";

const config = parseDeployment(
  JSON.parse(await readFile("public/local.json", "utf8")),
);
async function fund(address: Address) {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, `0x${parseEther("1").toString(16)}`],
    }),
  });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
}
async function create(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create demo wallet", exact: true })
    .click();
  const address = (await page
    .getByTestId("funding-address")
    .innerText()) as Address;
  await fund(address);
  return address;
}
async function start(page: Page) {
  const address = await create(page);
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
  return address;
}
async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
}
async function registeredContact() {
  const session = newSession(config);
  const address = accountFor(session).address;
  await fund(address);
  await payments(
    config,
    session,
    () => {},
    () => {},
  ).setup();
  return address;
}
async function select(page: Page, recipient: string) {
  await page.getByLabel("Recipient address", { exact: true }).fill(recipient);
}
async function form(
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
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount", { exact: true }).fill(amount);
  await dialog.getByRole("radio", { name: action, exact: true }).click();
  await expect(
    dialog.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue(recipient);
  await expect(dialog.getByLabel("Amount", { exact: true })).toHaveValue(
    amount,
  );
  await dialog
    .getByRole("button", {
      name: action === "Send" ? "Send credits" : "Create request",
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
}

test("canonical independent-user payments, owner-only responses, persistence and reset", async ({
  browser,
  viewport,
}) => {
  const contexts = {
    a: await browser.newContext({ viewport }),
    b: await browser.newContext({ viewport }),
  };
  const pages = {
    a: await contexts.a.newPage(),
    b: await contexts.b.newPage(),
  };
  const addresses = {} as Record<User, Address>;
  try {
    await canonicalScenario({
      start: async (user) => {
        addresses[user] = await start(pages[user]);
      },
      payment: async (user, action, amount) => {
        await form(
          pages[user],
          action,
          addresses[user === "a" ? "b" : "a"],
          amount,
        );
        if (action === "Request") {
          await expect(
            pages[user].getByRole("button", { name: "Approve", exact: true }),
          ).toHaveCount(0);
          await expect(
            pages[user].getByRole("button", { name: /Pay as/ }),
          ).toHaveCount(0);
        }
      },
      resolve: async (user, action) => {
        await refresh(pages[user]);
        await pages[user]
          .getByRole("button", { name: action, exact: true })
          .click();
        await expect(
          pages[user].getByRole("button", { name: action, exact: true }),
        ).toHaveCount(0);
      },
      expectState: async (user, balance, count) => {
        await refresh(pages[user]);
        await expect(pages[user].getByTestId("balance")).toHaveText(balance);
        await expect(pages[user].getByTestId("activity-row")).toHaveCount(
          count,
        );
      },
      reload: async (user) => {
        await pages[user].reload();
      },
      externalTransfer: async () => {
        const session: Session = await pages.b.evaluate(() =>
          JSON.parse(
            localStorage.getItem(
              Object.keys(localStorage).find((key) =>
                key.startsWith("paymvc:v2:"),
              )!,
            )!,
          ),
        );
        const wallet = createWalletClient({
          account: privateKeyToAccount(session.key),
          chain: foundry,
          transport: http(config.rpcUrl),
        });
        await publicClient(config).waitForTransactionReceipt({
          hash: await wallet.writeContract({
            address: config.token,
            abi: erc20Abi,
            functionName: "transfer",
            args: [addresses.a, 3n],
          }),
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
          addresses[user],
        );
      },
    });
  } finally {
    await contexts.a.close();
    await contexts.b.close();
  }
});

test("registration resumes saved bytes without duplicate allocation or activity", async ({
  page,
}) => {
  const address = await create(page);
  const before = await publicClient(config).readContract({
    address: config.address,
    abi: paymvcAbi,
    functionName: "profileCount",
  });
  let blocked = true;
  const rejected = new Set<string>();
  const recovered = new Set<string>();
  await page.route(config.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "eth_sendRawTransaction") {
      if (blocked) {
        rejected.add(body.params[0]);
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "RPC unavailable" },
          },
        });
        return;
      }
      if (rejected.has(body.params[0])) recovered.add(body.params[0]);
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Progress saved");
  await page.reload();
  await expect(page.getByTestId("funding-address")).toHaveText(address);
  blocked = false;
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(rejected.size).toBe(1);
  expect(recovered).toEqual(rejected);
  expect(
    await publicClient(config).readContract({
      address: config.address,
      abi: paymvcAbi,
      functionName: "profileCount",
    }),
  ).toBe(before + 1n);
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
});

test("directory pages exclude self and contacts fill the recipient", async ({
  page,
}) => {
  for (let i = 0; i < 7; i++) await registeredContact();
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
  expect(values.length).toBeGreaterThan(5);
  await contacts.last().click();
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue(values.at(-1)!);
});

test("second tab is read-only and corrupt storage has an explicit reset", async ({
  page,
  context,
}) => {
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("Read-only tab")).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await second.close();
  await page.evaluate(() =>
    localStorage.setItem(
      Object.keys(localStorage).find((key) => key.startsWith("paymvc:v2:"))!,
      "private-marker",
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: "unreadable" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("private-marker");
  await page.getByRole("button", { name: "Reset Demo", exact: true }).click();
  await page
    .getByRole("button", { name: "Reset and remove wallet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create demo wallet", exact: true }),
  ).toBeEnabled();
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

test("the reset confirmation keeps keyboard focus in place", async ({
  page,
}) => {
  await create(page);
  const reset = page.getByRole("button", { name: "Reset Demo", exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Keep demo", exact: true }).click();
  await expect(reset).toBeFocused();
  await expect(page.getByTestId("funding-address")).toBeVisible();
  // A confirmed reset removes Reset Demo, so focus moves to the next step.
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Reset and remove wallet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create demo wallet", exact: true }),
  ).toBeFocused();
});

test("delayed payment result reconciles without another broadcast", async ({
  page,
}) => {
  const recipient = await registeredContact();
  await start(page);
  let delayed = false;
  let broadcasts = 0;
  await page.route(config.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "eth_sendRawTransaction") broadcasts++;
    if (!delayed && broadcasts > 0 && body.method === "eth_call") {
      let lookup = false;
      try {
        lookup =
          decodeFunctionData({ abi: paymvcAbi, data: body.params[0].data })
            .functionName === "entry";
      } catch {
        /* Token read. */
      }
      if (lookup) {
        // The first lookup after the broadcast answers as if the entry did not exist yet.
        delayed = true;
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: 3,
              message: "execution reverted",
              data: encodeErrorResult({
                abi: paymvcAbi,
                errorName: "NotFound",
              }),
            },
          },
        });
        return;
      }
    }
    await route.continue();
  });
  await form(page, "Send", recipient, "7");
  expect(delayed).toBe(true);
  // The permit is signed into the payment, so there is no separate allowance transaction.
  expect(broadcasts).toBe(1);
  await expect(page.getByTestId("balance")).toHaveText("93");
  await expect(page.getByTestId("activity-row")).toHaveCount(1);
});

test("payment retry rebroadcasts the same permit-signed transaction", async ({
  page,
}) => {
  const recipient = await registeredContact();
  await start(page);
  let blocked = true;
  const broadcasts: string[] = [];
  await page.route(config.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "eth_sendRawTransaction") {
      broadcasts.push(body.params[0]);
      if (blocked) {
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "RPC unavailable" },
          },
        });
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await select(page, recipient);
  await page.getByLabel("Amount", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Send credits", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Progress saved" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // After a reload, the saved operation is still explained, not only offered for recheck.
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: "Outcome unknown" }),
  ).toBeVisible();
  blocked = false;
  await page
    .getByRole("button", { name: "Recheck original operation", exact: true })
    .click();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await expect(page.getByTestId("activity-row")).toHaveCount(1);
  expect(broadcasts).toHaveLength(2);
  expect(broadcasts[1]).toBe(broadcasts[0]);
  const { data } = parseTransaction(broadcasts[0] as `0x${string}`);
  expect(decodeFunctionData({ abi: paymvcAbi, data: data! }).functionName).toBe(
    "send",
  );
});

test("lost registration confirmation receives a bounded recheck", async ({
  page,
}) => {
  await create(page);
  await page.clock.install();
  let hide = false;
  let receipts = 0;
  await page.route(config.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "eth_sendRawTransaction") {
      const tx = parseTransaction(body.params[0]);
      expect(
        decodeFunctionData({ abi: paymvcAbi, data: tx.data! }).functionName,
      ).toBe("register");
      const response = await route.fetch();
      hide = true;
      await route.fulfill({ response });
      return;
    }
    if (hide && body.method === "eth_getTransactionReceipt") {
      receipts++;
      await route.fulfill({
        json: { jsonrpc: "2.0", id: body.id, result: null },
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect.poll(() => receipts).toBeGreaterThanOrEqual(2);
  await page.clock.fastForward(91_000);
  await page.unrouteAll({ behavior: "wait" });
  await page.clock.runFor(6_000);
  await expect(page.getByTestId("balance")).toHaveText("100");
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
});

test("failed writes keep input and failed reads keep the last balance", async ({
  page,
}) => {
  const recipient = await registeredContact();
  await start(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await select(page, recipient);
  await page.getByLabel("Amount", { exact: true }).fill("101");
  await page.getByRole("button", { name: "Send credits", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Not enough demo credits",
  );
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("101");
  // Nothing was signed, so the form stays editable and the next attempt succeeds.
  await page.getByLabel("Amount", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Send credits", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await page.route(config.rpcUrl, (route) => route.abort("failed"));
  await refresh(page);
  await expect(page.getByText("Balance may be out of date")).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await page.unrouteAll({ behavior: "wait" });
});

test("storage writes from another tab do not replace a running operation", async ({
  page,
  context,
}) => {
  const recipient = await registeredContact();
  await start(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("Read-only tab")).toBeVisible();
  const before = await page.evaluate(
    (key) => localStorage.getItem(key)!,
    deploymentKey(config),
  );
  await page.route(config.rpcUrl, async (route) => {
    if (route.request().postDataJSON().method === "eth_sendRawTransaction") {
      // The theme is saved in the same origin's storage, so this tab receives a storage event.
      await second.getByRole("button", { name: "Dark mode" }).click();
      // Another tab writes an older copy of this session. The running operation keeps its own.
      await second.evaluate(
        ([key, value]) => localStorage.setItem(key, value),
        [deploymentKey(config), before] as const,
      );
      await page.waitForTimeout(250);
    }
    await route.continue();
  });
  await form(page, "Send", recipient, "7");
  await expect(page.getByTestId("balance")).toHaveText("93");
  await page.unrouteAll({ behavior: "wait" });
  await second.close();
  await page.reload();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Recheck original operation" }),
  ).toHaveCount(0);
});

test("a failed read after Load more keeps the last balance and rows", async ({
  page,
}) => {
  const address = await start(page);
  // Another user's 51 requests give this user one more record than the first page shows.
  const session = newSession(config);
  await fund(accountFor(session).address);
  const contact = payments(
    config,
    session,
    () => {},
    () => {},
  );
  await contact.setup();
  for (let index = 0; index < 51; index++)
    await contact.execute({
      action: "request",
      recipient: address,
      amount: "1",
      id: "",
      operation: operationId(`load-more-${index}`),
    });
  await refresh(page);
  await expect(page.getByTestId("activity-row")).toHaveCount(50);
  await page.route(config.rpcUrl, (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("Balance may be out of date")).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("100");
  await expect(page.getByTestId("activity-row")).toHaveCount(50);
  await page.unrouteAll({ behavior: "wait" });
});

test("address-only reference supports keyboard access and responsive layouts", async ({
  page,
}) => {
  await page.goto("/reference.html");
  for (const state of [
    "entry",
    "funding",
    "setup",
    "dashboard",
    "unknown",
    "failed",
    "stale",
    "read-only",
  ]) {
    await page.getByLabel("Preview state", { exact: true }).selectOption(state);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByLabel("Preview state", { exact: true })
    .selectOption("dashboard");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByLabel("Recipient address", { exact: true }),
  ).toHaveValue("");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const contact = page
    .getByRole("region", { name: "Your contacts" })
    .getByRole("button", { name: /^Send to / })
    .first();
  const address = (await contact.getAttribute("title"))!;
  await page.getByRole("button", { name: "Request", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const recipient = dialog.getByLabel("Recipient address", { exact: true });
  await expect(recipient).toHaveValue("");
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Load more contacts" }),
  ).toHaveCount(0);
  await recipient.fill(address);
  await dialog.getByLabel("Amount", { exact: true }).fill("7");
  await dialog.getByRole("radio", { name: "Send", exact: true }).click();
  await expect(recipient).toHaveValue(address);
  await expect(dialog.getByLabel("Amount", { exact: true })).toHaveValue("7");
  await page.keyboard.press("Escape");
  await contact.click();
  await expect(recipient).toHaveValue(address);
  await page.keyboard.press("Escape");
});
