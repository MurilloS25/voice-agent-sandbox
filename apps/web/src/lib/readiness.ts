"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Readiness = "checking" | "starting" | "ready" | "unreachable";

export const READY_PATH = "/api/assistant/ready";
/** The first retry comes quickly; later ones slow down to this ceiling. */
export const FIRST_DELAY_MS = 1500;
export const MAX_DELAY_MS = 8000;
/** A sleeping Render service takes about a minute to wake: wait a little longer, then stop. */
export const GIVE_UP_AFTER_MS = 120_000;
const GROWTH = 1.6;

/** The wait before attempt number `attempt` (0 is the first retry), with a bounded jitter. */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * GROWTH ** attempt);
  return Math.round(base * (0.8 + 0.4 * random())); // plus or minus 20%
}

type Options = {
  /** `ready` skips the check entirely (tests and stories). */
  initial?: Readiness;
  fetchState?: (
    signal: AbortSignal,
  ) => Promise<"ready" | "starting" | "unreachable">;
  now?: () => number;
  random?: () => number;
};

async function defaultFetch(signal: AbortSignal) {
  const response = await fetch(READY_PATH, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) return "starting" as const;
  const body = (await response.json()) as { state?: unknown } | null;
  return body?.state === "ready"
    ? ("ready" as const)
    : body?.state === "unreachable"
      ? ("unreachable" as const)
      : ("starting" as const);
}

/**
 * Whether the backend can serve, checked with a bounded, backed-off poll of the same-origin
 * readiness route. It starts when the component mounts, ends the moment it succeeds, is cancelled
 * when the component unmounts or the page is hidden for good, and gives up after about two
 * minutes (state `unreachable`, with a Retry). It never calls the agent and never keeps the
 * backend awake: once ready it does not poll again.
 */
export function useApiReadiness({
  initial = "checking",
  fetchState = defaultFetch,
  now = Date.now,
  random = Math.random,
}: Options = {}): { state: Readiness; elapsedS: number; retry: () => void } {
  const [state, setState] = useState<Readiness>(initial);
  const [elapsedS, setElapsedS] = useState(0);
  const [round, setRound] = useState(0);
  const latest = useRef({ fetchState, now, random });
  useEffect(() => {
    latest.current = { fetchState, now, random };
  });

  useEffect(() => {
    if (initial === "ready") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = latest.current.now();
    let attempt = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    const onHide = () => stop(); // the page is going away (and may be restored from the cache)
    // A page restored from the cache starts its check again.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRound((count) => count + 1);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);

    async function check() {
      let result: Awaited<ReturnType<typeof defaultFetch>>;
      try {
        result = await latest.current.fetchState(controller.signal);
      } catch {
        if (stopped) return;
        result = "starting";
      }
      if (stopped) return;
      const waited = latest.current.now() - started;
      setElapsedS(Math.round(waited / 1000));
      if (result === "ready") {
        setState("ready");
        return;
      }
      if (result === "unreachable" || waited >= GIVE_UP_AFTER_MS) {
        setState("unreachable");
        return;
      }
      setState("starting");
      timer = setTimeout(
        () => void check(),
        backoffDelay(attempt++, latest.current.random),
      );
    }
    void check();

    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      stop();
    };
  }, [round, initial]);

  const retry = useCallback(() => {
    setState("checking");
    setElapsedS(0);
    setRound((count) => count + 1);
  }, []);

  return { state, elapsedS, retry };
}
