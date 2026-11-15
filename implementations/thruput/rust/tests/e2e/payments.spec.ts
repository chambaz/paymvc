import { test, expect, type Page } from "@playwright/test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { addressFromBase58, gasAmount } from "@thruputchain/client";
import { NATIVE_TOKEN_ADDRESS } from "@thruputchain/protocol";
import { ERC20 } from "../../src/chain/generated/credits";
import { parseDeployment, deploymentKey } from "../../src/chain/config";
import {
  newSession,
  loadSession,
  accountFor,
  type Session,
} from "../../src/chain/session";
import { verifyDeployment } from "../../src/chain/payments";
import { transact } from "../../src/chain/transactions";
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
mkdirSync(".local", { recursive: true, mode: 0o700 });
function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
async function fund(address: string) {
  const path = `.local/browser-funder-${c.networkHash}-${c.address}.json`;
  // The deploy script's private CLI key. Its first 32 bytes are the seed.
  const deployer = JSON.parse(
    readFileSync(
      `.local/${network}-cli/thruput/keys/${network}-deployer.json`,
      "utf8",
    ),
  );
  const s: Session = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { ...newSession(c), key: `0x${deployer.keypair_hex.slice(0, 64)}` };
  await transact(
    c,
    s,
    await verifyDeployment(c),
    `fund:${address}`,
    [
      ERC20.v0_1.transfer.invocation(
        NATIVE_TOKEN_ADDRESS,
        gasAmount(1_000_000n),
        { receiver: addressFromBase58(address), amount: 200_000_000n },
      ),
    ],
    () => save(path, s),
    () => {},
    async () => false, // Never replace a funding transfer.
  );
}
test("canonical independent-user scenario, external transfer, reload, and reset", async ({
  browser,
}, info) => {
  const a = await browser.newContext({ viewport: info.project.use.viewport });
  const b = await browser.newContext({ viewport: info.project.use.viewport });
  const pages = { a: await a.newPage(), b: await b.newPage() };
  const addresses: Record<User, string> = { a: "", b: "" };
  const hashes = new Set<string>();
  const snapshot = async (user: User) => {
    const raw = await pages[user].evaluate(
      (key) => localStorage.getItem(key)!,
      deploymentKey(c),
    );
    const session = loadSession(c, { getItem: () => raw })!;
    save(`.local/browser-${accountFor(session).address}.json`, session);
    for (const record of Object.values(session.journal))
      hashes.add(record.hash);
    return session;
  };
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
        await fund(addresses[user]);
        await page
          .getByRole("button", { name: "Start demo", exact: true })
          .click();
        await expect(page.getByTestId("balance")).toHaveText("100");
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
        await snapshot(user);
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
        await snapshot(user);
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
        await transact(
          c,
          s,
          await verifyDeployment(c),
          "external:3",
          [
            ERC20.v0_1.transfer.invocation(
              addressFromBase58(c.credits),
              gasAmount(1_000_000n),
              { receiver: addressFromBase58(addresses.a), amount: 3n },
            ),
          ],
          () => save(`.local/browser-${info.project.name}-b.json`, s),
          () => {},
          async () => false, // Never replace the external transfer.
        );
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
    // Only public runs produce evidence.
    if (live) {
      mkdirSync("evidence", { recursive: true });
      writeFileSync(
        `evidence/browser-${info.project.name}.json`,
        JSON.stringify(
          {
            spec: "1.0.0-draft.2",
            network: c.network,
            networkHash: c.networkHash,
            address: c.address,
            revision: execFileSync("git", ["rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
            dirty: Boolean(
              execFileSync(
                "git",
                [
                  "status",
                  "--porcelain",
                  "--untracked-files=all",
                  "--",
                  "src",
                  "scripts",
                  "tests",
                  "public",
                  "contracts",
                  "Cargo.toml",
                  "Cargo.lock",
                  "package.json",
                  "package-lock.json",
                  "vite.config.ts",
                  "playwright.config.ts",
                ],
                { encoding: "utf8" },
              ).trim(),
            ),
            verifiedAt: new Date().toISOString(),
            viewport: info.project.use.viewport,
            addresses,
            balances: ["85", "115"],
            activity: [4, 4],
            transactions: [...hashes],
          },
          null,
          2,
        ) + "\n",
      );
    }
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
