import { afterEach, expect, it, vi } from "vitest";
import { recheckOnce } from "../../src/chain/recovery";

afterEach(() => vi.useRealTimers());

it("stops after one automatic recheck and permits explicit recovery", async () => {
  vi.useFakeTimers();
  const failure = new Error("Result still pending");
  const task = vi.fn().mockRejectedValue(failure);
  const report = vi.fn();
  const result = expect(
    recheckOnce(
      task,
      () => true,
      report,
      () => true,
    ),
  ).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await result;
  expect(task).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(1);
  task.mockResolvedValue(undefined);
  await recheckOnce(
    task,
    () => true,
    report,
    () => true,
  );
  expect(task).toHaveBeenCalledTimes(3);
});

it("reports a submission failure without an automatic retry", async () => {
  const failure = new Error("Submission unknown");
  const task = vi.fn().mockRejectedValue(failure);
  const report = vi.fn();
  await expect(
    recheckOnce(
      task,
      () => false,
      report,
      () => true,
    ),
  ).rejects.toBe(failure);
  expect(task).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

it("does not resume writes after the view has unmounted", async () => {
  vi.useFakeTimers();
  let active = true;
  const failure = new Error("Pending");
  const task = vi.fn().mockRejectedValue(failure);
  const result = expect(
    recheckOnce(
      task,
      () => true,
      () => {
        active = false;
      },
      () => active,
    ),
  ).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await result;
  expect(task).toHaveBeenCalledTimes(1);
});
