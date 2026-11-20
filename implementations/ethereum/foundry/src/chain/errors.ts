import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  decodeErrorResult,
  type Hex,
} from "viem";
import { creditsAbi } from "./generated/creditsAbi";
import { paymvcAbi } from "./generated/paymvcAbi";

/** Messages for the custom errors in contracts/PayMVC.sol and OpenZeppelin's ERC-20. */
const contractErrors: Record<string, string> = {
  NotRegistered: "Choose a different, registered PayMVC account.",
  InvalidParticipants: "Choose a different, registered PayMVC account.",
  InvalidAmount: "Enter a whole amount from 1 to 1,000,000.",
  OperationUsed: "This operation is already recorded. Refresh to see it.",
  NotFound: "This request was not found. Refresh and try again.",
  Unauthorized: "Only the requested payer can respond to this request.",
  NotPending: "This request has already been resolved. Refresh its status.",
  ERC20InsufficientBalance:
    "Not enough demo credits. No payment was completed.",
};

/** The name of the contract error in a revert, if the RPC returned its data. */
function revertName(error: BaseError) {
  const decoded = error.walk(
    (cause) => cause instanceof ContractFunctionRevertedError,
  );
  if (decoded instanceof ContractFunctionRevertedError)
    return decoded.data?.errorName;
  // Gas estimation has no ABI, so the RPC error holds only the raw revert data.
  const raw = error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    return typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data);
  }) as { data: Hex } | null;
  if (!raw) return undefined;
  try {
    return decodeErrorResult({
      abi: [...paymvcAbi, ...creditsAbi],
      data: raw.data,
    }).errorName;
  } catch {
    return undefined;
  }
}

/** Turn an error into a short message for the user. Never includes RPC URLs or signed data. */
export function readableError(error: unknown) {
  if (error instanceof BaseError) {
    const name = revertName(error);
    if (name && contractErrors[name]) return contractErrors[name];
    if (error.walk((cause) => cause instanceof InsufficientFundsError))
      return "This wallet needs more native tokens for fees. Fund its address and retry.";
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
    return "The RPC could not complete this step. Your progress is saved. Retry to check the original transactions.";
  }
  return error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
}
