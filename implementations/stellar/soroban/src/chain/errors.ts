/** Messages for contract error codes. contracts/credits numbers its errors from 100. */
const contractErrors: Record<number, string> = {
  1: "This wallet is already registered.",
  2: "Choose a different, registered PayMVC account.",
  3: "Choose a different, registered PayMVC account.",
  4: "Enter a whole amount from 1 to 1,000,000.",
  5: "The operation ID is invalid. Start the operation again.",
  6: "This operation is already recorded. Refresh to see it.",
  7: "This request was not found. Refresh and try again.",
  8: "Only the requested payer can respond to this request.",
  9: "This request has already been resolved. Refresh its status.",
  101: "Not enough demo credits. No payment was completed.",
};

/**
 * The message for a failed simulation. Nothing was signed, so nothing changed. The RPC
 * reports a contract error as `Error(Contract, #code)`.
 */
export function simulationError(detail: string) {
  const code = /Error\(Contract, #(\d+)\)/.exec(detail)?.[1];
  return (
    (code && contractErrors[Number(code)]) ??
    "The contract could not prepare this step. Check credits and XLM funding, then retry."
  );
}

/** Turn an error into a short message for the user. The chain module's errors already carry user-facing text. */
export function readableError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
}
