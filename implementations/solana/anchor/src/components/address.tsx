import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "./ui/button";

/** Display text only. Never use it to identify an account. */
export function shortAddress(value: string) {
  if (!value) return "";
  const prefix = value.startsWith("0x") ? 2 : 0;
  return `${value.slice(0, prefix + 4)}...${value.slice(-4)}`;
}

export function CopyAddress({
  address,
  label = "Copy address",
  format = "short",
}: {
  address: string;
  label?: string;
  format?: "short" | "full" | "icon";
}) {
  const full = format === "full";
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      // `navigator.clipboard` is undefined outside secure contexts.
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }
  return (
    <span className="inline-flex min-w-0 items-center">
      <Button
        variant={full ? "outline" : "ghost"}
        size={full ? "sm" : "icon"}
        className={
          full
            ? "h-auto w-full items-start justify-start whitespace-normal text-left font-mono"
            : undefined
        }
        title={copied ? "Copied" : `Copy ${address}`}
        aria-label={`${label}: ${address}${copied ? " (Copied)" : ""}`}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {full ? (
          <span data-testid="funding-address" className="min-w-0 break-all">
            {address}
          </span>
        ) : null}
      </Button>
      {format === "short" ? (
        <span className="font-mono" title={address}>
          {shortAddress(address)}
        </span>
      ) : null}
      {/* Always mounted, so that screen readers announce changes. */}
      <span role="status" className={failed ? "break-all" : "sr-only"}>
        {failed ? `Copy manually: ${address}` : copied ? "Copied" : ""}
      </span>
    </span>
  );
}
