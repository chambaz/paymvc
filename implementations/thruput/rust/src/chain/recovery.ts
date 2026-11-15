/** One automatic recheck; further recovery requires an explicit user action. */
export async function recheckOnce(
  task: () => Promise<void>,
  retryable: (error: unknown) => boolean,
  report: () => void,
  active: () => boolean,
) {
  try {
    await task();
  } catch (error) {
    if (!retryable(error) || !active()) throw error;
    report();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (!active()) throw error;
    await task();
  }
}
