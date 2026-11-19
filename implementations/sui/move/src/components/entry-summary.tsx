import { Badge } from "./ui/badge";
import { shortAddress } from "./address";

export interface Row {
  id: string;
  address: string;
  amount: string;
  state: string;
  incoming: boolean;
  request: boolean;
}

/** One activity sentence with its status badge. The address opens Send. */
export function EntrySummary({
  row,
  disabled,
  onSelect,
}: {
  row: Row;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const address = (
    <button
      type="button"
      className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
      title={row.address}
      aria-label={`Send to ${shortAddress(row.address)} (${row.address})`}
      disabled={disabled}
      onClick={onSelect}
    >
      {shortAddress(row.address)}
    </button>
  );
  const amount = (
    <span className="font-medium tabular-nums">{row.amount} credits</span>
  );
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <p className="min-w-0 text-base sm:text-sm">
        {row.request ? (
          row.incoming ? (
            <>
              You requested {amount} from {address}
            </>
          ) : (
            <>
              {address} requested {amount} from you
            </>
          )
        ) : row.incoming ? (
          <>
            You received {amount} from {address}
          </>
        ) : (
          <>
            You sent {address} {amount}
          </>
        )}
      </p>
      <Badge
        variant={
          row.request && row.state === "Pending" ? "secondary" : "outline"
        }
      >
        {row.request ? row.state : "Completed"}
      </Badge>
    </div>
  );
}
