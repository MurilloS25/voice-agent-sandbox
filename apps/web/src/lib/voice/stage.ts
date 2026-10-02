/**
 * What the voice stage is showing. Every value is derived from the real flow (the capture hook,
 * the turn in flight, the speech controller): nothing here is set by a timer.
 */
export type StageKind =
  | "start" // the voice session has not been started by the visitor yet
  | "ready"
  | "preparing" // waiting for the microphone permission
  | "listening"
  | "transcribing"
  | "review"
  | "thinking"
  | "speaking"
  | "error";

export const STAGE_COPY: Record<
  StageKind,
  {
    /** The state, in words. It is what a screen reader hears when the state changes. */
    label: string;
    hint: string;
    /** The name of the one primary control in this state. */
    action: string;
  }
> = {
  start: {
    label: "Talk to the workshop",
    hint: "Start plays a spoken welcome. Nothing is recorded until you tap to speak.",
    action: "Start voice assistant",
  },
  ready: {
    label: "Ready",
    hint: "Ask about services, open times or a booking.",
    action: "Tap to speak",
  },
  preparing: {
    label: "Getting the microphone ready",
    hint: "Allow it if your browser asks.",
    action: "Cancel",
  },
  listening: {
    label: "Listening",
    hint: "Press Stop when you are done. It stops by itself after 15 seconds.",
    action: "Stop",
  },
  transcribing: {
    label: "Transcribing",
    hint: "Turning your recording into text.",
    action: "Cancel transcription",
  },
  review: {
    label: "Review what I heard",
    hint: "Check the text and change it if you like. Nothing is sent until you send it.",
    action: "",
  },
  thinking: {
    label: "Thinking",
    hint: "Your message was sent. Waiting for the assistant's reply.",
    action: "Please wait",
  },
  speaking: {
    label: "Speaking",
    hint: "The assistant is reading its reply aloud. The text stays on screen.",
    action: "Stop speaking",
  },
  error: {
    label: "Something needs attention",
    hint: "",
    action: "Tap to speak",
  },
};

/** The spoken welcome's visible text lives with the welcome component; this is its identity. */
export const WELCOME_SPEECH_ID = "welcome";
export const PREVIEW_SPEECH_ID = "preview";
export const PREVIEW_TEXT =
  "Hi! This is how the workshop assistant will sound.";
