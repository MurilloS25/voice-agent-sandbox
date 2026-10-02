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

export type VoiceChoice =
  | { kind: "none" } // no speechSynthesis, or no suitable voice
  | { kind: "local"; voice: SpeechSynthesisVoice }
  | { kind: "network"; voice: SpeechSynthesisVoice };

function isEnglish(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().replace("_", "-").split("-")[0] === "en";
}

/** A local English voice first, then a network English one, otherwise none. */
export function chooseVoice(
  voices: readonly SpeechSynthesisVoice[],
): VoiceChoice {
  const english = voices.filter(isEnglish);
  const preferred = (list: SpeechSynthesisVoice[]) =>
    list.find((voice) => voice.default) ?? list[0];
  const local = preferred(english.filter((voice) => voice.localService));
  if (local) return { kind: "local", voice: local };
  const network = preferred(english.filter((voice) => !voice.localService));
  if (network) return { kind: "network", voice: network };
  return { kind: "none" };
}

export type SpeechSnapshot = {
  /** Whether `speechSynthesis` exists at all. */
  supported: boolean;
  choice: VoiceChoice;
  /** The reply being read out, if any. */
  speakingId: string | null;
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
  speak(
    id: string,
    text: string,
    options?: { allowNetwork?: boolean },
  ): SpeakResult;
  /** Stops speaking at once. Safe to call at any time. */
  stop(): void;
  /** Stops speaking and detaches from the browser. */
  dispose(): void;
};

export const UNSUPPORTED: SpeechSnapshot = {
  supported: false,
  choice: { kind: "none" },
  speakingId: null,
};

type Synth = Pick<
  SpeechSynthesis,
  "speak" | "cancel" | "getVoices" | "addEventListener" | "removeEventListener"
>;
type UtteranceConstructor = new (text: string) => SpeechSynthesisUtterance;

export function createSpeechOutput(
  synth: Synth | undefined,
  Utterance: UtteranceConstructor | undefined,
): SpeechOutput {
  if (!synth || !Utterance) {
    return {
      getSnapshot: () => UNSUPPORTED,
      subscribe: () => () => undefined,
      speak: () => "unavailable",
      stop: () => undefined,
      dispose: () => undefined,
    };
  }

  const listeners = new Set<() => void>();
  let generation = 0; // every speak or stop makes older callbacks stale
  let snapshot: SpeechSnapshot = {
    supported: true,
    choice: chooseVoice(synth.getVoices()),
    speakingId: null,
  };

  const update = (next: Partial<SpeechSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };

  // Voices load late in some browsers: the list is read again whenever it changes.
  const onVoicesChanged = () =>
    update({ choice: chooseVoice(synth.getVoices()) });
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
    speak(id, text, { allowNetwork = false } = {}) {
      const { choice } = snapshot;
      if (choice.kind === "none") return "unavailable";
      if (choice.kind === "network" && !allowNetwork) return "needs_consent";
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
        if (generation === mine) stop();
      };
      try {
        chunks.forEach((chunk, index) => {
          const utterance = new Utterance(chunk);
          utterance.voice = choice.voice;
          utterance.lang = choice.voice.lang;
          // An error on any chunk (a blocked start, for example by an autoplay policy, or a
          // failure part-way) silences the rest of the reply and ends quietly: Listen stays.
          utterance.onerror = fail;
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
