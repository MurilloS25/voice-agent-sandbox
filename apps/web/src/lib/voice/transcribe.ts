/**
 * The browser's side of voice transcription: it calls only the same-origin route handler
 * (`/api/voice/transcribe`), never the Python API, and holds no key or server address.
 *
 * Nothing here logs, stores or caches audio or text.
 */
import {
  audioTypeOf,
  MAX_AUDIO_BYTES,
  VOICE_ERROR_CODES,
  type VoiceErrorCode,
} from "./limits";

export const TRANSCRIBE_PATH = "/api/voice/transcribe";

export type TranscribeResult =
  | { kind: "ok"; text: string }
  | { kind: "error"; code: VoiceErrorCode }
  | { kind: "aborted" };

function isVoiceErrorCode(value: unknown): value is VoiceErrorCode {
  return (
    typeof value === "string" &&
    (VOICE_ERROR_CODES as readonly string[]).includes(value)
  );
}

async function post(
  url: string,
  body: Blob | undefined,
  contentType: string,
  signal: AbortSignal,
): Promise<Response | "aborted" | "unreachable"> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
      signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (error) {
    return signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
      ? "aborted"
      : "unreachable";
  }
}

/**
 * Sends one recording. Aborting `signal` really cancels the request: the route handler forwards
 * the cancellation to the API call.
 */
export async function transcribeClip(
  clip: Blob,
  signal: AbortSignal,
): Promise<TranscribeResult> {
  const type = audioTypeOf(clip.type);
  if (!type) return { kind: "error", code: "unsupported" };
  if (clip.size === 0) return { kind: "error", code: "invalid" };
  if (clip.size > MAX_AUDIO_BYTES) return { kind: "error", code: "too_large" };

  const response = await post(TRANSCRIBE_PATH, clip, type, signal);
  if (response === "aborted") return { kind: "aborted" };
  if (response === "unreachable") return { kind: "error", code: "unreachable" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) return { kind: "aborted" };
    return { kind: "error", code: "failed" };
  }
  if (signal.aborted) return { kind: "aborted" };

  const body = payload as { text?: unknown; error?: unknown } | null;
  if (response.ok && typeof body?.text === "string") {
    return { kind: "ok", text: body.text };
  }
  return {
    kind: "error",
    code: isVoiceErrorCode(body?.error) ? body.error : "failed",
  };
}

/**
 * Asks, before the microphone is requested, whether voice input is switched on. The route sends
 * an empty probe to the API, which answers "not configured" before it looks at any audio.
 */
export async function probeVoice(
  signal: AbortSignal,
): Promise<"on" | "off" | "unreachable" | "aborted"> {
  const response = await post(
    `${TRANSCRIBE_PATH}?probe=1`,
    undefined,
    "audio/wav",
    signal,
  );
  if (response === "aborted") return "aborted";
  if (response === "unreachable") return "unreachable";
  try {
    const body = (await response.json()) as { available?: unknown };
    if (signal.aborted) return "aborted";
    if (body.available === true) return "on";
    return body.available === false ? "off" : "unreachable";
  } catch {
    return signal.aborted ? "aborted" : "unreachable";
  }
}
