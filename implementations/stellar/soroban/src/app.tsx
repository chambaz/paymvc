import { useState } from "react";
import { formatNative, type Deployment } from "./chain/config";
import {
  accountFor,
  isAddress,
  operationId,
  parseAmount,
} from "./chain/session";
import { useDemo } from "./hooks/use-demo";
import { PaymentsView, type Row } from "./components/payments-view";

export function App({ config }: { config: Deployment }) {
  const demo = useDemo(config);
  const [validation, setValidation] = useState("");
  const session = demo.session;
  const visitor = session ? accountFor(session).address : "";
  const journal = session?.journal ?? {};
  const records = Object.values(journal);
  const contacts = [
    ...new Set(
      demo.contacts.data?.pages.flatMap((page) => page.addresses) ?? [],
    ),
  ].map((address) => ({ address }));
  const rows: Row[] = (demo.dashboard.data?.entries ?? []).map((entry) => {
    const isFromVisitor = entry.from === visitor;
    const counterparty = isFromVisitor ? entry.to : entry.from;
    const request = entry.kind === "Request";
    return {
      id: entry.id,
      address: counterparty,
      amount: entry.amount.toString(),
      request,
      incoming: request ? isFromVisitor : !isFromVisitor,
      state: request ? entry.state : "Confirmed",
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
      network={config.network === "localnet" ? "Local validator" : "Testnet"}
      implementation="stellar"
      nativeSymbol="XLM"
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
      faucetUrl={`${config.faucetUrl}?addr=${visitor}`}
      fundingAmount={
        demo.funding.data
          ? formatNative(config, demo.funding.data.required)
          : undefined
      }
      fundingReceived={Boolean(
        demo.funding.data &&
        demo.funding.data.balance >= demo.funding.data.required,
      )}
      setupStarted={!session?.ready && records.length > 0}
      onStart={() => {
        setValidation("");
        return demo.start();
      }}
      onSubmit={async (action, recipient, input) => {
        setValidation("");
        try {
          const amount = parseAmount(input);
          if (!isAddress(recipient))
            throw new Error(
              "Enter a valid Stellar account or contract address.",
            );
          if (recipient === visitor)
            throw new Error("Choose someone other than yourself.");
          return await demo.act({
            action,
            recipient,
            amount: amount.toString(),
            id: "0",
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
