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
  prepareTextForSpeech,
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
    expect(out.getSnapshot()).toEqual(UNSUPPORTED);
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

describe("prepareTextForSpeech", () => {
  it.each([
    ["2026-10-01", "October 1, 2026"], // ISO
    ["10/01/2026", "October 1, 2026"], // month first, as in en-US
    ["10-01-2026", "October 1, 2026"],
    ["2026-10-31", "October 31, 2026"], // a two-digit day
    ["12/25/2026", "December 25, 2026"],
    ["2026-01-05", "January 5, 2026"],
    ["2026-12-31", "December 31, 2026"],
    ["1/2/2026", "January 2, 2026"], // one-digit month and day
    ["02/29/2028", "February 29, 2028"], // a real leap day
    ["2028-02-29", "February 29, 2028"],
    ["2000-02-29", "February 29, 2000"], // divisible by 400
  ])("says %s as %s", (written, spoken) => {
    expect(prepareTextForSpeech(written)).toBe(spoken);
    expect(prepareTextForSpeech(`See you on ${written}.`)).toBe(
      `See you on ${spoken}.`,
    );
  });

  it.each([
    "2026-02-29", // 2026 is not a leap year
    "02/29/2026",
    "2100-02-29", // divisible by 100 but not by 400
    "2026-02-30",
    "2026-04-31", // April has 30 days
    "04/31/2026",
    "2026-06-31",
    "2026-09-31",
    "2026-11-31",
    "2026-00-10", // month 00
    "00/10/2026",
    "2026-13-10", // month 13
    "13/10/2026",
    "2026-10-00", // day 00
    "10/00/2026",
    "2026-10-32",
    "10/32/2026",
  ])("leaves the invalid date %s exactly as written", (text) => {
    expect(prepareTextForSpeech(text)).toBe(text);
    expect(prepareTextForSpeech(`On ${text}, please.`)).toBe(
      `On ${text}, please.`,
    );
  });

  it("converts every valid date in a reply and keeps the rest", () => {
    const text =
      "Open on 2026-10-06 and 10/07/2026, but not 2026-02-30 or 13/01/2026.";
    expect(prepareTextForSpeech(text)).toBe(
      "Open on October 6, 2026 and October 7, 2026, but not 2026-02-30 or 13/01/2026.",
    );
  });

  it("keeps the punctuation, brackets and line breaks around a date", () => {
    expect(prepareTextForSpeech("(2026-10-01)")).toBe("(October 1, 2026)");
    expect(prepareTextForSpeech("Date: 2026-10-01, then")).toBe(
      "Date: October 1, 2026, then",
    );
    expect(prepareTextForSpeech("Booked for 2026-10-01.")).toBe(
      "Booked for October 1, 2026.",
    );
    expect(prepareTextForSpeech("Is it 10/01/2026?")).toBe(
      "Is it October 1, 2026?",
    );
    expect(prepareTextForSpeech('"2026-10-01"')).toBe('"October 1, 2026"');
    expect(
      prepareTextForSpeech("Monday\n2026-10-05\nTuesday\n2026-10-06"),
    ).toBe("Monday\nOctober 5, 2026\nTuesday\nOctober 6, 2026");
    expect(prepareTextForSpeech("2026-10-01 - 2026-10-02")).toBe(
      "October 1, 2026 - October 2, 2026",
    );
  });

  it.each([
    "1:00 PM",
    "13:00",
    "09:30 AM to 10:00 AM",
    "$85.00",
    "$1,500.00",
    "85.00 USD",
    "(555) 010-0123",
    "555-123-4567",
    "+1 555 010 0123",
    "3 items",
    "2 benches and 90 minutes",
    "1/2 hour",
    "10/01/26", // a two-digit year is not a date we recognise
    "2026",
    "10/2026",
    "2026-10",
    "version 1.2.3",
    "v2026-10-01",
    "S1 and S10",
    "5b0c8e7a-1d3f-4a6b-9c2e-7f1a2b3c4d5e",
    "12345678-2026-10-01-abcdefgh",
    "v1.eyJ2IjoxfQ.c2lnbmF0dXJl",
    "2026-10-01T13:00:00Z", // a timestamp is not rewritten
    "20261001",
    "1.2026-10-01",
    "2026-10-01.5",
    "2026-10-01-extra",
    "10/01/2026/05",
    "abc2026-10-01",
  ])("leaves %j exactly as written", (text) => {
    expect(prepareTextForSpeech(text)).toBe(text);
  });

  it("leaves a range written without spaces as written: it fails safe, never wrongly", () => {
    // Neither date is a whole token there, so nothing is rewritten (the voice reads digits, as
    // before). Dates separated by spaces are converted (see above).
    for (const text of [
      "10/01/2026-10/05/2026",
      "2026-10-01-2026-10-05",
      "10/01/2026/10/02/2026",
    ]) {
      expect(prepareTextForSpeech(text)).toBe(text);
    }
  });

  it("does nothing to text without dates, and is idempotent", () => {
    const plain =
      "We open at 9:00 AM. A tune-up is $85.00 and takes 90 minutes.";
    expect(prepareTextForSpeech(plain)).toBe(plain);
    const once = prepareTextForSpeech("Tuesday 2026-10-06 or 10/07/2026");
    expect(prepareTextForSpeech(once)).toBe(once);
    expect(prepareTextForSpeech("")).toBe("");
  });

  it("does not depend on the machine's time zone or on Date parsing", () => {
    const original = process.env.TZ;
    try {
      for (const zone of [
        "UTC",
        "America/Los_Angeles",
        "Pacific/Kiritimati",
        "Asia/Tokyo",
      ]) {
        process.env.TZ = zone;
        expect(prepareTextForSpeech("2026-10-01 and 03/01/2026")).toBe(
          "October 1, 2026 and March 1, 2026",
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("speaking dates", () => {
  it("hands the voice the natural date, in order, and nothing else changes", () => {
    const { synth, out } = output();
    const text =
      "Your review is for 2026-10-01 at 1:00 PM, $85.00. Alternatively 10/02/2026.";

    expect(out.speak("a", text)).toBe("started");

    expect(synth.texts.join(" ")).toBe(
      "Your review is for October 1, 2026 at 1:00 PM, $85.00. Alternatively October 2, 2026.",
    );
  });

  it("converts the date before the reply is split into chunks", () => {
    const { synth, out } = output();
    const filler =
      "A sentence of reasonable length that goes on and on a little bit. ";
    const text = `${filler.repeat(4)}Open on 2026-10-01 and also on 10/02/2026. ${filler.repeat(4)}`;

    out.speak("a", text);

    expect(synth.spoken.length).toBeGreaterThan(1);
    expect(synth.texts.every((chunk) => chunk.length <= MAX_CHUNK_CHARS)).toBe(
      true,
    );
    const spoken = synth.texts.join(" ");
    expect(spoken).toContain("October 1, 2026");
    expect(spoken).toContain("October 2, 2026");
    expect(spoken).not.toMatch(/2026-10|10\/0/); // no digit-by-digit form is left
    expect(spoken).toBe(prepareTextForSpeech(text).replace(/\s+/g, " ").trim());
  });
});
