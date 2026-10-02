import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fakeVoice,
  FakeSynth,
  FakeUtterance,
  installSpeech,
} from "@/test/speech-fakes";

import {
  chooseVoice,
  createSpeechOutput,
  MAX_CHUNK_CHARS,
  splitForSpeech,
  UNSUPPORTED,
} from "./speech-output";

afterEach(() => {
  vi.unstubAllGlobals();
});

const LOCAL = fakeVoice({ name: "Local", localService: true });
const NETWORK = fakeVoice({ name: "Network", localService: false });

function output(voices = [LOCAL]) {
  const synth = new FakeSynth(voices);
  return {
    synth,
    out: createSpeechOutput(
      synth as unknown as SpeechSynthesis,
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    ),
  };
}

describe("splitForSpeech", () => {
  it("returns nothing for empty or blank text", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("  \n\t ")).toEqual([]);
  });

  it("keeps a short reply in one chunk with its whitespace normalized", () => {
    expect(splitForSpeech("  Hello   there.\nHow are you? ")).toEqual([
      "Hello there. How are you?",
    ]);
  });

  it("splits long replies at sentence ends, in order, within the limit", () => {
    const sentence =
      "This is a sentence of a reasonable length that goes on a bit.";
    const text = Array.from({ length: 12 }, () => sentence).join(" ");
    const chunks = splitForSpeech(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(chunk.endsWith(".")).toBe(true); // cut at sentence boundaries
    }
  });

  it("never loses, repeats or reorders anything", () => {
    const text =
      "First thing. Second thing! A third, much longer thing that rambles " +
      "on and on without any full stop for quite a while so that it must be " +
      "broken at a space rather than at a sentence end, and then some more " +
      "words follow it until the sentence finally finishes? Last bit.";
    for (const limit of [20, 45, 80, 180]) {
      const chunks = splitForSpeech(text, limit);
      expect(chunks.join(" ")).toBe(text.replace(/\s+/g, " ").trim());
      expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
    }
  });

  it("never splits an emoji or another astral character in the middle", () => {
    const text = "😀".repeat(20); // each one is two UTF-16 code units
    for (const limit of [3, 5, 7]) {
      const chunks = splitForSpeech(text, limit);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) {
        const first = chunk.charCodeAt(0);
        const last = chunk.charCodeAt(chunk.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no lone low surrogate
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no lone high surrogate
      }
    }
  });

  it("cuts an over-long word in place without inventing spaces inside it", () => {
    const word = "a".repeat(50);
    expect(splitForSpeech(word, 20).join("")).toBe(word);
  });

  it("breaks a word longer than the limit exactly at the limit", () => {
    const chunks = splitForSpeech("a".repeat(50), 20);
    expect(chunks).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(10)]);
  });

  it("is deterministic", () => {
    const text = "One. Two. Three. ".repeat(40);
    expect(splitForSpeech(text)).toEqual(splitForSpeech(text));
  });
});

describe("chooseVoice", () => {
  it("prefers a local English voice, and the default one among them", () => {
    const other = fakeVoice({ name: "Other", default: true });
    expect(chooseVoice([NETWORK, LOCAL, other])).toEqual({
      kind: "local",
      voice: other,
    });
    expect(chooseVoice([NETWORK, LOCAL])).toEqual({
      kind: "local",
      voice: LOCAL,
    });
  });

  it("falls back to a network English voice, marked as such", () => {
    expect(chooseVoice([NETWORK])).toEqual({ kind: "network", voice: NETWORK });
  });

  it("never picks a voice for another language", () => {
    expect(chooseVoice([fakeVoice({ name: "Es", lang: "es-ES" })])).toEqual({
      kind: "none",
    });
    expect(
      chooseVoice([fakeVoice({ name: "En", lang: "en_GB" })]),
    ).toMatchObject({
      kind: "local",
    });
  });

  it("is none when there are no voices", () => {
    expect(chooseVoice([])).toEqual({ kind: "none" });
  });
});

describe("a browser without speech synthesis", () => {
  it("is unsupported, never throws and never speaks", () => {
    const out = createSpeechOutput(undefined, undefined);
    expect(out.getSnapshot()).toBe(UNSUPPORTED);
    expect(out.speak("a", "Hello")).toBe("unavailable");
    expect(() => {
      out.stop();
      out.dispose();
      out.subscribe(() => undefined)();
    }).not.toThrow();
  });
});

describe("speaking", () => {
  it("reads chunks in order with the chosen voice", () => {
    const { synth, out } = output();
    const text = "First sentence here. ".repeat(20);

    expect(out.speak("reply-1", text)).toBe("started");

    expect(synth.spoken.length).toBeGreaterThan(1);
    expect(
      synth.spoken.every((u) => u.voice === LOCAL && u.lang === "en-US"),
    ).toBe(true);
    expect(synth.texts.join(" ")).toBe(text.replace(/\s+/g, " ").trim());
    expect(out.getSnapshot().speakingId).toBe("reply-1");
  });

  it("ends when the last chunk ends", () => {
    const { synth, out } = output();
    out.speak("a", "One. ".repeat(80));
    const last = synth.spoken[synth.spoken.length - 1];
    last.onend?.();
    expect(out.getSnapshot().speakingId).toBeNull();
  });

  it("stop cancels at once", () => {
    const { synth, out } = output();
    out.speak("a", "Hello there.");
    out.stop();
    expect(out.getSnapshot().speakingId).toBeNull();
    expect(synth.cancelCount).toBeGreaterThanOrEqual(2); // once before speaking, once on stop
    out.stop(); // harmless when idle
  });

  it("a new reply replaces the old one and the old one's callbacks are ignored", () => {
    const { synth, out } = output();
    out.speak("a", "First reply.");
    const first = synth.spoken[0];
    out.speak("b", "Second reply.");

    first.onend?.(); // a late callback from the replaced utterance
    first.onerror?.();

    expect(out.getSnapshot().speakingId).toBe("b");
  });

  it("an error on a middle chunk silences the rest and ends the reply", () => {
    const { synth, out } = output();
    out.speak("a", "One sentence here. ".repeat(40));
    expect(synth.spoken.length).toBeGreaterThan(2);
    const cancelled = synth.cancelCount;

    synth.spoken[1].onerror?.(); // the browser failed part-way through

    expect(out.getSnapshot().speakingId).toBeNull();
    expect(synth.cancelCount).toBeGreaterThan(cancelled); // the queued chunks are cancelled
  });

  it("a late error from a replaced reply does not disturb the new one", () => {
    const { synth, out } = output();
    out.speak("a", "One sentence here. ".repeat(40));
    const old = synth.spoken[1];
    out.speak("b", "Second reply.");

    old.onerror?.();

    expect(out.getSnapshot().speakingId).toBe("b");
  });

  it("an utterance that errors (for example a blocked start) ends quietly", () => {
    const { synth, out } = output();
    out.speak("a", "Hello.");
    expect(() => synth.spoken[0].onerror?.()).not.toThrow();
    expect(out.getSnapshot().speakingId).toBeNull();
  });

  it("reports unavailable, without throwing, when the browser refuses to speak", () => {
    const { synth, out } = output();
    synth.failSpeak = true;
    expect(out.speak("a", "Hello.")).toBe("unavailable");
    expect(out.getSnapshot().speakingId).toBeNull();
  });

  it("says unavailable for empty text and when there is no voice", () => {
    expect(output().out.speak("a", "   ")).toBe("unavailable");
    const { synth, out } = output([]);
    expect(out.speak("a", "Hello.")).toBe("unavailable");
    expect(synth.spoken).toHaveLength(0);
  });
});

describe("network voices", () => {
  it("are not used without the visitor's agreement", () => {
    const { synth, out } = output([NETWORK]);
    expect(out.getSnapshot().choice.kind).toBe("network");

    expect(out.speak("a", "Hello.")).toBe("needs_consent");
    expect(synth.spoken).toHaveLength(0);
    expect(out.getSnapshot().speakingId).toBeNull();
  });

  it("are used once the visitor has agreed", () => {
    const { synth, out } = output([NETWORK]);
    expect(out.speak("a", "Hello.", { allowNetwork: true })).toBe("started");
    expect(synth.spoken[0].voice).toBe(NETWORK);
  });

  it("do not replace a local voice that exists", () => {
    const { synth, out } = output([NETWORK, LOCAL]);
    expect(out.speak("a", "Hello.")).toBe("started"); // no consent needed
    expect(synth.spoken[0].voice).toBe(LOCAL);
  });
});

describe("voices that load late", () => {
  it("are picked up when voiceschanged fires, and listeners are told", () => {
    const { synth, out } = output([]);
    const listener = vi.fn();
    out.subscribe(listener);
    expect(out.getSnapshot().choice.kind).toBe("none");

    synth.setVoices([LOCAL]);

    expect(out.getSnapshot().choice).toEqual({ kind: "local", voice: LOCAL });
    expect(listener).toHaveBeenCalled();
    expect(out.speak("a", "Hello.")).toBe("started");
  });

  it("stop listening after dispose", () => {
    const { synth, out } = output([]);
    out.dispose();
    synth.setVoices([LOCAL]);
    expect(out.getSnapshot().choice.kind).toBe("none");
  });
});

describe("installSpeech", () => {
  it("installs globals that createSpeechOutput can read", () => {
    const synth = installSpeech([LOCAL]);
    const out = createSpeechOutput(
      window.speechSynthesis,
      SpeechSynthesisUtterance,
    );
    out.speak("a", "Hello.");
    expect(synth.texts).toEqual(["Hello."]);
  });
});
