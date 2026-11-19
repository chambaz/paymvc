import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { address, lamports } from "@solana/kit";
import { deploymentKey, parseDeployment, rpc } from "../../src/chain/config";
import { newSession } from "../../src/chain/session";
import { payments, entryAddress } from "../../src/chain/payments";
import { canonicalScenario } from "../conformance/scenario";
import {
  browserScenario,
  create as createWallet,
  form,
  refresh,
  select,
  start as startWallet,
} from "./driver";

const c = parseDeployment(
  JSON.parse(await readFile("public/local.json", "utf8")),
);
async function fund(recipient: string) {
  const client = rpc(c);
  const hash = await client
    .requestAirdrop(address(recipient), lamports(1_000_000_000n), {
      commitment: "confirmed",
    })
    .send();
  await expect
    .poll(
      async () =>
        (await client.getSignatureStatuses([hash]).send()).value[0]
          ?.confirmationStatus,
    )
    .toMatch(/confirmed|finalized/);
}
async function contact() {
  const s = await newSession(c);
  await fund(s.key.address);
  await payments(
    c,
    s,
    () => {},
    () => {},
  ).setup();
  return s.key.address;
}
const create = (page: Page) => createWallet(page, fund);
const start = (page: Page) => startWallet(page, fund);
test("canonical independent-user scenario and external SPL balance", async ({
  browser,
  viewport,
}) => {
  const contexts = {
    a: await browser.newContext({ viewport }),
    b: await browser.newContext({ viewport }),
  };
  try {
    const pages = {
      a: await contexts.a.newPage(),
      b: await contexts.b.newPage(),
    };
    await canonicalScenario(browserScenario(c, pages, fund).driver);
  } finally {
    await contexts.a.close();
    await contexts.b.close();
  }
});
test("directory pages omit self and contacts fill the recipient", async ({
  page,
}) => {
  for (let i = 0; i < 7; i++) await contact();
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
test("reload restores one wallet and a second tab cannot write", async ({
  page,
  context,
}) => {
  const owner = await start(page);
  await page.reload();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).key.address,
      deploymentKey(c),
    ),
  ).toBe(owner);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("Read-only tab")).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await second.close();
});
test("rejected registration retries identical saved bytes", async ({
  page,
}) => {
  await create(page);
  let reject = true;
  const originals = new Set<string>();
  const recovered = new Set<string>();
  await page.route(c.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "sendTransaction") {
      if (reject) {
        originals.add(body.params[0]);
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "RPC unavailable" },
          },
        });
        return;
      }
      if (originals.has(body.params[0])) recovered.add(body.params[0]);
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Progress saved");
  reject = false;
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await expect(page.getByTestId("balance")).toHaveText("100");
  expect(originals.size).toBe(1);
  expect(recovered).toEqual(originals);
  await expect(page.getByTestId("activity-row")).toHaveCount(0);
});
test("lost payment confirmation rechecks without paying twice", async ({
  page,
}) => {
  // Failed status reads keep the client waiting for its full 90 s limit.
  test.setTimeout(240_000);
  const recipient = await contact();
  await start(page);
  let broadcast = false;
  await page.route(c.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "sendTransaction") {
      const response = await route.fetch();
      broadcast = true;
      await route.fulfill({ response });
    } else if (broadcast && body.method === "getSignatureStatuses")
      await route.abort();
    else await route.continue();
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await select(page, recipient);
  await page.getByLabel("Amount", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Send credits", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Outcome unknown",
    { timeout: 120_000 },
  );
  await page.keyboard.press("Escape");
  await page.unrouteAll({ behavior: "wait" });
  await page
    .getByRole("button", { name: "Recheck original operation", exact: true })
    .click();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await expect(page.getByTestId("activity-row")).toHaveCount(1);
});
test("delayed payment state reconciles automatically", async ({ page }) => {
  const recipient = await contact();
  const owner = await start(page);
  let entry: string | undefined;
  let hidden = false;
  const broadcasts = new Set<string>();
  await page.route(c.rpcUrl, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === "sendTransaction") {
      broadcasts.add(body.params[0]);
      const operation = await page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key)!).intent.operation as string,
        deploymentKey(c),
      );
      entry = await entryAddress(c, address(owner), operation);
    }
    if (
      !hidden &&
      body.method === "getAccountInfo" &&
      body.params[0] === entry
    ) {
      const response = await route.fetch();
      const result = await response.json();
      if (result.result.value) {
        hidden = true;
        result.result.value = null;
      }
      await route.fulfill({ json: result });
    } else await route.continue();
  });
  await form(page, "Send", recipient, "7");
  expect(hidden).toBe(true);
  expect(broadcasts.size).toBe(1);
  await expect(page.getByTestId("balance")).toHaveText("93");
});
test("failure retains inputs and stale reads retain the balance", async ({
  page,
}) => {
  const recipient = await contact();
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
  await page.route(c.rpcUrl, (route) => route.abort());
  await refresh(page);
  await expect(page.getByText("Balance may be out of date")).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText("93");
  await page.unrouteAll({ behavior: "wait" });
});
test("light and dark address-only UI is accessible and fits the viewport", async ({
  page,
}) => {
  await start(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await expect(page.getByTestId("balance")).toHaveText("100");
    await expect(
      page.getByRole("button", { name: "Dark mode", exact: true }),
    ).toHaveAttribute("aria-pressed", String(scheme === "dark"));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
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
