/**
 * Microphone capture for one short push-to-talk recording.
 *
 * Privacy rules this module keeps: the microphone is requested only when `startCapture` is
 * called (never on load); every track is stopped on stop, cancel, error, timeout and when a late
 * permission answer arrives for a request that was already abandoned; the recorded chunks live
 * only in memory and are dropped as soon as the Blob is built; nothing is stored in the browser
 * and no object URL is ever created.
 */
import {
  audioTypeOf,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  PERMISSION_TIMEOUT_MS,
  type AudioType,
} from "./limits";

export type CaptureErrorCode =
  | "unsupported" // no getUserMedia or MediaRecorder
  | "permission_denied"
  | "permission_timeout" // the prompt was ignored
  | "no_device"
  | "device_busy"
  | "format_unsupported" // the browser records only formats the API does not accept
  | "too_short"
  | "too_large"
  | "failed"
  | "cancelled";

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode) {
    super(code); // the code only: never a browser message
    this.name = "CaptureError";
  }
}

export type Recording = {
  blob: Blob;
  mediaType: AudioType;
  durationMs: number;
  /** True when the maximum length ended the recording. */
  autoStopped: boolean;
};

export type Capture = {
  /** Ends the recording and delivers it through `result`. */
  stop(): void;
  /** Discards the recording: `result` rejects with `cancelled`. */
  cancel(): void;
  readonly result: Promise<Recording>;
  /**
   * The stream the recorder is using, so the interface can draw its volume. It is the same
   * capture: nothing here opens the microphone a second time, and it is stopped with the rest.
   */
  readonly stream: MediaStream;
};

export type CaptureOptions = {
  maxMs?: number;
  minMs?: number;
  maxBytes?: number;
  permissionTimeoutMs?: number;
  /** Aborting while the permission prompt is open abandons the request. */
  signal?: AbortSignal;
  now?: () => number;
};

/** Candidates in order of preference; the first one the browser says it can record is used. */
const CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

/** How long a recorder may take to report its stop before the microphone is released anyway. */
const STOP_GRACE_MS = 3000;

export function isCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function stopTracks(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function mapPermissionError(error: unknown): CaptureError {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new CaptureError("permission_denied");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new CaptureError("no_device");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new CaptureError("device_busy");
  }
  return new CaptureError("failed");
}

/**
 * Asks for the microphone with our own timeout (an ignored prompt may never settle) and an abort
 * signal. If the browser answers after we gave up, the late stream is stopped at once.
 */
function requestMicrophone(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<MediaStream> {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const request = navigator.mediaDevices.getUserMedia({ audio: true });

    const finish = (action: () => void) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
      return true;
    };
    const abandon = (code: CaptureErrorCode) => () => {
      if (finish(() => reject(new CaptureError(code)))) {
        // A stream that arrives later must not keep the microphone open.
        request.then(stopTracks, () => undefined);
      }
    };
    const onAbort = abandon("cancelled");

    const timer = setTimeout(abandon("permission_timeout"), timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    request.then(
      (stream) => {
        if (!finish(() => resolve(stream))) stopTracks(stream); // abandoned meanwhile
      },
      (error: unknown) => {
        finish(() => reject(mapPermissionError(error)));
      },
    );
  });
}

function pickRecorder(stream: MediaStream): {
  recorder: MediaRecorder;
  mediaType: AudioType;
} {
  const supported = CANDIDATES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  let recorder: MediaRecorder;
  try {
    recorder = supported
      ? new MediaRecorder(stream, { mimeType: supported })
      : new MediaRecorder(stream); // the browser's own default, accepted only if we can send it
  } catch (error) {
    // A format that isTypeSupported accepted can still be refused when the recorder is built.
    const name = error instanceof Error ? error.name : "";
    throw new CaptureError(
      name === "NotSupportedError" ? "format_unsupported" : "failed",
    );
  }
  const mediaType = audioTypeOf(recorder.mimeType) ?? audioTypeOf(supported);
  if (!mediaType) throw new CaptureError("format_unsupported");
  return { recorder, mediaType };
}

export async function startCapture(
  options: CaptureOptions = {},
): Promise<Capture> {
  const {
    maxMs = MAX_RECORDING_MS,
    minMs = MIN_RECORDING_MS,
    maxBytes = MAX_AUDIO_BYTES,
    permissionTimeoutMs = PERMISSION_TIMEOUT_MS,
    signal,
    now = () => Date.now(),
  } = options;
  if (!isCaptureSupported()) throw new CaptureError("unsupported");

  const stream = await requestMicrophone(permissionTimeoutMs, signal);

  let recorder: MediaRecorder;
  let mediaType: AudioType;
  try {
    ({ recorder, mediaType } = pickRecorder(stream));
  } catch (error) {
    stopTracks(stream);
    throw error instanceof CaptureError ? error : new CaptureError("failed");
  }

  let chunks: Blob[] = [];
  let cancelled = false;
  let autoStopped = false;
  let finished = false;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = now();
  let resolveResult!: (recording: Recording) => void;
  let rejectResult!: (error: CaptureError) => void;
  const result = new Promise<Recording>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A capture abandoned before anyone awaits it rejects with `cancelled`: that is expected, and
  // must not surface as an unhandled rejection. Callers that await `result` still see it.
  result.catch(() => undefined);

  /** Releases the microphone, the timer and every reference to the audio. Idempotent. */
  const release = () => {
    if (limitTimer !== undefined) clearTimeout(limitTimer);
    limitTimer = undefined;
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    stopTimer = undefined;
    stopTracks(stream);
    chunks = [];
  };
  const fail = (code: CaptureErrorCode) => {
    if (finished) return;
    finished = true;
    release();
    rejectResult(new CaptureError(code));
  };

  recorder.addEventListener("dataavailable", (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("error", () => {
    fail("failed"); // first, so the stop event below is not taken for a normal stop
    if (recorder.state !== "inactive") recorder.stop();
  });
  recorder.addEventListener("stop", () => {
    if (finished) return;
    if (cancelled) return fail("cancelled");
    const durationMs = now() - startedAt;
    const blob = new Blob(chunks, { type: mediaType });
    finished = true;
    release(); // the chunks are dropped; only the single Blob remains
    if (durationMs < minMs) {
      return rejectResult(new CaptureError("too_short"));
    }
    if (blob.size === 0) return rejectResult(new CaptureError("failed"));
    if (blob.size > maxBytes)
      return rejectResult(new CaptureError("too_large"));
    resolveResult({ blob, mediaType, durationMs, autoStopped });
  });

  const stopRecorder = () => {
    if (recorder.state === "inactive") return;
    recorder.stop();
    // A recorder that never reports its stop must not keep the microphone on.
    if (!finished)
      stopTimer ??= setTimeout(
        () => fail(cancelled ? "cancelled" : "failed"),
        STOP_GRACE_MS,
      );
  };

  try {
    startedAt = now();
    recorder.start(); // no timeslice: one playable Blob when it stops
  } catch {
    fail("failed");
    return { stop: () => undefined, cancel: () => undefined, result, stream };
  }
  limitTimer = setTimeout(() => {
    autoStopped = true;
    stopRecorder();
  }, maxMs);

  return {
    stop: stopRecorder,
    cancel: () => {
      cancelled = true;
      stopTracks(stream); // release the microphone now, not when the recorder reports its stop
      if (recorder.state === "inactive") fail("cancelled");
      else stopRecorder();
    },
    result,
    stream,
  };
}
