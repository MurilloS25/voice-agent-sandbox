import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeVoice, FakeSynth, FakeUtterance } from "@/test/speech-fakes";

import { createSpeechOutput as create } from "./speech-output";

type Storage = Parameters<typeof create>[2];

function createSpeechOutput(
  synth: FakeSynth,
  _Utterance: typeof FakeUtterance,
  storage?: Storage,
) {
  return create(
    synth as unknown as SpeechSynthesis,
    FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    storage,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = "quillwheel.voice-settings.v1";
const DEFAULTS = {
  voiceName: null,
  rate: 0.95,
  consentVoice: null,
  reviewBeforeSending: false,
};
const PLAIN = fakeVoice({ name: "Plain" });
const NATURAL = fakeVoice({ name: "Fine Natural" });

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("voices and settings", () => {
  it("lists the English voices and picks the best local one by default", () => {
    const synth = new FakeSynth([
      PLAIN,
      NATURAL,
      fakeVoice({ name: "Es", lang: "es-ES" }),
    ]);
    const snap = createSpeechOutput(synth, FakeUtterance).getSnapshot();
    expect(snap.voices.map((v) => v.name)).toEqual(["Fine Natural", "Plain"]);
    expect(snap.choice).toEqual({ kind: "local", voice: NATURAL });
    expect(snap.settings).toEqual(DEFAULTS);
  });

  it("reloads the list on voiceschanged and applies a saved choice that appears late", () => {
    const storage = memoryStorage({
      [KEY]: '{"voiceName":"Plain","rate":1}',
    });
    const synth = new FakeSynth([]);
    const out = createSpeechOutput(synth, FakeUtterance, storage);
    expect(out.getSnapshot().choice).toEqual({ kind: "none" });
    const seen = vi.fn();
    out.subscribe(seen);

    synth.setVoices([NATURAL, PLAIN]);

    expect(seen).toHaveBeenCalled();
    expect(out.getSnapshot().choice).toEqual({ kind: "local", voice: PLAIN });
  });

  it("falls back to the automatic voice when the saved voice no longer exists", () => {
    const storage = memoryStorage({ [KEY]: '{"voiceName":"Gone","rate":1}' });
    const out = createSpeechOutput(
      new FakeSynth([PLAIN]),
      FakeUtterance,
      storage,
    );
    expect(out.getSnapshot().choice).toEqual({ kind: "local", voice: PLAIN });
    expect(out.getSnapshot().settings.rate).toBe(1);
  });

  it("ignores an invalid stored value", () => {
    const storage = memoryStorage({ [KEY]: "{{{" });
    const out = createSpeechOutput(
      new FakeSynth([PLAIN]),
      FakeUtterance,
      storage,
    );
    expect(out.getSnapshot().settings).toEqual(DEFAULTS);
  });

  it("stores only the voice name and the rate, and speaks with them", () => {
    const storage = memoryStorage();
    const synth = new FakeSynth([PLAIN, NATURAL]);
    const out = createSpeechOutput(synth, FakeUtterance, storage);

    out.setSettings({ voiceName: "Plain", rate: 1.2 });
    expect(JSON.parse(storage.data.get(KEY) ?? "")).toEqual({
      ...DEFAULTS,
      voiceName: "Plain",
      rate: 1.2,
    });

    out.speak("a", "Hello there.");
    expect(synth.spoken[0]).toMatchObject({
      voice: PLAIN,
      rate: 1.2,
      pitch: 1,
      volume: 1,
    });
    expect(storage.data.get(KEY)).not.toContain("Hello");
  });

  it("clamps an out-of-range rate", () => {
    const out = createSpeechOutput(
      new FakeSynth([PLAIN]),
      FakeUtterance,
      memoryStorage(),
    );
    out.setSettings({ rate: 9 });
    expect(out.getSnapshot().settings.rate).toBe(1.25);
  });

  it("restores the defaults and forgets the stored values", () => {
    const storage = memoryStorage();
    const out = createSpeechOutput(
      new FakeSynth([PLAIN, NATURAL]),
      FakeUtterance,
      storage,
    );
    out.setSettings({ voiceName: "Plain", rate: 1.2 });
    out.resetSettings();
    expect(out.getSnapshot().settings).toEqual(DEFAULTS);
    expect(out.getSnapshot().choice).toEqual({
      kind: "local",
      voice: NATURAL,
    });
    expect(storage.data.size).toBe(0);
  });

  it("still works when storage throws", () => {
    const refuse = () => {
      throw new Error("blocked");
    };
    const broken = { getItem: refuse, setItem: refuse, removeItem: refuse };
    const out = createSpeechOutput(
      new FakeSynth([PLAIN]),
      FakeUtterance,
      broken,
    );
    expect(() => out.setSettings({ rate: 1.1 })).not.toThrow();
    expect(out.getSnapshot().settings.rate).toBe(1.1);
    expect(() => out.resetSettings()).not.toThrow();
    expect(out.speak("a", "Hi there.")).toBe("started");
  });

  it("a list that cannot be read means no voice, not an error", () => {
    const synth = new FakeSynth([PLAIN]);
    synth.getVoices = () => {
      throw new Error("nope");
    };
    const out = createSpeechOutput(synth, FakeUtterance);
    expect(out.getSnapshot().choice).toEqual({ kind: "none" });
    expect(out.speak("a", "Hi.")).toBe("unavailable");
  });
});

describe("knowing that speech really started", () => {
  it("calls onStart when the browser reports the start, not when the reply is only queued", () => {
    const synth = new FakeSynth([PLAIN]);
    const out = createSpeechOutput(synth, FakeUtterance);
    const onStart = vi.fn();
    out.speak("a", "One. ".repeat(80), { onStart });
    expect(onStart).not.toHaveBeenCalled();

    synth.spoken[0].onstart?.();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("never calls onStart when the start is refused", () => {
    const synth = new FakeSynth([PLAIN]);
    const out = createSpeechOutput(synth, FakeUtterance);
    const onStart = vi.fn();
    out.speak("a", "Second reply.", { onStart });
    synth.spoken[0].onerror?.();
    expect(onStart).not.toHaveBeenCalled();
    expect(out.getSnapshot().speakingId).toBeNull();
  });

  it("never calls onStart when speak throws", () => {
    const synth = new FakeSynth([PLAIN]);
    synth.failSpeak = true;
    const out = createSpeechOutput(synth, FakeUtterance);
    const onStart = vi.fn();
    expect(out.speak("a", "Hello.", { onStart })).toBe("unavailable");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ignores the start of a reply that was replaced", () => {
    const synth = new FakeSynth([PLAIN]);
    const out = createSpeechOutput(synth, FakeUtterance);
    const onStart = vi.fn();
    out.speak("a", "First.", { onStart });
    const first = synth.spoken[0];
    out.speak("b", "Second.");
    first.onstart?.();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("network voice agreement", () => {
  const NET = fakeVoice({ name: "Net", localService: false });
  const NET2 = fakeVoice({ name: "Net2", localService: false });

  it("remembers an agreement only for a voice the visitor picked", () => {
    const storage = memoryStorage();
    const out = createSpeechOutput(
      new FakeSynth([PLAIN, NET]),
      FakeUtterance,
      storage,
    );
    out.agreeToNetworkVoice(); // the automatic choice is local: nothing to agree to
    expect(storage.data.size).toBe(0);

    out.setSettings({ voiceName: "Net" });
    expect(out.speak("a", "Hi.")).toBe("needs_consent");
    out.agreeToNetworkVoice();
    expect(JSON.parse(storage.data.get(KEY) ?? "")).toMatchObject({
      voiceName: "Net",
      consentVoice: "Net",
    });
    expect(out.getSnapshot().networkConsented).toBe(true);
    expect(out.speak("a", "Hi.")).toBe("started");
  });

  it("does not remember an agreement for an automatic network choice", () => {
    const storage = memoryStorage();
    const out = createSpeechOutput(
      new FakeSynth([NET]),
      FakeUtterance,
      storage,
    );
    out.agreeToNetworkVoice();
    expect(storage.data.size).toBe(0);
    expect(out.getSnapshot().networkConsented).toBe(false);
  });

  it("ends the agreement when another voice is picked, or when it is withdrawn", () => {
    const storage = memoryStorage({
      [KEY]: '{"voiceName":"Net","consentVoice":"Net"}',
    });
    const out = createSpeechOutput(
      new FakeSynth([PLAIN, NET, NET2]),
      FakeUtterance,
      storage,
    );
    expect(out.getSnapshot().networkConsented).toBe(true);
    out.setSettings({ voiceName: "Net2" });
    expect(out.getSnapshot().networkConsented).toBe(false);
    expect(JSON.parse(storage.data.get(KEY) ?? "").consentVoice).toBeNull();

    out.setSettings({ voiceName: "Net" });
    out.agreeToNetworkVoice();
    out.withdrawNetworkVoice();
    expect(out.getSnapshot().networkConsented).toBe(false);
    expect(out.speak("a", "Hi.")).toBe("needs_consent");
  });

  it("an agreement is void if the remembered voice is gone", () => {
    const storage = memoryStorage({
      [KEY]: '{"voiceName":"Net","consentVoice":"Net"}',
    });
    const out = createSpeechOutput(
      new FakeSynth([PLAIN]),
      FakeUtterance,
      storage,
    );
    expect(out.getSnapshot().choice).toMatchObject({ kind: "local" });
    expect(out.getSnapshot().networkConsented).toBe(false);
  });
});

describe("without speech synthesis", () => {
  it("still keeps the visitor's other choices", () => {
    const storage = memoryStorage();
    const out = create(undefined, undefined, storage);
    out.setSettings({ reviewBeforeSending: true });
    expect(out.getSnapshot().settings.reviewBeforeSending).toBe(true);
    expect(out.getSnapshot().supported).toBe(false);
    expect(JSON.parse(storage.data.get(KEY) ?? "").reviewBeforeSending).toBe(
      true,
    );
    const again = create(undefined, undefined, storage);
    expect(again.getSnapshot().settings.reviewBeforeSending).toBe(true);
    again.resetSettings();
    expect(again.getSnapshot().settings.reviewBeforeSending).toBe(false);
  });
});
