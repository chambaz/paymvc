import { BaseError, HttpRequestError, TimeoutError } from "viem";

/** Turn an error into a short message for the user. Never includes RPC URLs or signed data. */
export function readableError(error: unknown) {
  if (error instanceof BaseError) {
    const transport = error.walk(
      (cause) =>
        cause instanceof HttpRequestError || cause instanceof TimeoutError,
    );
    if (transport instanceof HttpRequestError && transport.status === 429)
      return "The RPC is rate-limiting requests. Your progress is saved. Wait a moment, then retry.";
    if (transport instanceof TimeoutError)
      return "The RPC did not respond in time. Your progress is saved. Retry to check the same transactions.";
    if (
      transport instanceof HttpRequestError &&
      transport.status &&
      transport.status >= 500
    )
      return "The RPC is temporarily unavailable. Your progress is saved. Retry when it responds.";
    // Custom errors from contracts/PayMVC.sol and OpenZeppelin's ERC-20.
    const text = error.message;
    if (/InvalidParticipants|NotRegistered/.test(text))
      return "Choose a different, registered PayMVC account.";
    if (/InsufficientBalance/.test(text))
      return "Not enough demo credits. No payment was completed.";
    if (/insufficient funds/i.test(text))
      return "This wallet needs more native tokens for fees. Fund its address and retry.";
    if (/NotPending/.test(text))
      return "This request has already been resolved. Refresh its status.";
    return "The RPC could not complete this step. Your progress is saved. Retry to check the original transactions.";
  }
  return error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
}
