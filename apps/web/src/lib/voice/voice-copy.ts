import type { CaptureErrorCode } from "./capture";
import type { VoiceErrorCode } from "./limits";

/** Everything that can go wrong after the first press, except a denied permission. */
export type CaptureProblem =
  | Exclude<CaptureErrorCode, "permission_denied" | "unsupported" | "cancelled">
  | VoiceErrorCode;

/** The words that differ between the text composer and the voice stage. */
export type Wording = {
  /** The name of the control that starts a recording. */
  record: string;
  /** What the visitor can do instead of speaking. */
  instead: string;
};

export const TEXT_WORDING: Wording = {
  record: "Speak",
  instead: "You can still type your message.",
};

export const VOICE_WORDING: Wording = {
  record: "Tap to speak",
  instead: "You can switch to Text and type your message instead.",
};

export function problemCopy(
  code: CaptureProblem,
  { record, instead }: Wording,
): { title: string; body: string } {
  switch (code) {
    case "permission_timeout":
      return {
        title: "The microphone prompt wasn't answered",
        body: `Press ${record} to try again. ${instead}`,
      };
    case "no_device":
      return {
        title: "No microphone was found",
        body: `Connect one and press ${record} again. ${instead}`,
      };
    case "device_busy":
      return {
        title: "The microphone can't be used right now",
        body: `Another app may be using it. ${instead}`,
      };
    case "format_unsupported":
      return {
        title: "This browser records in a format we can't use",
        body: instead,
      };
    case "too_short":
      return {
        title: "That recording was too short",
        body: `Press ${record}, say your message, then press Stop. ${instead}`,
      };
    case "too_large":
      return {
        title: "That recording was too large",
        body: `Try a shorter message. ${instead}`,
      };
    case "failed":
      return {
        title: "That didn't work",
        body: `The recording could not be turned into text. ${instead}`,
      };
    case "feature_off":
      return {
        title: "Voice input isn't switched on",
        body: `This demo has no transcription service connected. ${instead}`,
      };
    case "unsupported":
      return {
        title: "That recording format isn't accepted",
        body: instead,
      };
    case "invalid":
      return {
        title: "The recording couldn't be read",
        body: `Try recording again. ${instead}`,
      };
    case "no_speech":
      return {
        title: "No speech was found",
        body: `Try again, closer to the microphone. ${instead}`,
      };
    case "busy":
      return {
        title: "Voice input is busy",
        body: `Wait a moment and try again. ${instead}`,
      };
    case "timeout":
      return {
        title: "Transcription took too long",
        body: `Try again with a shorter message. ${instead}`,
      };
    case "unreachable":
      return { title: "Voice input can't be reached", body: instead };
    case "forbidden":
      return { title: "Voice input was refused", body: instead };
  }
}

export function deniedCopy({ record, instead }: Wording): {
  title: string;
  body: string;
} {
  return {
    title: "Microphone access is blocked",
    body: `Allow the microphone for this site in your browser's settings and press ${record} again. ${instead}`,
  };
}
