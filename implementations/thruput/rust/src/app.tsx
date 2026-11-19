import { useState } from "react";
import {
  formatNative,
  normalizeAddress,
  type Deployment,
} from "./chain/config";
import { accountFor, operationId, parseAmount } from "./chain/session";
import { useDemo } from "./hooks/use-demo";
import { PaymentsView, type Row } from "./components/payments-view";

export function App({ config }: { config: Deployment }) {
  const demo = useDemo(config);
  const [validation, setValidation] = useState("");
  const session = demo.session;
  const visitor = session ? accountFor(session).address : "";
  const contacts = demo.contactAddresses.map((address) => ({ address }));
  const rows: Row[] = (demo.dashboard.data?.entries ?? []).map((entry) => {
    const isFromVisitor = entry.from === visitor;
    const counterparty = isFromVisitor ? entry.to : entry.from;
    const request = entry.kind === 1;
    return {
      id: entry.id,
      address: counterparty,
      amount: entry.amount.toString(),
      request,
      incoming: request ? isFromVisitor : !isFromVisitor,
      state: request
        ? ["Pending", "Paid", "Declined"][entry.state]!
        : "Confirmed",
    };
  });
  if (!demo.loaded)
    return (
      <main className="p-8">
        <p role="status">Restoring your demo…</p>
      </main>
    );
  return (
    <PaymentsView
      network={config.network === "localnet" ? "Local node" : "Futurenet"}
      implementation="thruput"
      nativeSymbol="native tokens"
      ready={session?.ready ?? false}
      started={Boolean(session)}
      resetAvailable={demo.corrupt}
      address={visitor}
      balance={demo.dashboard.data?.balance.toString()}
      contacts={contacts}
      contactsLoading={demo.contacts.isFetching}
      contactsError={demo.contacts.isError}
      hasMoreContacts={demo.contacts.hasNextPage}
      onMoreContacts={() => {
        void demo.contacts.fetchNextPage();
      }}
      rows={rows}
      busy={demo.busy}
      readOnly={!demo.writer}
      message={demo.message}
      error={validation || demo.error}
      stale={demo.dashboard.isError}
      pending={Boolean(session?.intent)}
      pendingRequestId={
        session?.intent &&
        ["approve", "decline"].includes(session.intent.action)
          ? session.intent.id
          : undefined
      }
      unknown={demo.unknown}
      hasMore={Boolean(
        demo.dashboard.data && BigInt(rows.length) < demo.dashboard.data.count,
      )}
      faucetUrl={config.faucetUrl}
      fundingAmount={
        demo.funding.data
          ? formatNative(config, demo.funding.data.required)
          : undefined
      }
      fundingReceived={Boolean(
        demo.funding.data &&
        demo.funding.data.balance >= demo.funding.data.required,
      )}
      setupStarted={
        !session?.ready && Object.keys(session?.journal ?? {}).length > 0
      }
      onStart={() => {
        setValidation("");
        return demo.start();
      }}
      onSubmit={async (action, recipient, input) => {
        setValidation("");
        try {
          const amount = parseAmount(input);
          recipient = normalizeAddress(recipient);
          if (recipient === visitor)
            throw new Error("Choose someone other than yourself.");
          return await demo.act({
            action,
            recipient,
            amount: amount.toString(),
            id: "",
            operation: operationId(),
          });
        } catch (error) {
          setValidation(
            error instanceof Error ? error.message : "Check the form.",
          );
          return false;
        }
      }}
      onResolve={(id, action) => {
        setValidation("");
        const entry = demo.dashboard.data?.entries.find(
          (entry) => entry.id === id,
        );
        if (!entry || !session) return;
        if (entry.to !== visitor) return;
        void demo.act({
          action,
          recipient: entry.from,
          amount: entry.amount.toString(),
          id,
          operation: operationId(),
        });
      }}
      onRetry={() => {
        if (session?.intent) void demo.act(session.intent);
      }}
      onDismiss={demo.dismissFailed}
      onReset={() => {
        setValidation("");
        demo.reset();
      }}
      onRefresh={() => {
        void demo.refresh();
      }}
      onMore={demo.more}
    />
  );
}
