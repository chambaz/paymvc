import { expect, test, type Page } from "@playwright/test";

const states = [
  "entry",
  "funding",
  "setup",
  "dashboard",
  "unknown",
  "failed",
  "stale",
  "read-only",
];

async function open(page: Page, scheme: "light" | "dark", state: string) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/reference.html");
  await page.getByLabel("Preview state", { exact: true }).selectOption(state);
}

for (const state of states) {
  test(`light ${state}`, async ({ page }) => {
    await open(page, "light", state);
    await expect(page).toHaveScreenshot(`v2-${state}.png`, { fullPage: true });
  });
}

test("dark entry", async ({ page }) => {
  await open(page, "dark", "entry");
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(page).toHaveScreenshot("v2-entry-dark.png", { fullPage: true });
});

test("dark dashboard and send dialog", async ({ page }) => {
  await open(page, "dark", "dashboard");
  await expect(page).toHaveScreenshot("v2-dashboard-dark.png", {
    fullPage: true,
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveScreenshot("v2-send-dark.png");
});
