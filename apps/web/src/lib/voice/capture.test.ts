import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeRecorder, installMedia, type FakeMedia } from "@/test/voice-fakes";

import { CaptureError, isCaptureSupported, startCapture } from "./capture";

let media: FakeMedia;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  media?.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CaptureError) return error.code;
    throw error;
  }
  return "no error";
}

describe("support", () => {
  it("is unsupported without getUserMedia or MediaRecorder", async () => {
    expect(isCaptureSupported()).toBe(false);
    expect(await code(startCapture())).toBe("unsupported");

    media = installMedia();
    expect(isCaptureSupported()).toBe(true);
    vi.stubGlobal("MediaRecorder", undefined);
    expect(isCaptureSupported()).toBe(false);
    expect(await code(startCapture())).toBe("unsupported");
    expect(media.getUserMedia).not.toHaveBeenCalled(); // the prompt is never opened for nothing
  });

  it("never asks for the microphone until a capture is started", () => {
    media = installMedia();
    isCaptureSupported();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});

describe("formats", () => {
  it("records in the first format the browser says it supports", async () => {
    media = installMedia();
    FakeRecorder.supported = ["audio/mp4", "audio/ogg;codecs=opus"];
    const capture = await startCapture();
    vi.advanceTimersByTime(1000);
    capture.stop();
    const recording = await capture.result;
    expect(recording.mediaType).toBe("audio/mp4");
    expect(recording.blob.type).toBe("audio/mp4");
  });

  it("prefers webm with opus when it is available", async () => {
    media = installMedia();
    const capture = await startCapture();
    expect(FakeRecorder.instances[0].mimeType).toBe("audio/webm;codecs=opus");
    capture.cancel();
    await code(capture.result);
  });

  it("falls back to the browser default when it is a format the API accepts", async () => {
    media = installMedia();
    FakeRecorder.supported = [];
    FakeRecorder.defaultMime = "audio/ogg;codecs=opus";
    const capture = await startCapture();
    vi.advanceTimersByTime(1000);
    capture.stop();
    expect((await capture.result).mediaType).toBe("audio/ogg");
  });

  it("refuses a browser that can only record formats the API does not accept", async () => {
    media = installMedia();
    FakeRecorder.supported = [];
    FakeRecorder.defaultMime = "audio/x-unknown";
    expect(await code(startCapture())).toBe("format_unsupported");
    expect(media.streams[0].allStopped).toBe(true); // the microphone is released
  });

  it("refuses a browser that reports no format at all", async () => {
    media = installMedia();
    FakeRecorder.supported = [];
    FakeRecorder.defaultMime = "";
    expect(await code(startCapture())).toBe("format_unsupported");
    expect(media.streams[0].allStopped).toBe(true);
  });
});

describe("permission", () => {
  it.each([
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["NotFoundError", "no_device"],
    ["OverconstrainedError", "no_device"],
    ["NotReadableError", "device_busy"],
    ["AbortError", "device_busy"],
    ["TypeError", "failed"],
  ])("maps %s to %s", async (name, expected) => {
    media = installMedia({ auto: false });
    const started = startCapture();
    media.deny(name);
    expect(await code(started)).toBe(expected);
  });

  it("gives up on a prompt that is never answered and stops a late stream", async () => {
    media = installMedia({ auto: false });
    const started = startCapture({ permissionTimeoutMs: 5000 });
    const settled = code(started);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await settled).toBe("permission_timeout");

    const late = media.grant(); // the browser answers after we gave up
    await vi.advanceTimersByTimeAsync(0);
    expect(late.allStopped).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("abandons the request when the signal aborts and stops a late stream", async () => {
    media = installMedia({ auto: false });
    const controller = new AbortController();
    const settled = code(startCapture({ signal: controller.signal }));
    controller.abort();
    expect(await settled).toBe("cancelled");

    const late = media.grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(late.allStopped).toBe(true);
  });

  it("does not even ask when the signal is already aborted", async () => {
    media = installMedia({ auto: false });
    const controller = new AbortController();
    controller.abort();
    const settled = code(startCapture({ signal: controller.signal }));
    expect(await settled).toBe("cancelled");
    const late = media.grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(late.allStopped).toBe(true);
  });
});

describe("recording", () => {
  it("delivers one Blob on stop and releases every track", async () => {
    media = installMedia();
    const capture = await startCapture();
    expect(FakeRecorder.instances[0].state).toBe("recording");

    vi.advanceTimersByTime(2000);
    capture.stop();
    const recording = await capture.result;

    expect(recording.blob.size).toBe(1500);
    expect(recording.durationMs).toBe(2000);
    expect(recording.autoStopped).toBe(false);
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("starts without a timeslice, so one playable Blob comes out", async () => {
    media = installMedia();
    const start = vi.spyOn(FakeRecorder.prototype, "start");
    const capture = await startCapture();
    expect(start).toHaveBeenCalledWith(); // no timeslice argument
    capture.cancel();
    await code(capture.result);
  });

  it("stops by itself at the maximum length and says so", async () => {
    media = installMedia();
    const capture = await startCapture({ maxMs: 15_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    const recording = await capture.result;
    expect(recording.autoStopped).toBe(true);
    expect(recording.durationMs).toBe(15_000);
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("rejects a recording shorter than the minimum", async () => {
    media = installMedia();
    const capture = await startCapture({ minMs: 300 });
    vi.advanceTimersByTime(299);
    capture.stop();
    expect(await code(capture.result)).toBe("too_short");
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("accepts a recording exactly at the minimum", async () => {
    media = installMedia();
    const capture = await startCapture({ minMs: 300 });
    vi.advanceTimersByTime(300);
    capture.stop();
    expect((await capture.result).blob.size).toBe(1500);
  });

  it("rejects a recording over the size limit without delivering it", async () => {
    media = installMedia();
    FakeRecorder.bytes = 600 * 1024;
    const capture = await startCapture();
    vi.advanceTimersByTime(2000);
    capture.stop();
    expect(await code(capture.result)).toBe("too_large");
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("accepts a recording exactly at the size limit", async () => {
    media = installMedia();
    FakeRecorder.bytes = 512 * 1024;
    const capture = await startCapture();
    vi.advanceTimersByTime(2000);
    capture.stop();
    expect((await capture.result).blob.size).toBe(512 * 1024);
  });

  it("rejects an empty recording", async () => {
    media = installMedia();
    FakeRecorder.bytes = 0;
    const capture = await startCapture();
    vi.advanceTimersByTime(2000);
    capture.stop();
    expect(await code(capture.result)).toBe("failed");
  });
});

describe("cleanup on every exit", () => {
  it("cancel discards the recording and stops the tracks", async () => {
    media = installMedia();
    const capture = await startCapture();
    capture.cancel();
    expect(await code(capture.result)).toBe("cancelled");
    expect(media.streams[0].allStopped).toBe(true);
    expect(FakeRecorder.instances[0].state).toBe("inactive");
  });

  it("a recorder error rejects and stops the tracks", async () => {
    media = installMedia();
    const capture = await startCapture();
    FakeRecorder.instances[0].fail();
    expect(await code(capture.result)).toBe("failed");
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("a recorder that cannot start rejects and stops the tracks", async () => {
    media = installMedia();
    FakeRecorder.failStart = true;
    const capture = await startCapture();
    expect(await code(capture.result)).toBe("failed");
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("cancelling twice, or after stopping, is harmless", async () => {
    media = installMedia();
    const capture = await startCapture();
    vi.advanceTimersByTime(1000);
    capture.stop();
    await capture.result;
    capture.cancel();
    capture.cancel();
    capture.stop();
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("the maximum-length timer does not fire after a stop", async () => {
    media = installMedia();
    const capture = await startCapture({ maxMs: 15_000 });
    vi.advanceTimersByTime(1000);
    capture.stop();
    await capture.result;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("no storage", () => {
  it("touches no browser storage and creates no object URL", async () => {
    media = installMedia();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    const capture = await startCapture();
    vi.advanceTimersByTime(1000);
    capture.stop();
    await capture.result;
    expect(setItem).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("a capture that nobody awaits", () => {
  it("is not an unhandled rejection when it is cancelled", async () => {
    media = installMedia();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const capture = await startCapture();
      capture.cancel(); // `result` is never awaited
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(media.streams[0].allStopped).toBe(true);
  });
});

describe("a microphone that must not stay on", () => {
  it("cancel releases the tracks at once, before the recorder reports its stop", async () => {
    media = installMedia();
    FakeRecorder.silentStop = true; // the browser stops the recorder but reports nothing yet
    const capture = await startCapture();
    const settled = code(capture.result);
    capture.cancel();
    expect(media.streams[0].allStopped).toBe(true); // already, without waiting for any event
    await vi.advanceTimersByTimeAsync(3000); // the recorder never reports; the grace period ends it
    expect(await settled).toBe("cancelled");
  });

  it("releases the microphone when a stop is never reported", async () => {
    media = installMedia();
    FakeRecorder.silentStop = true;
    const capture = await startCapture();
    vi.advanceTimersByTime(1000);
    const settled = code(capture.result);
    capture.stop();
    expect(media.streams[0].allStopped).toBe(false); // waiting for the stop event
    await vi.advanceTimersByTimeAsync(3000);
    expect(await settled).toBe("failed");
    expect(media.streams[0].allStopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a recorder that refuses its format", () => {
  it("is a format problem when the constructor says NotSupportedError", async () => {
    media = installMedia();
    FakeRecorder.throwOnConstruct = "NotSupportedError";
    expect(await code(startCapture())).toBe("format_unsupported");
    expect(media.streams[0].allStopped).toBe(true);
  });

  it("is a plain failure for any other constructor error", async () => {
    media = installMedia();
    FakeRecorder.throwOnConstruct = "TypeError";
    expect(await code(startCapture())).toBe("failed");
    expect(media.streams[0].allStopped).toBe(true);
  });
});
