import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const state of [
  "funding",
  "setup",
  "unknown",
  "failed",
  "stale",
  "read-only",
  "dashboard",
]) {
  test(`dark ${state} reference remains accessible`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/reference.html");
    await page.getByLabel("Preview state", { exact: true }).selectOption(state);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (state === "dashboard") {
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  });
}

test("theme follows the system until a saved keyboard selection overrides it", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveClass("dark");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).not.toHaveClass("dark");
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("theme toggle works when preference storage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "paymvc:theme")
        throw new DOMException("Storage blocked", "SecurityError");
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "paymvc:theme")
        throw new DOMException("Storage blocked", "SecurityError");
      return setItem.call(this, key, value);
    };
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass("dark");
});
