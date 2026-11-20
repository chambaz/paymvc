import { RefreshCwIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

export interface FeedbackProps {
  /** Progress text. Shown while `busy`, and after it when the caller sets it. */
  message: string;
  busy: boolean;
  error: string;
  pending: boolean;
  unknown: boolean;
  /** The operation has no unconfirmed transaction, so it may be dismissed. */
  dismissible: boolean;
  /** A signed transaction is saved, so a recheck checks it instead of signing a new one. */
  saved: boolean;
  stale?: boolean;
  readOnly?: boolean;
  /** Show the stale and read-only notices here. One place on the page shows them. */
  notices?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

/** Progress, notices, errors, and the recovery actions for one place in the view. */
export function Feedback(props: FeedbackProps) {
  // After a reload, an unresolved operation has no error text yet.
  const problem =
    props.error ||
    (props.pending && !props.busy
      ? props.unknown
        ? "The network has not confirmed your last operation. Recheck it before you start another. It will not be sent twice."
        : props.readOnly
          ? "Your last operation is unresolved. Recheck or dismiss it in the tab that owns this demo."
          : props.saved
            ? "Your last operation is unresolved. Recheck it, or dismiss it to continue."
            : "Your last operation failed. Retry it, or dismiss it to continue."
      : "");
  const notices = props.notices ?? true;
  const stale = notices && props.stale;
  const readOnlyNotice = notices && props.readOnly;
  const visible = Boolean(props.message || stale || readOnlyNotice || problem);
  return (
    // The status line stays mounted, so that screen readers announce each change.
    <div className={visible ? "flex flex-col gap-3" : "contents"}>
      <p
        role="status"
        className={
          props.message
            ? "text-base text-muted-foreground sm:text-sm"
            : "sr-only"
        }
      >
        {props.message && props.busy ? (
          <RefreshCwIcon
            aria-hidden="true"
            className="mr-2 inline size-4 motion-safe:animate-spin"
          />
        ) : null}
        {props.message}
      </p>
      {/* Notices also live in a region that is always mounted. */}
      {notices ? (
        <div
          role="status"
          className={
            stale || readOnlyNotice ? "flex flex-col gap-3" : "sr-only"
          }
        >
          {stale ? (
            <Alert role="none">
              <AlertTitle>Balance may be out of date</AlertTitle>
              <AlertDescription>
                The latest read failed. Your previous balance is retained.
                Refresh to check again.
              </AlertDescription>
            </Alert>
          ) : null}
          {readOnlyNotice ? (
            <Alert role="none">
              <AlertTitle>Read-only tab</AlertTitle>
              <AlertDescription>
                Another tab owns this demo, or browser locking is unavailable.
                Close the other tab and reload to make payments here.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <Alert variant="destructive">
          <AlertTitle>
            {props.unknown ? "Outcome unknown" : "A step needs attention"}
          </AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {props.pending && !props.busy ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={props.readOnly}
            onClick={props.onRetry}
          >
            {props.saved ? "Recheck original operation" : "Retry"}
          </Button>
          {!props.unknown && props.dismissible ? (
            <Button
              variant="ghost"
              disabled={props.readOnly}
              onClick={props.onDismiss}
            >
              Dismiss failed operation
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
