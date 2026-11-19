import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PaymentsView, type ViewProps } from "./components/payments-view";
import { Button } from "./components/ui/button";
import "./styles.css";

// Development-only entry. Vite builds index.html, so this fixture is not a production fallback.
const states = [
  "entry",
  "funding",
  "setup",
  "dashboard",
  "100-contacts",
  "empty",
  "outgoing",
  "pending",
  "unknown",
  "failed",
  "stale",
  "read-only",
] as const;
type State = (typeof states)[number];
const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
const contacts = Array.from({ length: 8 }, (_, index) => ({
  address: address(index + 2),
}));
const manyContacts = Array.from({ length: 100 }, (_, index) => ({
  address: `0x${(BigInt(index + 2) * 0x9e3779b97f4a7c15n).toString(16).padStart(40, "0")}`,
}));
const requestedState = new URLSearchParams(location.search).get("state");
const initialState =
  states.find((state) => state === requestedState) ?? "dashboard";

function Reference() {
  const [state, setState] = useState<State>(initialState);
  const [contactLimit, setContactLimit] = useState(5);
  const availableContacts = state === "100-contacts" ? manyContacts : contacts;
  const props: ViewProps = {
    network: "UI fixture",
    implementation: "ethereum",
    nativeSymbol: "ETH",
    ready: !["entry", "funding", "setup"].includes(state),
    started: state !== "entry",
    address: address(1),
    balance: "100",
    contacts: state === "empty" ? [] : availableContacts.slice(0, contactLimit),
    hasMoreContacts:
      state !== "empty" && contactLimit < availableContacts.length,
    onMoreContacts: () =>
      setContactLimit((limit) => Math.min(limit + 5, availableContacts.length)),
    rows:
      state === "empty"
        ? []
        : [
            {
              id: "3",
              address: address(4),
              amount: "5",
              state: "Pending",
              incoming: state === "outgoing",
              request: true,
            },
            {
              id: "2",
              address: address(3),
              amount: "20",
              state: "Pending",
              incoming: state === "outgoing",
              request: true,
            },
            {
              id: "1",
              address: address(2),
              amount: "10",
              state: "Confirmed",
              incoming: true,
              request: false,
            },
          ],
    busy: state === "pending" || state === "setup",
    readOnly: state === "read-only",
    message:
      state === "pending"
        ? "Updating this request. Please wait…"
        : state === "setup"
          ? "Registering your wallet"
          : "",
    error:
      state === "unknown"
        ? "Outcome unknown. Recheck the original transaction before continuing."
        : state === "failed"
          ? "Not enough demo credits. No payment was completed."
          : "",
    stale: state === "stale",
    pending: ["pending", "unknown", "failed"].includes(state),
    pendingRequestId: ["pending", "unknown", "failed"].includes(state)
      ? "2"
      : undefined,
    unknown: state === "unknown",
    hasMore: false,
    faucetUrl:
      "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
    fundingAmount: "0.0005",
    setupStarted: state === "setup",
    fundingReceived: state === "setup",
    onStart: async () => {
      setState(state === "entry" ? "funding" : "setup");
    },
    // Forms are inspectable, but this entry never simulates a successful payment.
    onSubmit: async () => false,
    onResolve: () => setState("pending"),
    onRetry: () => setState("pending"),
    onDismiss: () => setState("dashboard"),
    onReset: () => setState("entry"),
    onRefresh: () => setState("dashboard"),
    onMore: () => {},
  };
  return (
    <>
      <aside className="flex flex-wrap items-center justify-center gap-4 bg-secondary p-4">
        <p className="text-sm">
          UI fixture · no wallets, RPC calls, or transactions
        </p>
        <label htmlFor="fixture-state">Preview state</label>
        <select
          id="fixture-state"
          className="rounded-md border bg-background p-2"
          value={state}
          onChange={(event) => {
            setState(event.target.value as State);
            setContactLimit(5);
          }}
        >
          {states.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        {state === "100-contacts" ? (
          <>
            <span className="text-sm">
              {Math.min(contactLimit, 100)} of 100 fake contacts
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setContactLimit(100)}
            >
              Show all 100
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setContactLimit(5)}
            >
              Reset pagination
            </Button>
          </>
        ) : null}
      </aside>
      <PaymentsView key={state} {...props} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Reference />);
