/**
 * Spoken replies through the browser's own `speechSynthesis`.
 *
 * What this is, and is not. It is the browser's synthesized voice, not a server feature, and it is
 * NOT assumed to be local: a voice whose `localService` is false may make the browser or the
 * operating system send the reply text to an external service. So a local voice is preferred, a
 * network voice is used only after the visitor agrees, and nothing is ever spoken without a
 * visitor action. A missing `speechSynthesis`, or an empty voice list, simply means "unavailable":
 * the chat keeps working in text.
 *
 * Only the text it is given is spoken. The caller passes a reply's visible text and nothing else
 * (never a proposal token, a hidden field, the timeline or a system notice).
 */

import {
  chooseVoice,
  clampRate,
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_KEY,
  SPEECH_DEFAULTS,
  voiceOptions,
  type VoiceChoice,
  type VoiceOption,
  type VoiceSettings,
} from "./voice-selection";

/** Long utterances are cut off by some browsers (Chrome stops around 15 s), so replies are split. */
export const MAX_CHUNK_CHARS = 180;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(month: number, year: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * "October 1, 2026" for a real calendar date, otherwise `undefined`. The date is validated from
 * its parts alone (month, day for that month, leap years): no `Date` parsing, so the machine's
 * time zone cannot change the result.
 */
function spokenDate(
  month: number,
  day: number,
  year: number,
): string | undefined {
  if (year < 1000 || year > 9999) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(month, year)) return undefined;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

// A date is recognised only as a whole token: not inside a longer word, number, identifier or
// path (so UUIDs, tokens, versions and phone numbers are left alone), and not when more digits
// follow after a dot, slash or hyphen.
const ISO_DATE = /(?<![\w./-])(\d{4})-(\d{2})-(\d{2})(?![\w-]|[./]\d)/g;
const US_DATE =
  /(?<![\w./-])(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?![\w/-]|[.]\d)/g;

/**
 * The text as it should be spoken. Only this changes: what is shown on the page is never touched.
 *
 * English (United States) only. The unambiguous numeric dates `YYYY-MM-DD`, `MM/DD/YYYY` and
 * `MM-DD-YYYY` (month first, as in en-US) become "October 1, 2026", so the voice says a date and
 * not separate digits. A date that does not exist (2026-02-30, month 13, a day 31 in a 30-day
 * month, 29 February in a common year) is left exactly as written, and so is everything that is
 * not a date: times, prices, phone numbers, quantities, identifiers, tokens and lone numbers.
 */
export function prepareTextForSpeech(text: string): string {
  return text
    .replace(ISO_DATE, (match, year: string, month: string, day: string) => {
      return spokenDate(Number(month), Number(day), Number(year)) ?? match;
    })
    .replace(
      US_DATE,
      (match, month: string, _separator: string, day: string, year: string) => {
        return spokenDate(Number(month), Number(day), Number(year)) ?? match;
      },
    );
}

/**
 * A deterministic split into sentence-sized chunks, in order and without repeating anything.
 * Joining the chunks with spaces gives back the text with its whitespace normalized, except that a
 * single word longer than the limit is cut in place (no space is invented inside it).
 *
 * The sentence split uses a lookbehind, which needs Safari 16.4 or later (the oldest Safari that
 * the app's Next.js build targets).
 */
export function splitForSpeech(
  text: string,
  maxChars: number = MAX_CHUNK_CHARS,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];

  const pieces: string[] = [];
  for (const sentence of normalized.split(/(?<=[.!?…])\s+/)) {
    let rest = sentence;
    while (rest.length > maxChars) {
      // Break an over-long sentence at the last space that fits, else exactly at the limit.
      const cut = rest.lastIndexOf(" ", maxChars);
      let at = cut > 0 ? cut : maxChars;
      // Never cut between the two halves of an emoji or another astral character.
      const before = rest.charCodeAt(at - 1);
      if (cut <= 0 && at > 1 && before >= 0xd800 && before <= 0xdbff) at -= 1;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest.length > 0) pieces.push(rest);
  }

  // Pack neighbouring sentences while they still fit in one chunk.
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + piece.length <= maxChars) {
      chunks[chunks.length - 1] = `${last} ${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks;
}

export { chooseVoice, type VoiceChoice } from "./voice-selection";

export type SpeechSnapshot = {
  /** Whether `speechSynthesis` exists at all. */
  supported: boolean;
  choice: VoiceChoice;
  /** The reply being read out, if any. */
  speakingId: string | null;
  /** The English voices the picker offers, local ones first. */
  voices: readonly VoiceOption[];
  /** The visitor's voice, speed and review choice: the only things ever stored. */
  settings: VoiceSettings;
  /** The selected voice is a network voice the visitor explicitly picked and agreed to use. */
  networkConsented: boolean;
};

export type SpeakResult =
  | "started"
  | "needs_consent" // only a network voice exists and the visitor has not agreed
  | "unavailable"; // no voice, no synthesis, or the browser refused

export type SpeechOutput = {
  getSnapshot(): SpeechSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Reads `text` aloud, with numeric dates made speakable (the caller's text is not changed).
   * Replaces anything already being spoken. Never throws.
   */
  speak(id: string, text: string, options?: SpeakOptions): SpeakResult;
  /** Picks a voice and/or speed. Stored, if storage is available, and applied to the next speech. */
  setSettings(change: Partial<VoiceSettings>): void;
  /** Back to the recommended voice and the defaults, and forgets what was stored. */
  resetSettings(): void;
  /**
   * The visitor agreed to use the voice now selected, a network voice. When they picked that
   * voice themselves the agreement is remembered in this browser (by exact name); for an
   * automatic choice it is not, and the caller keeps it for the page only.
   */
  agreeToNetworkVoice(): void;
  /** Forgets a remembered agreement. */
  withdrawNetworkVoice(): void;
  /** Stops speaking at once. Safe to call at any time. */
  stop(): void;
  /** Stops speaking and detaches from the browser. */
  dispose(): void;
};

export type SpeakOptions = {
  allowNetwork?: boolean;
  /**
   * Called once, when the browser reports that the first part of the reply actually began to
   * play. "Started" is not "queued": a refused or failed start never calls it.
   */
  onStart?: () => void;
  /**
   * Called when the browser fails or refuses part of this reply (for example an autoplay block).
   * Not called when the reply is stopped or replaced on purpose.
   */
  onError?: () => void;
};

export const UNSUPPORTED: SpeechSnapshot = {
  supported: false,
  choice: { kind: "none" },
  speakingId: null,
  voices: [],
  settings: DEFAULT_SETTINGS,
  networkConsented: false,
};

type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Synth = Pick<
  SpeechSynthesis,
  "speak" | "cancel" | "getVoices" | "addEventListener" | "removeEventListener"
>;
type UtteranceConstructor = new (text: string) => SpeechSynthesisUtterance;

/** The browser's storage, if it lets us have it (it can throw or be absent). */
export function browserStorage(): SettingsStorage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function readVoices(synth: Synth): SpeechSynthesisVoice[] {
  try {
    return [...synth.getVoices()];
  } catch {
    return []; // a failure to list voices means "no voice", never an error on the page
  }
}

export function createSpeechOutput(
  synth: Synth | undefined,
  Utterance: UtteranceConstructor | undefined,
  storage?: SettingsStorage,
): SpeechOutput {
  if (!synth || !Utterance) {
    // Nothing can be spoken, but the visitor's other choices (for example whether to review a
    // transcript before sending it) still work and are still remembered.
    const quiet = new Set<() => void>();
    let settings = DEFAULT_SETTINGS;
    try {
      settings = parseSettings(storage?.getItem(SETTINGS_KEY) ?? null);
    } catch {
      // storage refused: the defaults apply
    }
    let current: SpeechSnapshot = { ...UNSUPPORTED, settings };
    const change = (next: VoiceSettings, persist: boolean) => {
      try {
        if (persist) storage?.setItem(SETTINGS_KEY, JSON.stringify(next));
        else storage?.removeItem(SETTINGS_KEY);
      } catch {
        // not stored
      }
      current = { ...current, settings: next };
      quiet.forEach((listener) => listener());
    };
    return {
      getSnapshot: () => current,
      subscribe(listener) {
        quiet.add(listener);
        return () => quiet.delete(listener);
      },
      speak: () => "unavailable",
      setSettings: (patch) =>
        change(
          {
            ...current.settings,
            ...patch,
            rate: clampRate((patch.rate ?? current.settings.rate) as number),
            consentVoice: null,
          },
          true,
        ),
      resetSettings: () => change(DEFAULT_SETTINGS, false),
      agreeToNetworkVoice: () => undefined,
      withdrawNetworkVoice: () => undefined,
      stop: () => undefined,
      dispose: () => quiet.clear(),
    };
  }

  const listeners = new Set<() => void>();
  let generation = 0; // every speak or stop makes older callbacks stale
  let stored = DEFAULT_SETTINGS;
  try {
    stored = parseSettings(storage?.getItem(SETTINGS_KEY) ?? null);
  } catch {
    // storage refused: the defaults apply
  }
  const describe = (
    voices: SpeechSynthesisVoice[],
    settings: VoiceSettings,
  ) => {
    const choice = chooseVoice(voices, settings.voiceName);
    return {
      choice,
      voices: voiceOptions(voices),
      settings,
      networkConsented:
        choice.kind === "network" &&
        settings.consentVoice !== null &&
        settings.consentVoice === choice.voice.name &&
        settings.voiceName === choice.voice.name,
    };
  };
  let snapshot: SpeechSnapshot = {
    supported: true,
    speakingId: null,
    ...describe(readVoices(synth), stored),
  };

  const update = (next: Partial<SpeechSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };

  // Voices load late in some browsers: the list is read again whenever it changes.
  const onVoicesChanged = () =>
    update(describe(readVoices(synth), snapshot.settings));

  const changeSettings = (settings: VoiceSettings, persist: boolean) => {
    try {
      if (persist) storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
      else storage?.removeItem(SETTINGS_KEY);
    } catch {
      // not stored: the choice still applies to this page
    }
    update(describe(readVoices(synth), settings));
  };
  synth.addEventListener("voiceschanged", onVoicesChanged);

  const stop = () => {
    generation += 1;
    try {
      synth.cancel();
    } catch {
      // nothing to stop
    }
    if (snapshot.speakingId !== null) update({ speakingId: null });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSettings(change) {
      const next = { ...snapshot.settings, ...change };
      changeSettings(
        {
          ...next,
          rate: clampRate(next.rate),
          // An agreement belongs to one voice: picking another one ends it.
          consentVoice:
            next.consentVoice !== null && next.consentVoice === next.voiceName
              ? next.consentVoice
              : null,
        },
        true,
      );
    },
    resetSettings() {
      changeSettings(DEFAULT_SETTINGS, false);
    },
    agreeToNetworkVoice() {
      const { choice, settings } = snapshot;
      if (choice.kind !== "network") return;
      if (settings.voiceName === choice.voice.name) {
        changeSettings({ ...settings, consentVoice: choice.voice.name }, true);
      }
    },
    withdrawNetworkVoice() {
      if (snapshot.settings.consentVoice === null) return;
      changeSettings({ ...snapshot.settings, consentVoice: null }, true);
    },
    speak(id, text, { allowNetwork = false, onStart, onError } = {}) {
      const { choice } = snapshot;
      if (choice.kind === "none") return "unavailable";
      if (
        choice.kind === "network" &&
        !allowNetwork &&
        !snapshot.networkConsented
      ) {
        return "needs_consent";
      }
      // Dates are made speakable first, so a date is never cut up or read digit by digit.
      const chunks = splitForSpeech(prepareTextForSpeech(text));
      if (chunks.length === 0) return "unavailable";

      stop(); // replaces anything already being spoken
      const mine = generation;
      const finish = () => {
        // A callback from a replaced or stopped utterance must not touch the new state.
        if (generation === mine && snapshot.speakingId === id) {
          update({ speakingId: null });
        }
      };
      const fail = () => {
        if (generation !== mine) return;
        stop();
        onError?.();
      };
      try {
        chunks.forEach((chunk, index) => {
          const utterance = new Utterance(chunk);
          utterance.voice = choice.voice;
          utterance.lang = choice.voice.lang || SPEECH_DEFAULTS.lang;
          utterance.rate = snapshot.settings.rate;
          utterance.pitch = SPEECH_DEFAULTS.pitch;
          utterance.volume = SPEECH_DEFAULTS.volume;
          // An error on any chunk (a blocked start, for example by an autoplay policy, or a
          // failure part-way) silences the rest of the reply and ends quietly: Listen stays.
          utterance.onerror = fail;
          if (index === 0 && onStart) {
            utterance.onstart = () => {
              if (generation === mine) onStart();
            };
          }
          if (index === chunks.length - 1) utterance.onend = finish;
          synth.speak(utterance);
        });
      } catch {
        stop();
        return "unavailable";
      }
      update({ speakingId: id });
      return "started";
    },
    stop,
    dispose() {
      stop();
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      listeners.clear();
    },
  };
}
