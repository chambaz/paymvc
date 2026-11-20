import { RefreshCwIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export type PaymentMode = "send" | "request";

/**
 * One dialog for Send and Request. The parent owns the field values, so that
 * they survive an error and a mode change.
 */
export function PaymentDialog(props: {
  mode: PaymentMode | null;
  recipient: string;
  amount: string;
  busy: boolean;
  disabled: boolean;
  message: string;
  error: string;
  onMode: (mode: PaymentMode | null) => void;
  onRecipient: (value: string) => void;
  onAmount: (value: string) => void;
  onSubmit: () => void;
  /** Returns focus to the control that opened the dialog. */
  onCloseFocus: () => void;
}) {
  const send = props.mode === "send";
  return (
    <Dialog
      open={props.mode !== null}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onMode(null);
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.onCloseFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{send ? "Send a little" : "Make a request"}</DialogTitle>
          <DialogDescription>
            {send
              ? "Send demo credits to someone in your payment world."
              : "Ask for demo credits. Nothing moves until the payer approves."}
          </DialogDescription>
        </DialogHeader>
        <ToggleGroup
          type="single"
          variant="outline"
          value={props.mode ?? "send"}
          aria-label="Payment action"
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value === "send" || value === "request") props.onMode(value);
          }}
        >
          <ToggleGroupItem value="send">Send</ToggleGroupItem>
          <ToggleGroupItem value="request">Request</ToggleGroupItem>
        </ToggleGroup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="recipient">Recipient address</FieldLabel>
              <Input
                id="recipient"
                name="recipient"
                value={props.recipient}
                onChange={(event) => props.onRecipient(event.target.value)}
                placeholder="Paste a registered wallet address"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={props.disabled}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="amount">Amount</FieldLabel>
              <Input
                id="amount"
                name="amount"
                inputMode="numeric"
                value={props.amount}
                onChange={(event) => props.onAmount(event.target.value)}
                placeholder="0"
                disabled={props.disabled}
                required
              />
            </Field>
            {props.error ? (
              <p role="alert" className="text-base text-destructive sm:text-sm">
                {props.error}
              </p>
            ) : null}
            {/* Always mounted, so that screen readers announce each step. */}
            <p
              role="status"
              className={
                props.busy
                  ? "text-base text-muted-foreground sm:text-sm"
                  : "sr-only"
              }
            >
              {props.busy ? (
                <>
                  <RefreshCwIcon
                    aria-hidden="true"
                    className="mr-2 inline size-4 motion-safe:animate-spin"
                  />
                  {props.message ||
                    (send ? "Sending your credits…" : "Creating your request…")}
                </>
              ) : null}
            </p>
            <Button type="submit" disabled={props.disabled}>
              {send ? "Send credits" : "Create request"}
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
