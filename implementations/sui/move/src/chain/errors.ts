/** Messages for the abort codes in contracts/sources/paymvc.move. */
const abortCodes: Record<number, string> = {
  1: "This wallet is already registered.",
  2: "Choose a different, registered PayMVC account.",
  3: "Choose a different, registered PayMVC account.",
  4: "Enter a whole amount from 1 to 1,000,000.",
  5: "The operation ID is invalid. Start the operation again.",
  6: "This operation is already recorded. Refresh to see it.",
  7: "This request was not found. Refresh and try again.",
  8: "Only the requested payer can respond to this request.",
  9: "This request has already been resolved. Refresh its status.",
};

/** Turn an error into a short message for the user. The chain module's errors already carry user-facing text. */
export function readableError(error: unknown) {
  if (!(error instanceof Error))
    return "This step could not be completed. Please retry.";
  // The SDK reports a Move abort as "MoveAbort …, abort code: N, in '0x…::paymvc::…'".
  const abort = /abort code: (\d+), in '0x[0-9a-f]+::paymvc::/.exec(
    error.message,
  );
  const failed =
    "The transaction would fail on-chain. Nothing was sent. Check your credits and SUI, then retry.";
  if (abort) return abortCodes[Number(abort[1])] ?? failed;
  if (/MoveAbort/.test(error.message)) return failed;
  return error.message;
}
