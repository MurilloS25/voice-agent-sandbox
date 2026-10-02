import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPEECH_TIMEOUT_MS, sendTranscription } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("API_BASE_URL", "http://api.test");
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const audio = new Uint8Array([1, 2, 3]);

describe("sendTranscription", () => {
  it("posts the raw bytes to the speech endpoint and returns the text", async () => {
    fetchMock.mockResolvedValue(json({ text: "hello", language: "en" }));

    const result = await sendTranscription(audio, "audio/webm");

    expect(result).toEqual({
      kind: "ok",
      data: { text: "hello", language: "en" },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/speech/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(audio);
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "audio/webm",
    );
    expect(init.cache).toBe("no-store");
  });

  it("has a budget of the API's 9 s bound plus the shared 5 s margin", () => {
    expect(SPEECH_TIMEOUT_MS).toBe(14000);
  });

  it("forwards a cancellation to the fetch", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const pending = sendTranscription(audio, "audio/webm", controller.signal);
    const sent = (fetchMock.mock.calls[0] as [string, RequestInit])[1].signal;
    expect(sent?.aborted).toBe(false);

    controller.abort();

    expect(sent?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "unavailable" });
  });

  it.each([
    [422, "no_speech"],
    [429, "speech_busy"],
    [502, "transcription_failed"],
    [503, "speech_unavailable"],
    [504, "transcription_timeout"],
  ])(
    "reads a %s answer as the code %s, not as a gateway failure",
    async (status, code) => {
      fetchMock.mockResolvedValue(
        json({ error: { code, message: "fixed text" } }, status, {
          "retry-after": "2",
        }),
      );
      const result = await sendTranscription(audio, "audio/webm");
      expect(result).toMatchObject({ kind: "error", status, code });
    },
  );

  it("reports an unreachable API and an unreadable answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await sendTranscription(audio, "audio/webm")).toEqual({
      kind: "unavailable",
    });

    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    expect(await sendTranscription(audio, "audio/webm")).toMatchObject({
      kind: "error",
      code: "invalid_response",
    });

    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    expect(await sendTranscription(audio, "audio/webm")).toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });
});
