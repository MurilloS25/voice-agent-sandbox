"use client";

import { PREVIEW_SPEECH_ID } from "@/lib/voice/stage";
import type { SpeechSnapshot } from "@/lib/voice/speech-output";
import { MAX_RATE, MIN_RATE, RATE_STEP } from "@/lib/voice/voice-selection";

const secondaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-full border border-bottle/40 bg-white px-5 py-2 font-bold [overflow-wrap:anywhere] hover:bg-celeste/40 disabled:opacity-60";

/** What "Network voice" means, in one place, without claiming anything about a provider. */
export const NETWORK_VOICE_EXPLANATION =
  "A network voice may send the text to your browser’s voice provider to generate audio. It requires an internet connection.";

type Props = {
  snapshot: SpeechSnapshot;
  /** The visitor agreed to use the network voice that is selected now. */
  networkConsent: boolean;
  /** The agreement is remembered in this browser (the visitor picked the voice themselves). */
  networkConsentRemembered: boolean;
  onConsent: () => void;
  onWithdraw: () => void;
  onVoice: (name: string | null) => void;
  onRate: (rate: number) => void;
  onReview: (review: boolean) => void;
  onPreview: () => void;
  onStopPreview: () => void;
  onReset: () => void;
  /** Something to tell the visitor now (for example that a network voice needs their say-so). */
  note: string;
};

/**
 * The voice picker. Voices are the browser's and the device's, never ours: what is offered, and
 * how good it sounds, depends on them. Nothing here changes a conversation or leaves the browser;
 * the voice, the speed, the agreement to a network voice the visitor picked, and the review
 * choice are the only things remembered (see `voice-selection.ts`).
 */
export function VoiceSettings({
  snapshot,
  networkConsent,
  networkConsentRemembered,
  onConsent,
  onWithdraw,
  onVoice,
  onRate,
  onReview,
  onPreview,
  onStopPreview,
  onReset,
  note,
}: Props) {
  const { supported, voices, settings, choice } = snapshot;
  const usable = supported && choice.kind !== "none";
  const selected = voices.some((voice) => voice.name === settings.voiceName)
    ? (settings.voiceName ?? "")
    : "";
  const previewing = snapshot.speakingId === PREVIEW_SPEECH_ID;
  const onlyNetwork =
    voices.length > 0 && voices.every((voice) => !voice.local);
  const network = choice.kind === "network";

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm">
        Voices come from your browser and your device, so what you hear and
        which voices exist depend on them. Replies always stay on screen too.
      </p>

      <div className="rounded-2xl bg-white p-3">
        <label className="flex min-h-12 items-start gap-3">
          <input
            type="checkbox"
            checked={settings.reviewBeforeSending}
            onChange={(event) => onReview(event.target.checked)}
            aria-describedby="review-help"
            className="mt-1 h-5 w-5 shrink-0 accent-bottle"
          />
          <span className="font-bold">Review transcript before sending</span>
        </label>
        <p id="review-help" className="mt-1 text-sm">
          Off: what you say is sent as soon as it is transcribed, and the reply
          is read aloud. On: you check and edit the text first. Booking is never
          confirmed by voice either way.
        </p>
      </div>

      {!usable ? (
        <p className="max-w-prose rounded-2xl border-l-8 border-rust bg-white p-3 font-bold">
          {supported
            ? "This browser has no English voice to offer. Replies stay on screen."
            : "This browser can't speak replies. They stay on screen."}
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="voice-select" className="block font-bold">
              Voice
            </label>
            <select
              id="voice-select"
              value={selected}
              onChange={(event) =>
                onVoice(event.target.value === "" ? null : event.target.value)
              }
              className="mt-1 min-h-12 w-full rounded-xl border border-bottle/40 bg-white px-3 py-2 text-base"
            >
              <option value="">Recommended (best local voice)</option>
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} ({voice.lang}) —{" "}
                  {voice.local ? "Local voice" : "Network voice"}
                  {voice.enhanced ? " — higher quality" : ""}
                </option>
              ))}
            </select>
            <p className="mt-2" data-testid="current-voice">
              <span className="font-bold">In use: </span>
              {"voice" in choice ? choice.voice.name : ""}{" "}
              <span className="rounded-full border border-bottle/40 px-2 py-0.5 text-sm font-bold">
                {network ? "Network voice" : "Local voice"}
              </span>
            </p>
            {selected !== "" ? (
              <button
                type="button"
                onClick={() => onVoice(null)}
                className={`${secondaryClass} mt-2`}
              >
                Back to the recommended voice
              </button>
            ) : null}
          </div>

          <div>
            <label htmlFor="voice-rate" className="block font-bold">
              Speed: {settings.rate.toFixed(2)}×
            </label>
            <input
              id="voice-rate"
              type="range"
              min={MIN_RATE}
              max={MAX_RATE}
              step={RATE_STEP}
              value={settings.rate}
              onChange={(event) => onRate(Number(event.target.value))}
              aria-valuetext={`${settings.rate.toFixed(2)} times normal speed`}
              className="mt-1 block min-h-12 w-full accent-bottle"
            />
            <p className="flex justify-between text-sm">
              <span>Slower</span>
              <span>Faster</span>
            </p>
          </div>

          {network ? (
            networkConsent ? (
              <div className="max-w-prose space-y-2 text-sm">
                <p className="font-bold">
                  Using a network voice. {NETWORK_VOICE_EXPLANATION}
                </p>
                <p>
                  {networkConsentRemembered
                    ? "Your agreement is remembered in this browser for this voice only."
                    : "Your agreement lasts until you leave this page."}
                </p>
                <button
                  type="button"
                  onClick={onWithdraw}
                  className={secondaryClass}
                >
                  Stop using network voice
                </button>
              </div>
            ) : (
              <div className="max-w-prose space-y-2 rounded-2xl border-l-8 border-rust bg-white p-3">
                <p className="font-bold text-rust">
                  {onlyNetwork
                    ? "Only a network voice is available"
                    : "You picked a network voice"}
                </p>
                <p className="text-sm">
                  {NETWORK_VOICE_EXPLANATION} Nothing is spoken until you agree.
                </p>
                <button
                  type="button"
                  onClick={onConsent}
                  className={secondaryClass}
                >
                  Use network voice
                </button>
              </div>
            )
          ) : (
            <p className="text-sm">
              Your browser reports the voice it uses as running on this device.
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={previewing ? onStopPreview : onPreview}
              className={secondaryClass}
            >
              {previewing ? "Stop preview" : "Preview voice"}
            </button>
            <button type="button" onClick={onReset} className={secondaryClass}>
              Restore defaults
            </button>
          </div>
        </>
      )}

      <p
        role="status"
        aria-live="polite"
        className={note ? "text-sm font-bold" : "sr-only"}
      >
        {note}
      </p>
    </div>
  );
}
