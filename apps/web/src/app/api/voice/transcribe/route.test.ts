import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResult, Transcription } from "@/lib/api/client";

const { sendTranscription } = vi.hoisted(() => ({
  sendTranscription: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ sendTranscription }));

import { POST, READ_TIMEOUT_MS } from "./route";

const URL_BASE = "http://localhost:3000/api/voice/transcribe";
const LIMIT = 512 * 1024;
const OK: ApiResult<Transcription> = {
  kind: "ok",
  data: { text: "Do you open on Saturdays", language: "en" },
};

function audioRequest(
  body: BodyInit | null,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request(URL_BASE, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "content-type": "audio/webm;codecs=opus",
      ...headers,
    },
    body,
    ...(body ? { duplex: "half" } : {}),
    ...init,
  } as RequestInit);
}

/** A byte stream that counts how many chunks were pulled from it. */
function countingStream(chunks: number, size: number) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled += 1;
        controller.enqueue(new Uint8Array(size));
      },
    },
    { highWaterMark: 0 },
  ); // nothing is pulled ahead of a read
  return { stream, state };
}

const consoleSpies = ["log", "info", "warn", "error", "debug"].map((name) =>
  vi.spyOn(console, name as "log"),
);

beforeEach(() => {
  sendTranscription.mockReset();
  sendTranscription.mockResolvedValue(OK);
  consoleSpies.forEach((spy) => spy.mockClear());
});

afterEach(() => {
  // Nothing in the route may ever log: audio and transcripts must not reach a console.
  consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
});

describe("same-origin check", () => {
  it.each([
    ["a different origin", "https://evil.example"],
    ["a different port", "http://localhost:4000"],
    ["an unreadable origin", "not a url"],
    ["a look-alike host", "http://localhost:3000.evil.example"],
    ["credentials in the origin", "http://localhost:3000@evil.example"],
  ])("refuses %s", async (_name, origin) => {
    const response = await POST(audioRequest(new Uint8Array(100), { origin }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(sendTranscription).not.toHaveBeenCalled();
  });

  it("refuses a request with no Origin header", async () => {
    const request = audioRequest(new Uint8Array(100));
    request.headers.delete("origin");
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(sendTranscription).not.toHaveBeenCalled();
  });
});

describe("validation before anything is forwarded", () => {
  it.each(["", "audio/mpeg", "application/json", "text/plain"])(
    "refuses content type %j",
    async (type) => {
      const response = await POST(
        audioRequest(new Uint8Array(100), { "content-type": type }),
      );
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported" });
      expect(sendTranscription).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty body", async () => {
    const response = await POST(audioRequest(null));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(sendTranscription).not.toHaveBeenCalled();
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const { stream, state } = countingStream(4, 1024);
    const response = await POST(
      audioRequest(stream, { "content-length": String(LIMIT + 1) }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
    expect(state.pulled).toBe(0);
    expect(sendTranscription).not.toHaveBeenCalled();
  });

  it("counts the bytes and stops reading when they cross the limit", async () => {
    // No Content-Length (or a false one): only the counted bytes decide.
    const { stream, state } = countingStream(40, 64 * 1024);
    const response = await POST(
      audioRequest(stream, { "content-length": "10" }),
    );
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(10); // 8 fit, the 9th crosses; the rest is unread
    expect(sendTranscription).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly the limit", async () => {
    const { stream } = countingStream(8, 64 * 1024);
    const response = await POST(audioRequest(stream));
    expect(response.status).toBe(200);
    const sent = sendTranscription.mock.calls[0][0] as Uint8Array;
    expect(sent.byteLength).toBe(LIMIT);
  });
});

describe("an upload that is too slow", () => {
  it("is cut off at the read deadline and forwards nothing", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(10));
            return new Promise<void>(() => undefined); // then nothing more ever arrives
          },
        },
        { highWaterMark: 0 },
      );
      const pending = POST(audioRequest(stream));
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 10);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "timeout" });
      expect(sendTranscription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trip the deadline for an upload that finishes in time", async () => {
    const response = await POST(audioRequest(new Uint8Array(100)));
    expect(response.status).toBe(200);
  });
});

describe("an upload that is cancelled while it arrives", () => {
  it("answers a fixed failure and forwards nothing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.error(new DOMException("Aborted", "AbortError"));
      },
    });
    const response = await POST(audioRequest(stream));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "failed" });
    expect(sendTranscription).not.toHaveBeenCalled();
  });
});

describe("forwarding", () => {
  it("sends the bytes with the canonical type and returns only the text", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const response = await POST(audioRequest(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: "Do you open on Saturdays" });
    const [audio, type] = sendTranscription.mock.calls[0];
    expect(Array.from(audio as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(type).toBe("audio/webm"); // parameters are dropped
  });

  it("forwards the request's own signal, so a cancel reaches the API call", async () => {
    const controller = new AbortController();
    const request = audioRequest(
      new Uint8Array(10),
      {},
      {
        signal: controller.signal,
      },
    );
    await POST(request);

    const signal = sendTranscription.mock.calls[0][2] as AbortSignal;
    expect(signal).toBe(request.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true); // the same signal now carries the cancellation
  });

  it.each([
    ["speech_unavailable", "feature_off", 503],
    ["audio_too_large", "too_large", 413],
    ["audio_unsupported", "unsupported", 415],
    ["audio_invalid", "invalid", 422],
    ["validation_error", "invalid", 422],
    ["no_speech", "no_speech", 422],
    ["speech_busy", "busy", 429],
    ["transcription_failed", "failed", 502],
    ["transcription_timeout", "timeout", 504],
    ["something_new", "failed", 502],
  ])("maps the API code %s to %s", async (apiCode, code, status) => {
    sendTranscription.mockResolvedValue({
      kind: "error",
      status: 500,
      code: apiCode,
      message: "SECRET internal message with the transcript",
    });
    const response = await POST(audioRequest(new Uint8Array(10)));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: code });
    expect(text).not.toContain("SECRET"); // the API's message never reaches the browser
  });

  it("reports an unreachable API", async () => {
    sendTranscription.mockResolvedValue({ kind: "unavailable" });
    const response = await POST(audioRequest(new Uint8Array(10)));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "unreachable" });
  });
});

describe("probe", () => {
  function probeRequest() {
    return new Request(`${URL_BASE}?probe=1`, {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    });
  }

  it("is available when the API does not say speech is off", async () => {
    sendTranscription.mockResolvedValue({
      kind: "error",
      status: 422,
      code: "audio_invalid",
      message: "x",
    });
    const response = await POST(probeRequest());
    expect(await response.json()).toEqual({ available: true });
    const [audio] = sendTranscription.mock.calls[0];
    expect((audio as Uint8Array).byteLength).toBe(0); // nothing is ever recorded for a probe
  });

  it("is off when the API says speech is unavailable", async () => {
    sendTranscription.mockResolvedValue({
      kind: "error",
      status: 503,
      code: "speech_unavailable",
      message: "x",
    });
    expect(await (await POST(probeRequest())).json()).toEqual({
      available: false,
    });
  });

  it("is unreachable when the API cannot be reached, and refuses a foreign origin", async () => {
    sendTranscription.mockResolvedValue({ kind: "unavailable" });
    const unreachable = await POST(probeRequest());
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toEqual({ error: "unreachable" });

    sendTranscription.mockClear();
    const foreign = new Request(`${URL_BASE}?probe=1`, {
      method: "POST",
      headers: { origin: "https://evil.example", host: "localhost:3000" },
    });
    expect((await POST(foreign)).status).toBe(403);
    expect(sendTranscription).not.toHaveBeenCalled();
  });
});
