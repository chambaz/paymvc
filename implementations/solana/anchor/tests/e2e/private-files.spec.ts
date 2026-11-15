import { expect, test } from "@playwright/test";

test("development server refuses private signing files", async ({
  request,
}) => {
  for (const path of [
    "/.local/deployer.json",
    "/target/deploy/paymvc-keypair.json",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(403);
  }
});
