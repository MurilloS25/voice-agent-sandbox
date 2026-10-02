/**
 * Fakes for the browser's speech synthesis (jsdom has none). Nothing is ever spoken: utterances
 * are recorded, and a test decides when each one ends or fails.
 */
import { vi } from "vitest";

export type FakeVoiceInit = {
  name: string;
  lang?: string;
  localService?: boolean;
  default?: boolean;
};

export function fakeVoice({
  name,
  lang = "en-US",
  localService = true,
  default: isDefault = false,
}: FakeVoiceInit): SpeechSynthesisVoice {
  return { name, lang, localService, default: isDefault, voiceURI: name };
}

export class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

export class FakeSynth extends EventTarget {
  voices: SpeechSynthesisVoice[];
  spoken: FakeUtterance[] = [];
  cancelCount = 0;
  /** When set, `speak` throws, like a browser that refuses to start. */
  failSpeak = false;

  constructor(voices: SpeechSynthesisVoice[] = []) {
    super();
    this.voices = voices;
  }
  getVoices() {
    return this.voices;
  }
  speak(utterance: FakeUtterance) {
    if (this.failSpeak) throw new Error("not-allowed");
    this.spoken.push(utterance);
  }
  cancel() {
    this.cancelCount += 1;
  }
  /** The voice list arrives (or changes) after the page loaded. */
  setVoices(voices: SpeechSynthesisVoice[]) {
    this.voices = voices;
    this.dispatchEvent(new Event("voiceschanged"));
  }
  /** Every spoken text, in order. */
  get texts() {
    return this.spoken.map((utterance) => utterance.text);
  }
}

/** Installs a fake `speechSynthesis` and `SpeechSynthesisUtterance` on the window. */
export function installSpeech(voices: SpeechSynthesisVoice[] = []): FakeSynth {
  const synth = new FakeSynth(voices);
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return synth;
}
