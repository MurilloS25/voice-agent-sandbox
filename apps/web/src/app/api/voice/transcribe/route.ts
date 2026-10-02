/**
 * Same-origin proxy for voice transcription.
 *
 * Why a route handler and not a Server Action: a Server Action cannot be cancelled once started
 * (the client's `callServer` takes no signal, and actions are dispatched one at a time, so a
 * pending transcription would also hold up `sendTurn` and the booking confirmation behind it).
 * Here `request.signal` ends when the visitor cancels or leaves, and it is forwarded to the call
 * to the API. See docs/decisions/0009-voice-input-and-spoken-output.md.
 *
 * The browser calls only this origin; the API address and every key stay on the server. The audio
 * and the transcript are never logged or stored: this module has no logging at all.
 */
import { sendTranscription } from "@/lib/api/client";
import {
  audioTypeOf,
  MAX_AUDIO_BYTES,
  type VoiceErrorCode,
} from "@/lib/voice/limits";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store" } as const;

function failure(code: VoiceErrorCode, status: number): Response {
  return Response.json({ error: code }, { status, headers: HEADERS });
}

/** A cross-site page must not be able to make the visitor's browser post audio here. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The body, read incrementally and never beyond the limit. `undefined` when it is too big. */
async function readBounded(request: Request): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > MAX_AUDIO_BYTES) {
      await reader.cancel(); // stop reading; nothing over the limit was kept
      return undefined;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const CODES: Record<string, [VoiceErrorCode, number]> = {
  speech_unavailable: ["feature_off", 503],
  audio_too_large: ["too_large", 413],
  audio_unsupported: ["unsupported", 415],
  audio_invalid: ["invalid", 422],
  validation_error: ["invalid", 422],
  no_speech: ["no_speech", 422],
  speech_busy: ["busy", 429],
  transcription_failed: ["failed", 502],
  transcription_timeout: ["timeout", 504],
};

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failure("forbidden", 403);

  // Probe: is voice switched on? The API answers "not configured" before it reads any audio.
  if (new URL(request.url).searchParams.get("probe") === "1") {
    const probe = await sendTranscription(
      new Uint8Array(0),
      "audio/wav",
      request.signal,
    );
    if (probe.kind === "unavailable") return failure("unreachable", 502);
    const off = probe.kind === "error" && probe.code === "speech_unavailable";
    return Response.json({ available: !off }, { headers: HEADERS });
  }

  const type = audioTypeOf(request.headers.get("content-type"));
  if (!type) return failure("unsupported", 415);

  // Content-Length can only reject early; the bytes are counted as they arrive.
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_AUDIO_BYTES
  ) {
    return failure("too_large", 413);
  }

  let audio: Uint8Array | undefined;
  try {
    audio = await readBounded(request);
  } catch {
    // The visitor cancelled or left while the upload was still arriving.
    return failure("failed", 400);
  }
  if (audio === undefined) return failure("too_large", 413);
  if (audio.byteLength === 0) return failure("invalid", 422);

  const result = await sendTranscription(audio, type, request.signal);
  if (result.kind === "ok") {
    return Response.json({ text: result.data.text }, { headers: HEADERS });
  }
  if (result.kind === "unavailable") return failure("unreachable", 502);
  const [code, status] = CODES[result.code] ?? ["failed", 502];
  return failure(code, status);
}
