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
  stale?: boolean;
  readOnly?: boolean;
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
        : "Your last operation is unresolved. Recheck it, or dismiss it to continue."
      : "");
  const visible = Boolean(
    props.message || props.stale || props.readOnly || problem,
  );
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
      {props.stale ? (
        <Alert role="status">
          <AlertTitle>Balance may be out of date</AlertTitle>
          <AlertDescription>
            The latest read failed. Your previous balance is retained. Refresh
            to check again.
          </AlertDescription>
        </Alert>
      ) : null}
      {props.readOnly ? (
        <Alert role="status">
          <AlertTitle>Read-only tab</AlertTitle>
          <AlertDescription>
            Another tab owns this demo, or browser locking is unavailable. Close
            the other tab and reload to make payments here.
          </AlertDescription>
        </Alert>
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
            Recheck original operation
          </Button>
          {!props.unknown ? (
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
