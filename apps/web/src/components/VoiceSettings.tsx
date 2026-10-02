"use client";

import { PREVIEW_SPEECH_ID } from "@/lib/voice/stage";
import type { SpeechSnapshot } from "@/lib/voice/speech-output";
import { MAX_RATE, MIN_RATE, RATE_STEP } from "@/lib/voice/voice-selection";

const secondaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-full border border-bottle/40 bg-white px-5 py-2 font-bold [overflow-wrap:anywhere] hover:bg-celeste/40 disabled:opacity-60";

type Props = {
  snapshot: SpeechSnapshot;
  /** The visitor agreed to use a network voice on this page. */
  networkConsent: boolean;
  onConsent: () => void;
  onVoice: (name: string | null) => void;
  onRate: (rate: number) => void;
  onPreview: () => void;
  onStopPreview: () => void;
  onReset: () => void;
  /** Something to tell the visitor now (for example that a network voice needs their say-so). */
  note: string;
};

/**
 * The voice picker. Voices are the browser's and the device's, never ours: what is offered, and
 * how good it sounds, depends on them. Nothing here changes a conversation, and only the voice
 * name and the speed are remembered (see `voice-selection.ts`).
 */
export function VoiceSettings({
  snapshot,
  networkConsent,
  onConsent,
  onVoice,
  onRate,
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

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm">
        Voices come from your browser and your device, so what you hear and
        which voices exist depend on them. Replies always stay on screen too.
      </p>

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
              <option value="">Automatic (best voice on this device)</option>
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} ({voice.lang})
                  {voice.local ? "" : " — network voice"}
                  {voice.enhanced ? " — higher quality" : ""}
                </option>
              ))}
            </select>
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

          {choice.kind === "network" ? (
            networkConsent ? (
              <p className="max-w-prose text-sm font-bold">
                Using a network voice: the reply text may be sent to a speech
                service run by your browser or operating system.
              </p>
            ) : (
              <div className="max-w-prose space-y-2 rounded-2xl border-l-8 border-rust bg-white p-3">
                <p className="font-bold text-rust">
                  {onlyNetwork
                    ? "Only a network voice is available"
                    : "You picked a network voice"}
                </p>
                <p className="text-sm">
                  Using it may send the text of each reply to a speech service
                  run by your browser or operating system. Nothing is spoken
                  until you agree.
                </p>
                <button
                  type="button"
                  onClick={onConsent}
                  className={secondaryClass}
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
