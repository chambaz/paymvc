import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app";
import { parseDeployment } from "./chain/config";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
async function boot() {
  const response = await fetch(
    import.meta.env.VITE_DEPLOYMENT_URL ?? "/deployment.json",
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("Deployment configuration unavailable.");
  const record = await response.json();
  // VITE_RPC_URL and VITE_APTOS_API_KEY select a keyed Testnet provider; a
  // local node keeps its own URL.
  const testnet = record.network === "testnet";
  const config = parseDeployment(
    record,
    testnet ? import.meta.env.VITE_RPC_URL : undefined,
    testnet ? import.meta.env.VITE_APTOS_API_KEY : undefined,
  );
  const query = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
  });
  root.render(
    <QueryClientProvider client={query}>
      <App config={config} />
    </QueryClientProvider>,
  );
}
void boot().catch(() =>
  root.render(
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-3xl tracking-tight">PayMVC</h1>
      <p role="alert">
        This deployment is not available yet. Check the deployment configuration
        and reload.
      </p>
      <p>No wallets have been created or funded.</p>
    </main>,
  ),
);
