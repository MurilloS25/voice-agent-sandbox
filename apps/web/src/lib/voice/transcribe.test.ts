import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeVoice, transcribeClip, TRANSCRIBE_PATH } from "./transcribe";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const clip = (type = "audio/webm;codecs=opus", bytes = 1500) =>
  new Blob([new Uint8Array(bytes)], { type });

/** A fetch that never answers, and rejects like a browser when its signal aborts. */
function hangUntilAborted() {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
}

describe("transcribeClip", () => {
  it("posts the clip to the same-origin route only, with the canonical type", async () => {
    fetchMock.mockResolvedValue(json({ text: "hello there" }));
    const controller = new AbortController();
    const blob = clip();

    const result = await transcribeClip(blob, controller.signal);

    expect(result).toEqual({ kind: "ok", text: "hello there" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TRANSCRIBE_PATH);
    expect(url.startsWith("/")).toBe(true); // a relative path: never another origin
    expect(init.method).toBe("POST");
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "audio/webm",
    );
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("really aborts the request when the signal aborts", async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const pending = transcribeClip(clip(), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "aborted" });
  });

  it("checks the clip before sending anything", async () => {
    const signal = new AbortController().signal;
    expect(await transcribeClip(clip("audio/x-unknown"), signal)).toEqual({
      kind: "error",
      code: "unsupported",
    });
    expect(await transcribeClip(clip("audio/webm", 0), signal)).toEqual({
      kind: "error",
      code: "invalid",
    });
    expect(
      await transcribeClip(clip("audio/webm", 256 * 1024 + 1), signal),
    ).toEqual({ kind: "error", code: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no_speech", 422],
    ["busy", 429],
    ["timeout", 504],
    ["feature_off", 503],
    ["too_large", 413],
  ])("passes the public code %s on", async (code, status) => {
    fetchMock.mockResolvedValue(json({ error: code }, status));
    expect(await transcribeClip(clip(), new AbortController().signal)).toEqual({
      kind: "error",
      code,
    });
  });

  it("treats an unknown code or an unreadable answer as a failure", async () => {
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(
      json({ error: "SECRET internal detail" }, 500),
    );
    expect(await transcribeClip(clip(), signal)).toEqual({
      kind: "error",
      code: "failed",
    });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    expect(await transcribeClip(clip(), signal)).toEqual({
      kind: "error",
      code: "failed",
    });
  });

  it("reports an unreachable server", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await transcribeClip(clip(), new AbortController().signal)).toEqual({
      kind: "error",
      code: "unreachable",
    });
  });

  it("ignores an answer that arrives after the signal aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return json({ text: "late text" });
    });
    expect(await transcribeClip(clip(), controller.signal)).toEqual({
      kind: "aborted",
    });
  });

  it("touches no browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fetchMock.mockResolvedValue(json({ text: "hello" }));
    await transcribeClip(clip(), new AbortController().signal);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("probeVoice", () => {
  it("posts an empty probe to the same route", async () => {
    fetchMock.mockResolvedValue(json({ available: true }));
    expect(await probeVoice(new AbortController().signal)).toBe("on");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TRANSCRIBE_PATH}?probe=1`);
    expect(init.body).toBeUndefined();
  });

  it.each([
    [{ available: false }, "off"],
    [{ nonsense: true }, "unreachable"],
  ])("reads %j as %s", async (body, expected) => {
    fetchMock.mockResolvedValue(json(body));
    expect(await probeVoice(new AbortController().signal)).toBe(expected);
  });

  it("is aborted by its signal and reports an unreachable server", async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const pending = probeVoice(controller.signal);
    controller.abort();
    expect(await pending).toBe("aborted");

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await probeVoice(new AbortController().signal)).toBe("unreachable");
  });
});
