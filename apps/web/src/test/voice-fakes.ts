/**
 * Fakes for the browser's microphone and recorder (jsdom has neither). Everything is synthetic:
 * the "audio" is a run of zero bytes and no device is ever opened.
 */
import { vi } from "vitest";

export class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  get allStopped() {
    return this.tracks.every((track) => track.stopped);
  }
}

export class FakeRecorder extends EventTarget {
  static supported: string[] = ["audio/webm;codecs=opus", "audio/webm"];
  static defaultMime = "";
  static bytes = 1500;
  static failStart = false;
  /** `stop()` ends the recording but the browser never reports it (no events). */
  static silentStop = false;
  static throwOnConstruct: string | null = null;
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.includes(type);
  }
  static reset() {
    FakeRecorder.supported = ["audio/webm;codecs=opus", "audio/webm"];
    FakeRecorder.defaultMime = "";
    FakeRecorder.bytes = 1500;
    FakeRecorder.failStart = false;
    FakeRecorder.silentStop = false;
    FakeRecorder.throwOnConstruct = null;
    FakeRecorder.instances = [];
  }

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  constructor(
    readonly stream: FakeStream,
    options?: { mimeType?: string },
  ) {
    super();
    if (FakeRecorder.throwOnConstruct) {
      const error = new Error("refused");
      error.name = FakeRecorder.throwOnConstruct;
      throw error;
    }
    this.mimeType = options?.mimeType ?? FakeRecorder.defaultMime;
    FakeRecorder.instances.push(this);
  }
  start() {
    if (FakeRecorder.failStart) throw new Error("start failed");
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (FakeRecorder.silentStop) return;
    if (FakeRecorder.bytes > 0) {
      const data = new Blob([new Uint8Array(FakeRecorder.bytes)], {
        type: this.mimeType,
      });
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
    }
    this.dispatchEvent(new Event("stop"));
  }
  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

type Deferred = {
  resolve: (stream: FakeStream) => void;
  reject: (error: Error) => void;
};

export type FakeMedia = {
  getUserMedia: ReturnType<typeof vi.fn>;
  streams: FakeStream[];
  /** Answers the oldest unanswered permission request with a stream. */
  grant: () => FakeStream;
  /** Answers it with a DOMException-like error of that name. */
  deny: (name: string) => void;
  uninstall: () => void;
};

/**
 * Installs `navigator.mediaDevices.getUserMedia` and `MediaRecorder`. With `auto` (the default)
 * every request is granted at once; otherwise the test answers it with `grant` or `deny`.
 */
export function installMedia({ auto = true } = {}): FakeMedia {
  FakeRecorder.reset();
  const streams: FakeStream[] = [];
  const pending: Deferred[] = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<FakeStream>((resolve, reject) => {
        if (auto) {
          const stream = new FakeStream();
          streams.push(stream);
          resolve(stream);
        } else {
          pending.push({ resolve, reject });
        }
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);

  return {
    getUserMedia,
    streams,
    grant: () => {
      const stream = new FakeStream();
      streams.push(stream);
      pending.shift()?.resolve(stream);
      return stream;
    },
    deny: (name: string) => {
      const error = new Error("denied");
      error.name = name;
      pending.shift()?.reject(error);
    },
    uninstall: () => {
      Reflect.deleteProperty(navigator, "mediaDevices");
      vi.stubGlobal("MediaRecorder", undefined); // a browser that cannot record
      FakeRecorder.reset();
    },
  };
}
