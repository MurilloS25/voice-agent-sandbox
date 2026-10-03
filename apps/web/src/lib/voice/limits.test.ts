import { describe, expect, it } from "vitest";

import {
  ALLOWED_AUDIO_TYPES,
  audioTypeOf,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
} from "./limits";

describe("voice limits", () => {
  it("match the plan", () => {
    expect(MAX_RECORDING_MS).toBe(15_000);
    expect(MIN_RECORDING_MS).toBe(300);
    expect(MAX_AUDIO_BYTES).toBe(256 * 1024);
    expect([...ALLOWED_AUDIO_TYPES]).toEqual([
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/wav",
    ]);
  });

  it.each([
    ["audio/webm", "audio/webm"],
    ["audio/webm;codecs=opus", "audio/webm"],
    ["Audio/WebM ; Codecs=opus", "audio/webm"],
    ["audio/ogg;codecs=opus", "audio/ogg"],
    ["audio/mp4", "audio/mp4"],
    ["audio/wav", "audio/wav"],
  ])("reads %s as %s", (header, expected) => {
    expect(audioTypeOf(header)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "audio/mpeg",
    "audio/x-wav",
    "video/webm",
    "text/plain",
  ])("rejects %s", (header) => {
    expect(audioTypeOf(header)).toBeUndefined();
  });
});
