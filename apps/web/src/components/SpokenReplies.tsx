"use client";

import type { SpeechSnapshot } from "@/lib/voice/speech-output";

type SpokenRepliesProps = {
  snapshot: SpeechSnapshot;
  /** The "Read replies aloud" switch. It lives in memory only and starts off. */
  readAloud: boolean;
  onReadAloud: (on: boolean) => void;
  /** The visitor agreed to use a network voice for this page. */
  networkConsent: boolean;
  onConsent: () => void;
  /** Something to tell the visitor now (for example that a network voice needs their say-so). */
  note: string;
};

/**
 * The visitor's controls for spoken replies. Nothing here is on by default, and nothing speaks
 * until the visitor sends a message with "Read replies aloud" on, or presses Listen on a reply.
 *
 * The voice is the browser's synthesized voice. It is not assumed to be local: a network voice
 * may make the browser or the operating system send the reply text to an external service, so it
 * needs an explicit yes first.
 */
export function SpokenReplies({
  snapshot,
  readAloud,
  onReadAloud,
  networkConsent,
  onConsent,
  note,
}: SpokenRepliesProps) {
  // No speech synthesis, or no usable voice: nothing to offer, and the chat stays text.
  if (!snapshot.supported || snapshot.choice.kind === "none") return null;
  const network = snapshot.choice.kind === "network";

  return (
    <section
      aria-labelledby="spoken-heading"
      className="mt-6 max-w-2xl space-y-3 border-l-4 border-moss pl-4"
    >
      <h3 id="spoken-heading" className="font-bold">
        Synthesized voice
      </h3>

      <label className="flex min-h-12 items-start gap-3">
        <input
          type="checkbox"
          checked={readAloud}
          onChange={(event) => onReadAloud(event.target.checked)}
          className="mt-1.5 h-5 w-5 shrink-0"
        />
        <span className="[overflow-wrap:anywhere]">Read replies aloud</span>
      </label>
      <p className="text-sm">
        Off by default. When it is on, your browser reads each assistant reply
        aloud after you send a message. You can also press Listen on any reply.
      </p>

      {network ? (
        networkConsent ? (
          <p className="text-sm font-bold">
            Using a network voice: the reply text may be sent to a speech
            service run by your browser or operating system.
          </p>
        ) : (
          <div className="space-y-2 border-l-8 border-rust bg-white/60 p-3">
            <p className="font-bold text-rust">
              Only a network voice is available
            </p>
            <p className="text-sm">
              Your browser has no voice that runs on this device. Using the
              network voice may send the text of each reply to a speech service
              run by your browser or operating system. Nothing is spoken until
              you agree.
            </p>
            <button
              type="button"
              onClick={onConsent}
              className="min-h-12 border-2 border-bottle px-4 py-2 font-bold [overflow-wrap:anywhere] hover:bg-hivis"
            >
              Use the network voice
            </button>
          </div>
        )
      ) : (
        <p className="text-sm">
          Your browser reports the voice it uses as running on this device.
        </p>
      )}

      <p
        role="status"
        aria-live="polite"
        className={note ? "text-sm" : "sr-only"}
      >
        {note}
      </p>
    </section>
  );
}
