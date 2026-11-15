import { expect, test } from "@playwright/test";

test("development server refuses private signing files", async ({
  request,
}) => {
  const response = await request.get("/.local/local-deployer");
  expect(response.status()).toBe(403);
});
