/**
 * The live volume of the microphone, for the voice orb only.
 *
 * It listens to the stream the recorder already holds (no second capture), through a Web Audio
 * `AnalyserNode` that is never connected to an output. Everything happens in the browser: the
 * values are handed to a drawing callback and forgotten, no sample is kept, nothing is stored and
 * nothing is sent. A frame loop runs only between `startLevelMeter` and `stop()`, and `stop()`
 * cancels it, disconnects the nodes and closes the context.
 */

export type LevelMeterDeps = {
  AudioContextCtor?: typeof AudioContext;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

export type LevelMeter = { stop: () => void };

/** How many bars the orb draws. */
export const BAR_COUNT = 24;

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function isLevelMeterSupported(): boolean {
  return audioContextCtor() !== undefined;
}

/** Folds the analyser's frequency bins into `BAR_COUNT` values between 0 and 1. */
export function barLevels(bins: Uint8Array, out: number[] = []): number[] {
  const usable = Math.max(1, Math.floor(bins.length * 0.75)); // the top bins hold little speech
  for (let i = 0; i < BAR_COUNT; i += 1) {
    // Mirror the spectrum so the orb looks balanced: bar i and its opposite share a band.
    const band = i < BAR_COUNT / 2 ? i : BAR_COUNT - 1 - i;
    const start = Math.floor((band / (BAR_COUNT / 2)) * usable);
    const end = Math.max(
      start + 1,
      Math.floor(((band + 1) / (BAR_COUNT / 2)) * usable),
    );
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += bins[j] ?? 0;
    out[i] = Math.min(1, sum / (end - start) / 150);
  }
  out.length = BAR_COUNT;
  return out;
}

/**
 * Starts reading the volume of `stream` and calls `onLevels` once per animation frame with
 * `BAR_COUNT` values. Returns `undefined` when Web Audio is not available (the orb then shows a
 * state animation that does not react to sound) or when setting it up fails.
 */
export function startLevelMeter(
  stream: MediaStream,
  onLevels: (levels: number[]) => void,
  deps: LevelMeterDeps = {},
): LevelMeter | undefined {
  const Ctor = deps.AudioContextCtor ?? audioContextCtor();
  if (!Ctor) return undefined;
  const requestFrame =
    deps.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame =
    deps.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));

  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    context = new Ctor();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser); // the analyser has no output: nothing is played back
    void context.resume?.()?.catch?.(() => undefined);
  } catch {
    try {
      void context?.close?.()?.catch?.(() => undefined);
    } catch {
      // nothing was created
    }
    return undefined;
  }

  const opened = context;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const levels: number[] = [];
  let handle = 0;
  let running = true;
  let last = 0;

  const frame = (time: number) => {
    if (!running) return;
    // About 30 frames a second is plenty for a small shape.
    if (time - last >= 30) {
      last = time;
      analyser.getByteFrequencyData(bins);
      onLevels(barLevels(bins, levels));
    }
    handle = requestFrame(frame);
  };
  handle = requestFrame(frame);

  return {
    stop() {
      if (!running) return;
      running = false;
      cancelFrame(handle);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // already disconnected
      }
      try {
        void opened.close().catch(() => undefined);
      } catch {
        // already closed
      }
    },
  };
}
