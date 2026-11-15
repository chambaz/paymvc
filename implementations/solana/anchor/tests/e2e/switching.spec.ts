import { expect, test } from "@playwright/test";

for (const [network, port] of [
  ["ethereum", 5173],
  ["base", 5177],
  ["monad", 5179],
  ["robinhood", 5187],
  ["stellar", 5181],
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
    const destination = `http://127.0.0.1:${port}/${["ethereum", "base", "monad", "robinhood"].includes(network) ? `?network=${network}` : ""}`;
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
