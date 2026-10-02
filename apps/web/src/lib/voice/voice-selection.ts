/**
 * Choosing and configuring the browser's synthesized voice. Pure functions only: nothing here
 * touches `speechSynthesis` or `localStorage`.
 *
 * Ranking rule. Only English voices are candidates. Local voices (running on this device) come
 * before network voices, because a network voice may send the reply text to a speech service
 * (ADR 0009) and so always needs the visitor's explicit yes. Inside each group, a voice whose
 * name suggests a better engine ranks higher: Natural, then Enhanced and Premium, then Online;
 * en-US edges out other English, and the browser's default voice breaks the remaining ties.
 * Nothing depends on a vendor's exact voice names.
 */

export type VoiceSettings = {
  /** The voice the visitor picked, or null for the recommended choice. */
  voiceName: string | null;
  /** Speaking rate, 1 being normal speed. */
  rate: number;
  /**
   * The network voice the visitor explicitly picked and then agreed to use, by exact name. It
   * counts only while that same voice is the selected one. Never set for an automatic choice.
   */
  consentVoice: string | null;
  /** Show the transcript for checking before it is sent. Off: a heard sentence is sent. */
  reviewBeforeSending: boolean;
};

export const MIN_RATE = 0.75;
export const MAX_RATE = 1.25;
export const RATE_STEP = 0.05;

export const SPEECH_DEFAULTS = {
  lang: "en-US",
  rate: 0.95,
  pitch: 1,
  volume: 1,
} as const;

export const DEFAULT_SETTINGS: VoiceSettings = {
  voiceName: null,
  rate: SPEECH_DEFAULTS.rate,
  consentVoice: null,
  reviewBeforeSending: false,
};

export type VoiceChoice =
  | { kind: "none" } // no speechSynthesis, or no suitable voice
  | { kind: "local"; voice: SpeechSynthesisVoice }
  | { kind: "network"; voice: SpeechSynthesisVoice };

/** What the voice picker needs to show about one voice. */
export type VoiceOption = {
  name: string;
  lang: string;
  /** Runs on this device. A voice that is not local may send text to a speech service. */
  local: boolean;
  /** The name suggests a higher-quality engine (Natural, Enhanced, Premium, Online). */
  enhanced: boolean;
};

export function isEnglish(voice: { lang: string }): boolean {
  return voice.lang.toLowerCase().replace("_", "-").split("-")[0] === "en";
}

const QUALITY_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/natural/i, 8],
  [/enhanced/i, 4],
  [/premium/i, 4],
  [/online/i, 2],
];

function qualityScore(voice: SpeechSynthesisVoice): number {
  const name = voice.name ?? "";
  let score = QUALITY_WORDS.reduce(
    (sum, [pattern, weight]) => sum + (pattern.test(name) ? weight : 0),
    0,
  );
  if (voice.lang.toLowerCase().replace("_", "-") === "en-us") score += 1;
  return score;
}

export function isEnhanced(voice: SpeechSynthesisVoice): boolean {
  return QUALITY_WORDS.some(([pattern]) => pattern.test(voice.name ?? ""));
}

/** English voices, local before network, best name first; the browser's default breaks ties. */
export function rankVoices(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] {
  return voices
    .filter(isEnglish)
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => {
      if (a.voice.localService !== b.voice.localService) {
        return a.voice.localService ? -1 : 1;
      }
      const byQuality = qualityScore(b.voice) - qualityScore(a.voice);
      if (byQuality !== 0) return byQuality;
      if (a.voice.default !== b.voice.default) return a.voice.default ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ voice }) => voice);
}

export function voiceOptions(
  voices: readonly SpeechSynthesisVoice[],
): VoiceOption[] {
  return rankVoices(voices).map((voice) => ({
    name: voice.name,
    lang: voice.lang,
    local: voice.localService,
    enhanced: isEnhanced(voice),
  }));
}

function choiceFor(voice: SpeechSynthesisVoice): VoiceChoice {
  return voice.localService
    ? { kind: "local", voice }
    : { kind: "network", voice };
}

/**
 * The voice to speak with. The visitor's pick wins when that voice still exists; otherwise the
 * best-ranked English voice (a local one if there is one). Never throws: a failure to read the
 * list means "no voice".
 */
export function chooseVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferredName: string | null = null,
): VoiceChoice {
  try {
    const ranked = rankVoices(voices);
    const picked =
      preferredName === null
        ? undefined
        : ranked.find((voice) => voice.name === preferredName);
    const voice = picked ?? ranked[0];
    return voice ? choiceFor(voice) : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

export function clampRate(value: number): number {
  const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Number(stepped.toFixed(2))));
}

const MAX_NAME_LENGTH = 200;

/**
 * Settings read from storage, checked field by field. Anything that is not exactly what was
 * saved (not JSON, wrong types, a rate outside the range, an over-long name) falls back to the
 * default for that field. Extra fields are ignored.
 */
export function parseSettings(raw: string | null): VoiceSettings {
  if (raw === null) return DEFAULT_SETTINGS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return DEFAULT_SETTINGS;
  }
  const { voiceName, rate, consentVoice, reviewBeforeSending } = data as Record<
    string,
    unknown
  >;
  const name = (value: unknown) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH
      ? value
      : null;
  const picked = name(voiceName);
  return {
    voiceName: picked,
    // An agreement is only meaningful for the voice that was explicitly picked.
    consentVoice:
      picked !== null && name(consentVoice) === picked ? picked : null,
    reviewBeforeSending: reviewBeforeSending === true,
    rate:
      typeof rate === "number" &&
      Number.isFinite(rate) &&
      rate >= MIN_RATE &&
      rate <= MAX_RATE
        ? rate
        : DEFAULT_SETTINGS.rate,
  };
}

export const SETTINGS_KEY = "quillwheel.voice-settings.v1";
