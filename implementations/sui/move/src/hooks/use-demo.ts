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
    const waiting = new AbortController();
    const restore = () => {
      try {
        const saved = loadSession(config);
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
    restore();
    window.addEventListener("storage", restore);
    if (!navigator.locks) {
      setError(
        "This browser cannot protect a demo across tabs. Use a browser with Web Locks support.",
      );
    } else {
      const hold = async (lock: Lock | null) => {
        if (!lock || cancelled) return false;
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
      window.removeEventListener("storage", restore);
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

  function persist() {
    if (!current.current) return;
    saveSession(current.current);
    setSession({ ...current.current });
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
      setUnknown(
        error instanceof UnknownOutcome ||
          error instanceof BroadcastUnavailable ||
          error instanceof ResultPending,
      );
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function start() {
    return run(async () => {
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
      await recheckOnce(
        () => payments(config, current.current!, persist, setMessage).setup(),
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
      saved.intent = intent;
      persist();
      await recheckOnce(
        () => payments(config, saved, persist, setMessage).execute(intent),
        (error) => error instanceof ResultPending,
        () => setMessage("Checking the saved payment result"),
        () => mounted.current,
      );
      // The effect is verified on-chain, so the saved transactions are no longer needed.
      for (const label of Object.keys(saved.journal))
        if (label.startsWith(intent.operation)) delete saved.journal[label];
      saved.intent = null;
      persist();
      setMessage("");
    });
  }
  function dismissFailed() {
    const saved = current.current;
    if (!saved || running.current || !writer) return;
    // Only unbroadcast or definitively reverted operations may be dismissed.
    if (
      Object.entries(saved.journal).some(
        ([label, record]) =>
          label.startsWith(saved.intent?.operation ?? "unused:") &&
          !record.confirmed,
      )
    )
      return;
    saved.intent = null;
    persist();
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
    funding,
    start,
    act,
    reset,
    dismissFailed,
    more: () => {
      limit.current += 50;
      void dashboard.refetch();
    },
    refresh: () => Promise.all([dashboard.refetch(), contacts.refetch()]),
  };
}
