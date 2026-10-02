import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeAudioContext,
  installAudio,
  type FrameQueue,
} from "@/test/audio-fakes";

import {
  BAR_COUNT,
  barLevels,
  isLevelMeterSupported,
  startLevelMeter,
} from "./level-meter";

let frames: FrameQueue;
const stream = {} as MediaStream;

afterEach(() => {
  frames?.uninstall();
  vi.unstubAllGlobals();
});

describe("barLevels", () => {
  it("folds the bins into BAR_COUNT values between 0 and 1", () => {
    const levels = barLevels(new Uint8Array(64).fill(255));
    expect(levels).toHaveLength(BAR_COUNT);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
    expect(Math.min(...levels)).toBeGreaterThan(0.9);
  });

  it("is silent for silence and louder for a louder signal", () => {
    const quiet = barLevels(new Uint8Array(64).fill(0));
    const mid = barLevels(new Uint8Array(64).fill(60));
    const loud = barLevels(new Uint8Array(64).fill(180));
    expect(quiet.every((v) => v === 0)).toBe(true);
    expect(mid[3]).toBeGreaterThan(0);
    expect(loud[3]).toBeGreaterThan(mid[3]);
  });

  it("mirrors the spectrum so the shape is balanced", () => {
    const bins = new Uint8Array(64);
    bins.fill(200, 0, 8);
    const levels = barLevels(bins);
    expect(levels[0]).toBeCloseTo(levels[BAR_COUNT - 1]);
  });
});

describe("startLevelMeter", () => {
  it("is unavailable without Web Audio, and says so by returning nothing", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(isLevelMeterSupported()).toBe(false);
    expect(startLevelMeter(stream, vi.fn())).toBeUndefined();
  });

  it("creates one context, listens to the given stream and never connects to an output", () => {
    frames = installAudio();
    expect(isLevelMeterSupported()).toBe(true);
    startLevelMeter(stream, vi.fn());

    expect(FakeAudioContext.instances).toHaveLength(1);
    const [context] = FakeAudioContext.instances;
    expect(context.sources).toHaveLength(1);
    expect(context.analysers).toHaveLength(1);
    expect(context.sources[0].connectedTo).toEqual([context.analysers[0]]);
    expect(context.sources[0].connectedTo).not.toContain(context.destination);
  });

  it("reports the real amplitude, frame by frame, and keeps nothing", () => {
    frames = installAudio();
    const onLevels = vi.fn();
    startLevelMeter(stream, onLevels);
    const [context] = FakeAudioContext.instances;

    context.level = 0;
    frames.tick();
    const quiet = [...onLevels.mock.calls[0][0]];
    context.level = 200;
    frames.tick();
    const loud = [...onLevels.mock.calls[1][0]];

    expect(quiet.every((v: number) => v === 0)).toBe(true);
    expect(Math.max(...loud)).toBeGreaterThan(0.5);
    // The callback receives numbers only: no samples, no stream, nothing to send.
    expect(loud.every((v: number) => typeof v === "number")).toBe(true);
  });

  it("reads about thirty times a second, not on every frame", () => {
    frames = installAudio();
    const onLevels = vi.fn();
    startLevelMeter(stream, onLevels);
    frames.tick(40);
    frames.tick(5);
    frames.tick(5);
    frames.tick(40);
    expect(onLevels).toHaveBeenCalledTimes(2);
  });

  it("keeps exactly one frame pending while it runs", () => {
    frames = installAudio();
    startLevelMeter(stream, vi.fn());
    expect(frames.pending()).toBe(1);
    frames.tick();
    expect(frames.pending()).toBe(1);
  });

  it("stop cancels the frame, disconnects the nodes and closes the context", () => {
    frames = installAudio();
    const meter = startLevelMeter(stream, vi.fn());
    const [context] = FakeAudioContext.instances;

    meter?.stop();

    expect(frames.pending()).toBe(0);
    expect(frames.cancelled).toHaveLength(1);
    expect(context.sources[0].disconnected).toBe(true);
    expect(context.analysers[0].disconnected).toBe(true);
    expect(context.closed).toBe(true);
  });

  it("stop is idempotent and no frame runs afterwards", () => {
    frames = installAudio();
    const onLevels = vi.fn();
    const meter = startLevelMeter(stream, onLevels);
    meter?.stop();
    meter?.stop();
    frames.tick();
    expect(onLevels).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
    expect(FakeAudioContext.instances[0].closed).toBe(true);
  });

  it("returns nothing, and leaves nothing behind, when the context cannot be set up", () => {
    frames = installAudio();
    FakeAudioContext.failConstruct = true;
    expect(startLevelMeter(stream, vi.fn())).toBeUndefined();
    expect(frames.pending()).toBe(0);
  });

  it("does not touch the stream's tracks: the recorder owns them", () => {
    frames = installAudio();
    const track = { stop: vi.fn() };
    const owned = { getTracks: () => [track] } as unknown as MediaStream;
    const meter = startLevelMeter(owned, vi.fn());
    meter?.stop();
    expect(track.stop).not.toHaveBeenCalled();
  });
});
