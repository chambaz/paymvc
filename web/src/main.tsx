import { StrictMode, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ButtonLink } from "./components/button";
import { ThemeToggle } from "./components/theme-toggle";
import ethereum from "./assets/networks/ethereum.svg";
import base from "./assets/networks/base.svg";
import robinhood from "./assets/networks/robinhood.svg";
import monad from "./assets/networks/monad.svg";
import solana from "./assets/networks/solana.svg";
import sui from "./assets/networks/sui.svg";
import aptos from "./assets/networks/aptos.svg";
import stellar from "./assets/networks/stellar.svg";
import github from "./assets/github.svg";
import "./styles.css";

const repository = "https://github.com/chambaz/paymvc";

/**
 * Every network's demo, in the implementations' selector order. Hosted builds set
 * the VITE_*_URL variables; the defaults are the local development ports.
 */
const networks = [
  {
    name: "Ethereum",
    icon: ethereum,
    url:
      import.meta.env.VITE_ETHEREUM_URL ||
      "http://127.0.0.1:5173/?network=ethereum",
  },
  {
    name: "Base",
    icon: base,
    url: import.meta.env.VITE_BASE_URL || "http://127.0.0.1:5177/?network=base",
  },
  {
    name: "Robinhood",
    icon: robinhood,
    url:
      import.meta.env.VITE_ROBINHOOD_URL ||
      "http://127.0.0.1:5187/?network=robinhood",
  },
  {
    name: "Monad",
    icon: monad,
    url:
      import.meta.env.VITE_MONAD_URL || "http://127.0.0.1:5179/?network=monad",
  },
  {
    name: "Solana",
    icon: solana,
    url: import.meta.env.VITE_SOLANA_URL || "http://127.0.0.1:5175",
  },
  {
    name: "Sui",
    icon: sui,
    url: import.meta.env.VITE_SUI_URL || "http://127.0.0.1:5183",
  },
  {
    name: "Aptos",
    icon: aptos,
    url: import.meta.env.VITE_APTOS_URL || "http://127.0.0.1:5185",
  },
  {
    name: "Stellar",
    icon: stellar,
    url: import.meta.env.VITE_STELLAR_URL || "http://127.0.0.1:5181",
  },
  // Project Thruput uses the Stellar mark on its official site.
  {
    name: "Thruput",
    icon: stellar,
    url: import.meta.env.VITE_THRUPUT_URL || "http://127.0.0.1:5189",
  },
];
// Launch Demo opens the first network.
const demoUrl = networks[0]!.url;

function BrandMark({
  src,
  compact = false,
}: {
  src: string;
  compact?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-icon="inline-start"
      className={`${compact ? "size-4" : "size-6"} shrink-0 bg-current [mask-image:var(--brand-mark)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]`}
      style={{ "--brand-mark": `url(${JSON.stringify(src)})` } as CSSProperties}
    />
  );
}

function DemoActions({ placement }: { placement: "header" | "hero" }) {
  const header = placement === "header";
  const size = header ? "default" : "lg";
  return (
    <>
      <ButtonLink
        href={demoUrl}
        size={size}
        variant={header ? "secondary" : "default"}
        className={header ? "max-sm:px-3" : ""}
      >
        Launch Demo
      </ButtonLink>
      <ButtonLink
        href={repository}
        target="_blank"
        rel="noreferrer"
        size={size}
        variant="outline"
        // Small screens show the header button as an icon only.
        className={header ? "max-sm:w-9 max-sm:px-0" : ""}
      >
        <BrandMark src={github} compact />{" "}
        <span className={header ? "max-sm:sr-only" : undefined}>GitHub</span>
      </ButtonLink>
    </>
  );
}

function LandingPage() {
  return (
    <div className="isolate flex min-h-dvh flex-col">
      <header className="py-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 sm:gap-4 sm:px-8">
          <div className="text-2xl font-semibold tracking-tight sm:text-3xl">
            <a href="/" aria-label="PayMVC. Homepage">
              paymvc.
            </a>
          </div>
          <nav
            aria-label="Main navigation"
            className="ml-auto flex items-center gap-2 sm:gap-3"
          >
            <DemoActions placement="header" />
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="flex flex-1 items-start py-16 sm:py-24">
        <section
          className="mx-auto flex w-full max-w-6xl flex-col items-center gap-20 px-5 text-center sm:gap-24 sm:px-8"
          aria-labelledby="landing-title"
        >
          <div className="flex flex-col items-center gap-6">
            <h1
              id="landing-title"
              className="max-w-[24ch] text-4xl tracking-tight sm:text-6xl"
            >
              One payments app.
              <br />
              Many smart contracts.
            </h1>
            <p className="max-w-[48ch] text-lg text-muted-foreground">
              Smart contract platform explorer and test harness for blockchain
              developers. Inspired by the original{" "}
              <a
                href="https://todomvc.com/"
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline-offset-4 hover:underline"
              >
                TodoMVC
              </a>
              .
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <DemoActions placement="hero" />
            </div>
          </div>
          <div className="flex w-full flex-col items-center gap-5">
            <h2 className="text-base font-normal text-muted-foreground sm:text-sm">
              Supported networks
            </h2>
            <ul
              role="list"
              className="grid grid-cols-3 gap-x-6 gap-y-5 sm:gap-x-10 xl:flex xl:justify-center xl:gap-7"
            >
              {networks.map(({ name, icon, url }) => (
                <li key={name}>
                  <a
                    href={url}
                    className="flex flex-col items-center gap-2 text-base underline-offset-4 hover:underline sm:flex-row"
                  >
                    <BrandMark src={icon} />
                    {name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <footer className="px-5 py-6 text-center text-base text-muted-foreground sm:px-8 sm:text-sm">
        <p>
          Built by{" "}
          <a
            href="https://x.com/chambaz"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline-offset-4 hover:underline"
          >
            @chambaz
          </a>
        </p>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
