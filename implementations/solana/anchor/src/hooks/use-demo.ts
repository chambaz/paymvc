import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { deploymentKey, type Deployment } from "../chain/config";
import { readableError } from "../chain/errors";
import { recheckOnce } from "../chain/recovery";
import {
  accountFor,
  loadSession,
  newSession,
  saveSession,
  type Intent,
  type Session,
} from "../chain/session";
import {
  payments,
  readDashboard,
  readContacts,
  fundingBudget,
} from "../chain/payments";
import {
  UnknownOutcome,
  ResultPending,
  BroadcastUnavailable,
} from "../chain/transactions";

export function useDemo(config: Deployment) {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [writer, setWriter] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  // Rows to read. Outside the query key, so Load more refetches the same query
  // and a failed read keeps the last balance and rows (React Query keeps data on error).
  const limit = useRef(50);
  const cache = useQueryClient();
  const key = deploymentKey(config);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let release: (() => void) | undefined;
    // Only a read-only tab reloads the saved session. The writer tab's copy is
    // the one that its running operation changes and saves.
    let holding = false;
    const waiting = new AbortController();
    const restore = () => {
      try {
        localStorage.getItem(key);
      } catch {
        setStorageBlocked(true);
        setError(storageMessage);
        setLoaded(true);
        return;
      }
      try {
        const saved = loadSession(config);
        if (addressOf(saved) !== addressOf(current.current)) limit.current = 50;
        current.current = saved;
        setSession(saved);
        setCorrupt(false);
        setUnknown(
          Boolean(
            saved?.intent &&
            Object.entries(saved.journal).some(
              ([label, record]) =>
                label.startsWith(saved.intent!.operation) && !record.confirmed,
            ),
          ),
        );
      } catch (error) {
        setError(readableError(error));
        setCorrupt(true);
      }
      setLoaded(true);
    };
    const follow = (event: StorageEvent) => {
      // A null key means that another tab cleared all storage.
      if (holding || (event.key !== null && event.key !== key)) return;
      restore();
    };
    restore();
    window.addEventListener("storage", follow);
    if (!navigator.locks) {
      setError(
        "This browser cannot protect a demo across tabs. Use a browser with Web Locks support.",
      );
    } else {
      const hold = async (lock: Lock | null) => {
        if (!lock || cancelled) return false;
        holding = true;
        restore();
        setWriter(true);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      };
      // Try now; if another tab owns the session, wait and take over when it closes.
      void navigator.locks
        .request(key, { ifAvailable: true }, hold)
        .then((held) =>
          held || cancelled
            ? undefined
            : navigator.locks.request(key, { signal: waiting.signal }, hold),
        )
        .catch(() => undefined);
    }
    return () => {
      mounted.current = false;
      cancelled = true;
      waiting.abort();
      release?.();
      window.removeEventListener("storage", follow);
    };
  }, [key, config]);

  const dashboard = useQuery({
    queryKey: ["dashboard", key, session ? accountFor(session).address : null],
    queryFn: () => readDashboard(config, current.current!, limit.current),
    enabled: Boolean(session?.ready),
    refetchInterval: busy ? false : 15_000,
    retry: 1,
  });

  const funding = useQuery({
    queryKey: ["funding", key, session ? accountFor(session).address : null],
    queryFn: () => fundingBudget(config, accountFor(current.current!).address),
    enabled: Boolean(session && !session.ready),
    refetchInterval: busy ? false : 15_000,
    retry: 1,
  });

  const contacts = useInfiniteQuery({
    queryKey: ["contacts", key, session ? accountFor(session).address : null],
    initialPageParam: 0n,
    queryFn: ({ pageParam }) =>
      readContacts(config, current.current!, pageParam),
    getNextPageParam: (page) => page.next,
    enabled: Boolean(session?.ready),
    retry: 1,
  });

  // Saves the session object that an operation changes, so that the signed
  // transaction it holds is on disk before broadcast.
  function persistFor(target: Session) {
    return () => {
      saveSession(target);
      current.current = target;
      setSession({ ...target });
    };
  }
  async function run(task: () => Promise<void>) {
    if (!writer || running.current) return false;
    running.current = true;
    setBusy(true);
    setError("");
    setUnknown(false);
    try {
      await task();
      await cache.invalidateQueries({ queryKey: ["dashboard", key] });
      return true;
    } catch (error) {
      setError(readableError(error));
      setUnknown(unresolved(error));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function start() {
    return run(async () => {
      if (storageBlocked) throw new Error(storageMessage);
      if (corrupt)
        throw new Error("Reset the unreadable session before starting again.");
      if (!current.current) {
        const created = await newSession(config);
        saveSession(created); // If storage fails, the key is not used.
        current.current = created;
        setSession({ ...created });
        setMessage("");
        return;
      }
      const saved = current.current;
      await recheckOnce(
        () => payments(config, saved, persistFor(saved), setMessage).setup(),
        (error) =>
          error instanceof UnknownOutcome || error instanceof ResultPending,
        () => setMessage("Checking your saved setup"),
        () => mounted.current,
      );
      setMessage("");
    });
  }
  async function act(intent: Intent) {
    return run(async () => {
      const saved = current.current;
      if (!saved) throw new Error("Start a demo first.");
      if (saved.intent && saved.intent.operation !== intent.operation)
        throw new Error("Resolve the previous operation first.");
      const save = persistFor(saved);
      // True once a transaction for this operation has been signed and saved.
      let signed = hasRecords(saved, intent.operation);
      const persist = () => {
        signed ||= hasRecords(saved, intent.operation);
        save();
      };
      saved.intent = intent;
      persist();
      try {
        await recheckOnce(
          () => payments(config, saved, persist, setMessage).execute(intent),
          (error) => error instanceof ResultPending,
          () => setMessage("Checking the saved payment result"),
          () => mounted.current,
        );
      } catch (error) {
        // A check before signing failed, so nothing can reach the chain.
        // Release the operation, so that the form stays editable.
        if (!signed && !unresolved(error)) {
          saved.intent = null;
          persist();
        }
        throw error;
      }
      // The effect is verified on-chain, so the saved transactions are no longer needed.
      forget(saved, intent.operation);
      saved.intent = null;
      persist();
      setMessage("");
    });
  }
  function dismissFailed() {
    const saved = current.current;
    if (!saved?.intent || running.current || !writer) return;
    const { operation } = saved.intent;
    // Only unbroadcast or definitively reverted operations may be dismissed.
    if (
      Object.entries(saved.journal).some(
        ([label, record]) => label.startsWith(operation) && !record.confirmed,
      )
    )
      return;
    forget(saved, operation);
    saved.intent = null;
    persistFor(saved)();
    setError("");
  }
  function reset() {
    if (!writer || running.current) return;
    try {
      localStorage.removeItem(key);
    } catch {
      setError(
        "Browser storage is unavailable. Enable storage, then reset this demo.",
      );
      return;
    }
    current.current = null;
    setSession(null);
    setCorrupt(false);
    setMessage("");
    setError("");
    setUnknown(false);
    limit.current = 50;
    cache.removeQueries({ queryKey: ["dashboard", key] });
    cache.removeQueries({ queryKey: ["contacts", key] });
    cache.removeQueries({ queryKey: ["funding", key] });
  }
  return {
    session,
    loaded,
    corrupt,
    writer,
    busy,
    message,
    error,
    unknown,
    dashboard,
    contacts,
    // Directory pages can overlap when registrations arrive between reads.
    contactAddresses: [
      ...new Set(contacts.data?.pages.flatMap((page) => page.addresses) ?? []),
    ],
    funding,
    start,
    act,
    reset,
    dismissFailed,
    more: () => {
      if (dashboard.isFetching) return;
      limit.current += 50;
      void dashboard.refetch();
    },
    refresh: () => Promise.all([dashboard.refetch(), contacts.refetch()]),
  };
}

const storageMessage =
  "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.";

/** The outcome is not known yet, so the operation must stay saved. */
function unresolved(error: unknown) {
  return (
    error instanceof UnknownOutcome ||
    error instanceof BroadcastUnavailable ||
    error instanceof ResultPending
  );
}

function hasRecords(session: Session, operation: string) {
  return Object.keys(session.journal).some((label) =>
    label.startsWith(operation),
  );
}

function forget(session: Session, operation: string) {
  for (const label of Object.keys(session.journal))
    if (label.startsWith(operation)) delete session.journal[label];
}

function addressOf(session: Session | null) {
  return session ? accountFor(session).address : null;
}
