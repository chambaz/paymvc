import { test, expect } from "@playwright/test";
import { networks } from "../../src/networks";

test("the logo links to the landing page", async ({ page }) => {
  await page.goto("/?network=base");
  await expect(
    page.getByRole("link", { name: "PayMVC. Homepage", exact: true }),
  ).toHaveAttribute("href", "http://127.0.0.1:5170");
});

test("one frontend restores isolated wallets for all four networks", async ({
  page,
}) => {
  const addresses = new Map<string, string>();
  for (const id of Object.keys(networks)) {
    await page.goto(`/?network=${id}`);
    await expect(
      page.getByLabel("Implementation", { exact: true }),
    ).toHaveValue(id);
    await page
      .getByRole("button", { name: "Create demo wallet", exact: true })
      .click();
    const address = await page.getByTestId("funding-address").innerText();
    expect([...addresses.values()]).not.toContain(address);
    addresses.set(id, address);
  }
  for (const [id, address] of addresses) {
    await page.goto(`/?network=${id}`);
    await expect(page.getByTestId("funding-address")).toHaveText(address);
    await page.reload();
    await expect(page.getByTestId("funding-address")).toHaveText(address);
  }
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith("paymvc:v2:"))
          .length,
    ),
  ).toBe(4);
});

test("unknown networks and mismatched deployments stop before wallet creation", async ({
  page,
}) => {
  await page.goto("/?network=mainnet");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create demo wallet", exact: true }),
  ).toHaveCount(0);
  await page.route("**/deployments/base-sepolia.json", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), chainId: 11155111 },
    });
  });
  await page.goto("/?network=base");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith("paymvc:v2:"))
          .length,
    ),
  ).toBe(0);
});
