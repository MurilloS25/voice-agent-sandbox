/**
 * Fakes for Web Audio and the animation frame (jsdom has neither). Nothing is ever heard: the
 * analyser fills its bins with a level the test chooses, and frames run only when the test says so.
 */
import { vi } from "vitest";

export class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 64;
  disconnected = false;
  reads = 0;
  constructor(private readonly context: FakeAudioContext) {}
  getByteFrequencyData(bins: Uint8Array) {
    this.reads += 1;
    bins.fill(this.context.level);
  }
  disconnect() {
    this.disconnected = true;
  }
}

export class FakeSource {
  connectedTo: unknown[] = [];
  disconnected = false;
  connect(node: unknown) {
    this.connectedTo.push(node);
  }
  disconnect() {
    this.disconnected = true;
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** Make the next construction throw, like a browser that refuses an audio context. */
  static failConstruct = false;
  static reset() {
    FakeAudioContext.instances = [];
    FakeAudioContext.failConstruct = false;
  }

  /** The value every frequency bin reports, 0 to 255. */
  level = 0;
  closed = false;
  resumed = false;
  sources: FakeSource[] = [];
  analysers: FakeAnalyser[] = [];
  /** A destination exists, and must never be connected to: nothing is played back. */
  readonly destination = { kind: "destination" };

  constructor() {
    if (FakeAudioContext.failConstruct) throw new Error("no audio");
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(stream: unknown) {
    void stream;
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createAnalyser() {
    const analyser = new FakeAnalyser(this);
    this.analysers.push(analyser);
    return analyser;
  }
  resume() {
    this.resumed = true;
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

export type FrameQueue = {
  /** Frames that were asked for and neither run nor cancelled. */
  pending: () => number;
  /** Runs every pending frame once, `ms` after the previous one. */
  tick: (ms?: number) => void;
  cancelled: number[];
  uninstall: () => void;
};

/** Installs the fake `AudioContext` and a manual `requestAnimationFrame`. */
export function installAudio(): FrameQueue {
  FakeAudioContext.reset();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  let next = 1;
  let clock = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = next++;
    frames.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    cancelled.push(handle);
    frames.delete(handle);
  });
  return {
    pending: () => frames.size,
    tick: (ms = 40) => {
      clock += ms;
      const due = [...frames.entries()];
      frames.clear();
      due.forEach(([, callback]) => callback(clock));
    },
    cancelled,
    uninstall: () => {
      vi.stubGlobal("AudioContext", undefined);
      FakeAudioContext.reset();
    },
  };
}
