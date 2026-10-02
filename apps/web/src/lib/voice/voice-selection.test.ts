import { describe, expect, it } from "vitest";

import { fakeVoice } from "@/test/speech-fakes";

import {
  chooseVoice,
  clampRate,
  DEFAULT_SETTINGS,
  MAX_RATE,
  MIN_RATE,
  parseSettings,
  rankVoices,
  voiceOptions,
} from "./voice-selection";

const names = (voices: SpeechSynthesisVoice[]) => voices.map((v) => v.name);

describe("rankVoices", () => {
  it("keeps English only and puts local voices before network ones", () => {
    const ranked = rankVoices([
      fakeVoice({ name: "Net", localService: false }),
      fakeVoice({ name: "Español", lang: "es-ES" }),
      fakeVoice({ name: "Loc", localService: true }),
    ]);
    expect(names(ranked)).toEqual(["Loc", "Net"]);
  });

  it("prefers Natural, then Enhanced or Premium, then Online, inside a group", () => {
    const ranked = rankVoices([
      fakeVoice({ name: "Plain voice" }),
      fakeVoice({ name: "Some Online voice", localService: true }),
      fakeVoice({ name: "Some Premium voice" }),
      fakeVoice({ name: "Some Natural voice" }),
      fakeVoice({ name: "Some Enhanced voice" }),
    ]);
    expect(names(ranked)).toEqual([
      "Some Natural voice",
      "Some Premium voice",
      "Some Enhanced voice",
      "Some Online voice",
      "Plain voice",
    ]);
  });

  it("is not tied to any vendor's names and ignores case", () => {
    const ranked = rankVoices([
      fakeVoice({ name: "alpha" }),
      fakeVoice({ name: "beta NATURAL" }),
    ]);
    expect(names(ranked)).toEqual(["beta NATURAL", "alpha"]);
  });

  it("prefers en-US over other English at equal quality, then the default voice, then order", () => {
    const gb = fakeVoice({ name: "GB", lang: "en-GB" });
    const us = fakeVoice({ name: "US", lang: "en-US" });
    expect(names(rankVoices([gb, us]))).toEqual(["US", "GB"]);
    const a = fakeVoice({ name: "A" });
    const b = fakeVoice({ name: "B", default: true });
    const c = fakeVoice({ name: "C" });
    expect(names(rankVoices([a, b, c]))).toEqual(["B", "A", "C"]);
  });

  it("does not change its input", () => {
    const input = [fakeVoice({ name: "x" }), fakeVoice({ name: "y Natural" })];
    const copy = [...input];
    rankVoices(input);
    expect(input).toEqual(copy);
  });
});

describe("chooseVoice with a preference", () => {
  const plain = fakeVoice({ name: "Plain" });
  const nice = fakeVoice({ name: "Nice Natural" });

  it("uses the automatic best voice without a preference", () => {
    expect(chooseVoice([plain, nice])).toEqual({ kind: "local", voice: nice });
  });

  it("uses the visitor's voice when it exists", () => {
    expect(chooseVoice([plain, nice], "Plain")).toEqual({
      kind: "local",
      voice: plain,
    });
  });

  it("falls back to automatic when the saved voice is gone or is not English", () => {
    expect(chooseVoice([plain, nice], "Vanished")).toEqual({
      kind: "local",
      voice: nice,
    });
    const es = fakeVoice({ name: "Es", lang: "es-ES" });
    expect(chooseVoice([plain, es], "Es")).toEqual({
      kind: "local",
      voice: plain,
    });
  });

  it("marks a chosen network voice as network", () => {
    const online = fakeVoice({ name: "Online Natural", localService: false });
    expect(chooseVoice([plain, online], "Online Natural")).toEqual({
      kind: "network",
      voice: online,
    });
  });

  it("does not auto-select a network voice over a local one, even a better-named one", () => {
    const online = fakeVoice({ name: "Online Natural", localService: false });
    expect(chooseVoice([online, plain]).kind).toBe("local");
  });

  it("never throws, even for a broken voice list", () => {
    expect(
      chooseVoice([{ lang: null } as unknown as SpeechSynthesisVoice]),
    ).toEqual({ kind: "none" });
  });
});

describe("voiceOptions", () => {
  it("describes each voice for the picker", () => {
    expect(
      voiceOptions([
        fakeVoice({ name: "Online Natural", localService: false }),
        fakeVoice({ name: "Plain" }),
      ]),
    ).toEqual([
      { name: "Plain", lang: "en-US", local: true, enhanced: false },
      { name: "Online Natural", lang: "en-US", local: false, enhanced: true },
    ]);
  });
});

describe("settings", () => {
  it("clamps the rate to a prudent range in 0.05 steps", () => {
    expect(clampRate(5)).toBe(MAX_RATE);
    expect(clampRate(0)).toBe(MIN_RATE);
    expect(clampRate(0.951)).toBe(0.95);
  });

  it("reads a valid stored value", () => {
    expect(parseSettings('{"voiceName":"Nice","rate":1.1}')).toEqual({
      ...DEFAULT_SETTINGS,
      voiceName: "Nice",
      rate: 1.1,
    });
  });

  it.each([
    ["nothing stored", null],
    ["not JSON", "{oops"],
    ["a number", "7"],
    ["an array", "[1]"],
    ["null", "null"],
  ])("uses the defaults for %s", (_label, raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("repairs each invalid field on its own", () => {
    expect(parseSettings('{"voiceName":5,"rate":1.1}')).toEqual({
      ...DEFAULT_SETTINGS,
      voiceName: null,
      rate: 1.1,
    });
    expect(parseSettings('{"voiceName":"Ok","rate":9}')).toEqual({
      ...DEFAULT_SETTINGS,
      voiceName: "Ok",
      rate: DEFAULT_SETTINGS.rate,
    });
    expect(parseSettings('{"voiceName":"Ok","rate":"fast"}').rate).toBe(
      DEFAULT_SETTINGS.rate,
    );
    expect(
      parseSettings(`{"voiceName":"${"x".repeat(500)}","rate":1}`).voiceName,
    ).toBeNull();
  });

  it("ignores extra fields, so a conversation could never ride along", () => {
    expect(
      parseSettings('{"voiceName":"Ok","rate":1,"messages":["hi"]}'),
    ).toEqual({ ...DEFAULT_SETTINGS, voiceName: "Ok", rate: 1 });
  });
});

describe("network agreement and review preference", () => {
  it("keeps an agreement only for the voice that was picked and agreed to", () => {
    expect(
      parseSettings('{"voiceName":"Net","consentVoice":"Net","rate":1}')
        .consentVoice,
    ).toBe("Net");
    // An agreement for another voice, or without a pick, is dropped.
    expect(
      parseSettings('{"voiceName":"Net","consentVoice":"Other"}').consentVoice,
    ).toBeNull();
    expect(parseSettings('{"consentVoice":"Net"}').consentVoice).toBeNull();
    expect(
      parseSettings('{"voiceName":"Net","consentVoice":5}').consentVoice,
    ).toBeNull();
  });

  it("reads the review preference only when it is exactly true, and defaults to off", () => {
    expect(DEFAULT_SETTINGS.reviewBeforeSending).toBe(false);
    expect(
      parseSettings('{"reviewBeforeSending":true}').reviewBeforeSending,
    ).toBe(true);
    for (const bad of ['"yes"', "1", "null", "[]", "{}"]) {
      expect(
        parseSettings(`{"reviewBeforeSending":${bad}}`).reviewBeforeSending,
      ).toBe(false);
    }
  });
});
