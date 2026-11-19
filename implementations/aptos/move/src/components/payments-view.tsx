import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CircleUserRoundIcon,
  RefreshCwIcon,
} from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { FieldGroup } from "./ui/field";
import { Separator } from "./ui/separator";
import { CopyAddress, shortAddress } from "./address";
import { EntrySummary, type Row } from "./entry-summary";
import { Feedback } from "./feedback";
import { PaymentDialog, type PaymentMode } from "./payment-dialog";
import { ResetDialog } from "./reset-dialog";

export { shortAddress, type Row };

/** The project landing page, linked from the logo. */
const landingUrl = import.meta.env.VITE_LANDING_URL || "http://127.0.0.1:5170";

/**
 * Every implementation, in selector order. `url` opens that implementation.
 * Hosted builds set the VITE_*_URL variables.
 */
export const implementations = [
  {
    id: "ethereum",
    name: "Ethereum",
    framework: "Foundry",
    url:
      import.meta.env.VITE_ETHEREUM_URL ||
      "http://127.0.0.1:5173?network=ethereum",
  },
  {
    id: "base",
    name: "Base",
    framework: "Foundry",
    url: import.meta.env.VITE_BASE_URL || "http://127.0.0.1:5177?network=base",
  },
  {
    id: "robinhood",
    name: "Robinhood",
    framework: "Foundry",
    url:
      import.meta.env.VITE_ROBINHOOD_URL ||
      "http://127.0.0.1:5187?network=robinhood",
  },
  {
    id: "monad",
    name: "Monad",
    framework: "Foundry",
    url:
      import.meta.env.VITE_MONAD_URL || "http://127.0.0.1:5179?network=monad",
  },
  {
    id: "solana",
    name: "Solana",
    framework: "Anchor",
    url: import.meta.env.VITE_SOLANA_URL || "http://127.0.0.1:5175",
  },
  {
    id: "sui",
    name: "Sui",
    framework: "Move",
    url: import.meta.env.VITE_SUI_URL || "http://127.0.0.1:5183",
  },
  {
    id: "aptos",
    name: "Aptos",
    framework: "Move",
    url: import.meta.env.VITE_APTOS_URL || "http://127.0.0.1:5185",
  },
  {
    id: "stellar",
    name: "Stellar",
    framework: "Soroban",
    url: import.meta.env.VITE_STELLAR_URL || "http://127.0.0.1:5181",
  },
  {
    id: "thruput",
    name: "Thruput",
    framework: "Rust",
    url: import.meta.env.VITE_THRUPUT_URL || "http://127.0.0.1:5189",
  },
] as const;
export type ImplementationId = (typeof implementations)[number]["id"];

export interface Contact {
  address: string;
}
export interface ViewProps {
  network: string;
  implementation: ImplementationId;
  /** The native fee token, for example "ETH". */
  nativeSymbol: string;
  ready: boolean;
  started: boolean;
  resetAvailable?: boolean;
  address: string;
  balance?: string;
  contacts: Contact[];
  contactsLoading?: boolean;
  contactsError?: boolean;
  hasMoreContacts?: boolean;
  onMoreContacts: () => void;
  rows: Row[];
  busy: boolean;
  readOnly: boolean;
  message: string;
  error: string;
  stale: boolean;
  pending: boolean;
  pendingRequestId?: string;
  unknown: boolean;
  hasMore: boolean;
  loadingMore?: boolean;
  faucetUrl: string;
  fundingAmount?: string;
  fundingReceived?: boolean;
  setupStarted?: boolean;
  onStart: () => Promise<unknown>;
  onSubmit: (
    mode: PaymentMode,
    recipient: string,
    amount: string,
  ) => Promise<boolean>;
  onResolve: (id: string, action: "approve" | "decline") => void;
  onRetry: () => void;
  onDismiss: () => void;
  onReset: () => void;
  onRefresh: () => void;
  onMore: () => void;
}

export function PaymentsView(props: ViewProps) {
  const current = implementations.find(
    (item) => item.id === props.implementation,
  )!;
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<PaymentMode | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [selectedRequest, setSelectedRequest] = useState<string>();
  const activeRequest = props.pendingRequestId ?? selectedRequest;
  const disabled = props.busy || props.readOnly || props.pending;
  const requests = props.rows.filter(
    (row) =>
      row.request && (row.state === "Pending" || row.id === activeRequest),
  );
  const recovery = {
    busy: props.busy,
    error: props.error,
    pending: props.pending,
    unknown: props.unknown,
    onRetry: props.onRetry,
    onDismiss: props.onDismiss,
  };
  // A reset removes the dialog's trigger, so focus moves to the next step.
  const createButton = useRef<HTMLButtonElement>(null);
  const resetting = useRef(false);
  useEffect(() => {
    if (!resetting.current || !createButton.current) return;
    resetting.current = false;
    createButton.current.focus();
  });
  // The dialog and the request rows show their own progress and errors.
  const elsewhere = Boolean(activeRequest || mode);
  function open(next: PaymentMode, address = "") {
    dialogTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMode(next);
    setSelectedRequest(undefined);
    setRecipient(address);
    setAmount("");
  }
  return (
    <div className="isolate min-h-dvh">
      <header className="border-b py-5">
        <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-4 px-5 sm:flex sm:px-8">
          <a
            href={landingUrl}
            aria-label="PayMVC. Homepage"
            className="text-3xl font-semibold tracking-tight"
          >
            paymvc<span className="text-primary">.</span>
          </a>
          <div className="sm:order-last">
            <ThemeToggle />
          </div>
          <div className="col-span-2 flex items-center gap-3 sm:ml-auto">
            <label className="sr-only" htmlFor="implementation">
              Implementation
            </label>
            <select
              id="implementation"
              name="implementation"
              className="h-9 max-w-48 rounded-md border bg-background px-2 text-base sm:text-sm"
              defaultValue={current.id}
              disabled={props.busy}
              onChange={(event) => {
                const next = implementations.find(
                  (item) => item.id === event.target.value,
                );
                if (next && next.id !== current.id)
                  window.location.assign(next.url);
              }}
            >
              {implementations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.framework}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
        {!props.ready ? (
          <section className="mx-auto w-full max-w-md">
            <section
              className="flex flex-col gap-6 rounded-xl border p-6 sm:p-8"
              aria-label="Set up your demo"
            >
              <div>
                <h1 className="text-xl">Your own little payment world</h1>
                <p className="pt-2 text-base text-muted-foreground sm:text-sm">
                  {props.network} · {current.name} / {current.framework}
                </p>
              </div>
              {!props.started ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void props.onStart();
                  }}
                >
                  <FieldGroup>
                    <Button
                      ref={createButton}
                      type="submit"
                      disabled={props.busy || props.readOnly}
                    >
                      Create demo wallet{" "}
                      <ArrowUpRightIcon data-icon="inline-end" />
                    </Button>
                  </FieldGroup>
                </form>
              ) : (
                <div className="flex flex-col gap-5">
                  {!props.setupStarted && !props.busy ? (
                    <p className="text-base sm:text-sm">
                      {props.fundingReceived
                        ? "Funding received. Click Start demo to set up your payment world."
                        : props.fundingAmount
                          ? `Request at least ${props.fundingAmount} testnet ${props.nativeSymbol} for registration and transaction fees.`
                          : "Checking the current funding budget. If the network is unavailable, try Start demo again."}
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-2 rounded-lg bg-muted p-4">
                    <p className="text-base font-medium sm:text-sm">
                      {props.setupStarted || props.fundingReceived
                        ? "Your demo wallet"
                        : "Wallet to fund"}
                    </p>
                    <CopyAddress address={props.address} format="full" />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={props.busy || props.readOnly}
                    onClick={() => void props.onStart()}
                  >
                    Start demo
                  </Button>
                  <a
                    className="text-sm text-primary underline underline-offset-4"
                    href={props.faucetUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open manual faucet
                  </a>
                </div>
              )}
              <Feedback
                {...recovery}
                message={props.message}
                stale={props.stale}
                readOnly={props.readOnly}
              />
            </section>
          </section>
        ) : (
          <>
            <Feedback
              {...recovery}
              message={
                !elsewhere && props.busy
                  ? props.message ||
                    (props.pending ? "Checking your saved operation…" : "")
                  : ""
              }
              error={elsewhere ? "" : props.error}
              pending={elsewhere ? false : props.pending}
              stale={props.stale}
              readOnly={props.readOnly}
            />
            <section className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h1 className="text-3xl tracking-tight">
                Your wallet{" "}
                <span className="ml-2 font-normal" title={props.address}>
                  {shortAddress(props.address)}
                </span>
              </h1>
              <div className="flex items-center gap-2">
                <CopyAddress address={props.address} format="icon" />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh"
                  title="Refresh"
                  disabled={props.busy}
                  onClick={props.onRefresh}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                </Button>
              </div>
            </section>
            <section
              className="flex flex-wrap items-end justify-between gap-6 border-b pb-9"
              aria-label="Balance"
            >
              <div className="flex flex-col gap-3">
                <p className="text-base text-muted-foreground sm:text-sm">
                  Demo credits
                </p>
                <p
                  data-testid="balance"
                  className="text-6xl font-medium tracking-tight tabular-nums"
                >
                  {props.balance ?? "—"}
                </p>
              </div>
              <div className="flex gap-3">
                <Button disabled={disabled} onClick={() => open("send")}>
                  <ArrowUpRightIcon data-icon="inline-start" />
                  Send
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => open("request")}
                >
                  <ArrowDownLeftIcon data-icon="inline-start" />
                  Request
                </Button>
              </div>
            </section>
            <section
              className="flex flex-col gap-5"
              aria-labelledby="contacts-title"
            >
              <h2 id="contacts-title" className="text-lg">
                Your contacts
              </h2>
              <ul role="list" className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {props.contacts.map((contact) => (
                  <li
                    key={contact.address}
                    className="flex min-w-0 flex-col items-start gap-2"
                  >
                    <Button
                      variant="ghost"
                      className="h-auto gap-3 py-2"
                      disabled={disabled}
                      title={contact.address}
                      aria-label={`Send to ${shortAddress(contact.address)} (${contact.address})`}
                      onClick={() => open("send", contact.address)}
                    >
                      <CircleUserRoundIcon
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      {shortAddress(contact.address)}
                    </Button>
                  </li>
                ))}
              </ul>
              {props.contactsError ? (
                <p role="alert">
                  Contacts could not be refreshed. Try Refresh again.
                </p>
              ) : null}
              {!props.contacts.length &&
              !props.contactsLoading &&
              !props.contactsError ? (
                <p className="text-muted-foreground">
                  No other registered wallets yet.
                </p>
              ) : null}
              {props.hasMoreContacts || props.contactsLoading ? (
                <Button
                  variant="link"
                  disabled={props.contactsLoading || disabled}
                  onClick={props.onMoreContacts}
                  aria-live="polite"
                  aria-busy={props.contactsLoading}
                >
                  {props.contactsLoading
                    ? "Loading contacts…"
                    : "Load more contacts"}
                </Button>
              ) : null}
            </section>
            <Separator className="border-t bg-transparent data-[orientation=horizontal]:h-0" />
            <div className="grid gap-10 md:grid-cols-2 md:gap-12">
              <section
                className="flex min-w-0 flex-col gap-7"
                aria-labelledby="activity-title"
              >
                <div className="flex flex-col gap-1">
                  <h2 id="activity-title" className="text-lg">
                    Activity
                  </h2>
                  <p className="text-base text-muted-foreground sm:text-sm">
                    Payments and requests made here.
                  </p>
                </div>
                {props.rows.length ? (
                  <ul role="list" className="divide-y divide-border">
                    {props.rows.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 py-4 first:pt-0"
                        data-testid="activity-row"
                      >
                        <EntrySummary
                          row={row}
                          disabled={disabled}
                          onSelect={() => open("send", row.address)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-base text-muted-foreground sm:text-sm">
                    No payments or requests yet.
                  </p>
                )}
                {props.hasMore ? (
                  <Button
                    variant="link"
                    disabled={props.loadingMore}
                    aria-live="polite"
                    aria-busy={props.loadingMore}
                    onClick={props.onMore}
                  >
                    {props.loadingMore ? "Loading…" : "Load more"}
                  </Button>
                ) : null}
              </section>
              <section
                className="flex flex-col gap-7"
                aria-labelledby="requests-title"
              >
                <div className="flex flex-col gap-1">
                  <h2 id="requests-title" className="text-lg">
                    Pending requests
                  </h2>
                  <p className="text-base text-muted-foreground sm:text-sm">
                    Requests waiting for a response.
                  </p>
                </div>
                {requests.length === 0 ? (
                  <p className="text-base text-muted-foreground sm:text-sm">
                    No pending requests.
                  </p>
                ) : (
                  <ul role="list" className="divide-y divide-border">
                    {requests.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 py-4 first:pt-0"
                      >
                        <EntrySummary
                          row={row}
                          disabled={disabled}
                          onSelect={() => open("send", row.address)}
                        />
                        {/* Mounted for every row, so that its first progress text is announced. */}
                        <Feedback
                          {...recovery}
                          error={row.id === activeRequest ? props.error : ""}
                          pending={row.id === activeRequest && props.pending}
                          message={
                            row.id !== activeRequest
                              ? ""
                              : props.busy
                                ? props.message ||
                                  "Updating this request. Please wait…"
                                : row.state === "Paid"
                                  ? "Payment complete."
                                  : row.state === "Declined"
                                    ? "Request declined."
                                    : ""
                          }
                        />
                        {row.state !== "Pending" ? null : !row.incoming ? (
                          <div className="flex gap-3">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={disabled}
                              onClick={() => {
                                setSelectedRequest(row.id);
                                props.onResolve(row.id, "approve");
                              }}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={disabled}
                              onClick={() => {
                                setSelectedRequest(row.id);
                                props.onResolve(row.id, "decline");
                              }}
                            >
                              Decline
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
        {props.started || props.resetAvailable ? (
          <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-3 text-base text-muted-foreground sm:text-sm">
            <ResetDialog
              disabled={props.busy || props.readOnly}
              onReset={() => {
                resetting.current = true;
                props.onReset();
              }}
            />
          </footer>
        ) : null}
      </main>
      <PaymentDialog
        mode={mode}
        recipient={recipient}
        amount={amount}
        busy={props.busy}
        disabled={disabled}
        message={props.message}
        error={props.error}
        onMode={setMode}
        onRecipient={setRecipient}
        onAmount={setAmount}
        onSubmit={() => {
          if (mode)
            void props.onSubmit(mode, recipient, amount).then((ok) => {
              if (ok) setMode(null);
            });
        }}
        onCloseFocus={() => dialogTrigger.current?.focus()}
      />
    </div>
  );
}
