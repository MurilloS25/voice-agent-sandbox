/**
 * Voice limits shared by the browser and the same-origin route handler.
 *
 * The duration limits are client-side controls only: the API enforces the byte limit, the
 * container family, concurrency and time, and does not measure how long audio lasts.
 */
export const MAX_RECORDING_MS = 15_000;
export const MIN_RECORDING_MS = 300;
/**
 * The API's default limit (256 KB: 15 s of the browsers' own encodings with headroom). Checked in
 * the browser, in the route handler and in the API; `tests/speech/test_budget.py` in the API pins
 * the two sides together.
 */
export const MAX_AUDIO_BYTES = 256 * 1024;
/** How long to wait for the visitor to answer the browser's microphone prompt. */
export const PERMISSION_TIMEOUT_MS = 20_000;

export const ALLOWED_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
] as const;
export type AudioType = (typeof ALLOWED_AUDIO_TYPES)[number];

/** The allowed media type a Content-Type names, ignoring parameters such as `;codecs=opus`. */
export function audioTypeOf(
  contentType: string | null | undefined,
): AudioType | undefined {
  if (!contentType) return undefined;
  const essence = contentType.split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.find((type) => type === essence);
}

/** Public, fixed error codes the voice route returns and the page maps to messages. */
export type VoiceErrorCode =
  | "feature_off" // no speech provider is configured
  | "too_large"
  | "unsupported"
  | "invalid"
  | "no_speech"
  | "busy"
  | "failed"
  | "timeout"
  | "unreachable"
  | "forbidden"
  | "limit_reached"; // the demo's daily allowance for voice input is spent

export const VOICE_ERROR_CODES: readonly VoiceErrorCode[] = [
  "feature_off",
  "too_large",
  "unsupported",
  "invalid",
  "no_speech",
  "busy",
  "failed",
  "timeout",
  "unreachable",
  "forbidden",
  "limit_reached",
];
