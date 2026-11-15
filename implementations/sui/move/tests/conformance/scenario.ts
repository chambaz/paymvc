/** Test-only contract. Production signing and reads stay in each implementation. */
export type User = "a" | "b";
export interface ScenarioDriver {
  start(user: User): Promise<void>;
  payment(
    user: User,
    action: "Send" | "Request",
    amount: string,
  ): Promise<void>;
  resolve(payer: User, action: "Approve" | "Decline"): Promise<void>;
  expectState(
    user: User,
    balance: string,
    activityCount: number,
  ): Promise<void>;
  reload(user: User): Promise<void>;
  externalTransfer(): Promise<void>;
  reset(user: User): Promise<void>;
}

/** Two independent users, real transactions, and no generated contacts or activity. */
export async function canonicalScenario(driver: ScenarioDriver) {
  await driver.start("a");
  await driver.start("b");
  await driver.expectState("a", "100", 0);
  await driver.expectState("b", "100", 0);
  await driver.payment("a", "Send", "7");
  await driver.expectState("a", "93", 1);
  await driver.expectState("b", "107", 1);
  await driver.payment("b", "Request", "20");
  await driver.resolve("a", "Approve");
  await driver.expectState("a", "73", 2);
  await driver.expectState("b", "127", 2);
  await driver.payment("b", "Request", "5");
  await driver.resolve("a", "Decline");
  await driver.expectState("a", "73", 3);
  await driver.expectState("b", "127", 3);
  await driver.payment("a", "Request", "9");
  await driver.resolve("b", "Approve");
  await driver.expectState("a", "82", 4);
  await driver.expectState("b", "118", 4);
  await driver.reload("a");
  await driver.expectState("a", "82", 4);
  await driver.externalTransfer();
  await driver.expectState("a", "85", 4);
  await driver.expectState("b", "115", 4);
  await driver.reload("b");
  await driver.expectState("b", "115", 4);
  await driver.reset("a");
}
