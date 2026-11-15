import { expect, test } from "@playwright/test";

for (const [network, destination] of [
  ["ethereum", "http://127.0.0.1:5173/?network=ethereum"],
  ["solana", "http://127.0.0.1:5175/"],
  ["base", "http://127.0.0.1:5177/?network=base"],
  ["monad", "http://127.0.0.1:5179/?network=monad"],
  ["robinhood", "http://127.0.0.1:5187/?network=robinhood"],
  ["stellar", "http://127.0.0.1:5181/"],
  ["sui", "http://127.0.0.1:5183/"],
  ["aptos", "http://127.0.0.1:5185/"],
] as const) {
  test(`switching to ${network} preserves the saved wallet`, async ({
    page,
  }) => {
    await page.goto("/");
    const original = page.url();
    await page
      .getByRole("button", { name: "Create demo wallet", exact: true })
      .click();
    const address = await page.getByTestId("funding-address").innerText();
    await page.route(destination, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<h1>${network} destination</h1>`,
      }),
    );
    await page
      .getByLabel("Implementation", { exact: true })
      .selectOption(network);
    await expect(page).toHaveURL(destination);
    await page.goto(original);
    await expect(page.getByTestId("funding-address")).toHaveText(address);
  });
}
