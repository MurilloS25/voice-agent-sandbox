import { useSyncExternalStore } from "react";

import {
  browserStorage,
  createSpeechOutput,
  UNSUPPORTED,
  type SpeechOutput,
  type SpeechSnapshot,
} from "./speech-output";

let shared: SpeechOutput | undefined;

/**
 * One controller per page: it listens to the browser's `voiceschanged` event once, and nothing is
 * created on the server. Components stop speaking when they unmount; the controller itself lives
 * as long as the page.
 */
export function getSpeechOutput(): SpeechOutput {
  shared ??= createSpeechOutput(
    typeof window !== "undefined" ? window.speechSynthesis : undefined,
    typeof SpeechSynthesisUtterance !== "undefined"
      ? SpeechSynthesisUtterance
      : undefined,
    browserStorage(),
  );
  return shared;
}

/** Test seam: forgets the controller so the next call reads the browser again. */
export function resetSpeechOutput(): void {
  shared?.dispose();
  shared = undefined;
}

const serverSnapshot = (): SpeechSnapshot => UNSUPPORTED;

export function useSpeechOutput(): {
  output: SpeechOutput;
  snapshot: SpeechSnapshot;
} {
  const output = getSpeechOutput();
  const snapshot = useSyncExternalStore(
    output.subscribe,
    output.getSnapshot,
    serverSnapshot,
  );
  return { output, snapshot };
}
