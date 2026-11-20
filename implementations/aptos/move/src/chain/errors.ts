/** Messages for the error constants in contracts/sources/paymvc.move. */
const contractErrors: Record<string, string> = {
  E_ALREADY_REGISTERED: "This wallet is already registered.",
  E_NOT_REGISTERED: "Choose a different, registered PayMVC account.",
  E_INVALID_PARTICIPANTS: "Choose a different, registered PayMVC account.",
  E_INVALID_AMOUNT: "Enter a whole amount from 1 to 1,000,000.",
  E_INVALID_OPERATION:
    "The operation ID is invalid. Start the operation again.",
  E_OPERATION_USED: "This operation is already recorded. Refresh to see it.",
  E_NOT_FOUND: "This request was not found. Refresh and try again.",
  E_UNAUTHORIZED: "Only the requested payer can respond to this request.",
  E_NOT_PENDING: "This request has already been resolved. Refresh its status.",
};

/**
 * The message for a failed simulation. Nothing was signed, so nothing changed. The node
 * reports a PayMVC abort as "Move abort in 0x…::paymvc: E_NAME(0x2): …".
 */
export function simulationError(vmStatus: string) {
  const name = /::paymvc: (E_[A-Z_]+)\(/.exec(vmStatus)?.[1];
  if (name && contractErrors[name]) return contractErrors[name];
  if (/INSUFFICIENT_BALANCE/.test(vmStatus))
    return "Not enough demo credits or APT for gas. Nothing was sent.";
  return "The transaction would fail on-chain. Nothing was sent. Refresh and retry.";
}

/** Turn an error into a short message for the user. The chain module's errors already carry user-facing text. */
export function readableError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
}
