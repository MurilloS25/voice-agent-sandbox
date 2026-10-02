import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffDelay,
  FIRST_DELAY_MS,
  GIVE_UP_AFTER_MS,
  MAX_DELAY_MS,
  useApiReadiness,
} from "./readiness";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("backoffDelay", () => {
  it("grows, stays bounded and jitters within 20%", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(FIRST_DELAY_MS);
    expect(backoffDelay(0, () => 0)).toBe(Math.round(FIRST_DELAY_MS * 0.8));
    expect(backoffDelay(50, () => 1)).toBe(Math.round(MAX_DELAY_MS * 1.2));
    expect(backoffDelay(3, () => 0.5)).toBeGreaterThan(
      backoffDelay(1, () => 0.5),
    );
  });
});

describe("useApiReadiness", () => {
  it("polls until ready, then stops", async () => {
    const fetchState = vi
      .fn<(s: AbortSignal) => Promise<"ready" | "starting" | "unreachable">>()
      .mockResolvedValueOnce("starting")
      .mockResolvedValueOnce("starting")
      .mockResolvedValue("ready");
    const { result } = renderHook(() => useApiReadiness({ fetchState }));
    expect(result.current.state).toBe("checking");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.state).toBe("starting");
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current.state).toBe("ready");
    const calls = fetchState.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchState.mock.calls.length).toBe(calls); // no keep-alive polling
  });

  it("gives up after the bound and Retry starts again", async () => {
    const fetchState = vi.fn().mockResolvedValue("starting");
    let clock = 0;
    const { result } = renderHook(() =>
      useApiReadiness({ fetchState, now: () => clock }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    clock = GIVE_UP_AFTER_MS + 1;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.state).toBe("unreachable");
    fetchState.mockResolvedValue("ready");
    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.state).toBe("ready");
  });

  it("an unsafe configuration is unreachable at once", async () => {
    const fetchState = vi.fn().mockResolvedValue("unreachable");
    const { result } = renderHook(() => useApiReadiness({ fetchState }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.state).toBe("unreachable");
    expect(fetchState).toHaveBeenCalledTimes(1);
  });

  it("aborts the request and stops on unmount", async () => {
    let seen: AbortSignal | undefined;
    const fetchState = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return new Promise<"starting">(() => undefined);
    });
    const { unmount } = renderHook(() => useApiReadiness({ fetchState }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    expect(seen?.aborted).toBe(true);
  });

  it("makes no request when assumed ready", async () => {
    const fetchState = vi.fn();
    const { result } = renderHook(() =>
      useApiReadiness({ initial: "ready", fetchState }),
    );
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.state).toBe("ready");
    expect(fetchState).not.toHaveBeenCalled();
  });
});
