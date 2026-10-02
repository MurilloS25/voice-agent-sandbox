import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StageKind } from "@/lib/voice/stage";
import {
  FakeAudioContext,
  installAudio,
  type FrameQueue,
} from "@/test/audio-fakes";

import { Orb } from "./Orb";

const STAGES: StageKind[] = [
  "start",
  "ready",
  "preparing",
  "listening",
  "transcribing",
  "review",
  "thinking",
  "speaking",
  "error",
];
const stream = {} as MediaStream;
let frames: FrameQueue | undefined;

afterEach(() => {
  frames?.uninstall();
  frames = undefined;
  vi.unstubAllGlobals();
});

const svg = (container: HTMLElement) =>
  container.querySelector("svg[data-orb-stage]") as SVGSVGElement;
const bars = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-orb-bars] rect"));

describe("the orb", () => {
  it("is one SVG, hidden from assistive technology, whatever the state", () => {
    for (const stage of STAGES) {
      const { container, unmount } = render(<Orb stage={stage} />);
      const root = svg(container);
      expect(root).toHaveAttribute("aria-hidden", "true");
      expect(root).toHaveAttribute("data-orb-stage", stage);
      expect(container.querySelectorAll("canvas")).toHaveLength(0);
      unmount();
    }
  });

  it("draws a different glyph for every state, so motion is never the only signal", () => {
    const glyphs = STAGES.map((stage) => {
      const { container, unmount } = render(<Orb stage={stage} />);
      const inner = container.querySelector("svg svg") as SVGSVGElement;
      const markup = inner.innerHTML;
      unmount();
      return markup;
    });
    // preparing and thinking both use dots; every other pair differs.
    expect(new Set(glyphs).size).toBeGreaterThanOrEqual(STAGES.length - 1);
  });

  it.each([
    ["ready", ".orb-breathe"],
    ["preparing", ".orb-pulse"],
    ["transcribing", ".orb-spin"],
    ["thinking", ".orb-steps"],
    ["speaking", ".orb-ripple"],
  ] as const)("%s has its own animation layer (%s)", (stage, selector) => {
    const { container } = render(<Orb stage={stage} />);
    expect(container.querySelector(selector)).not.toBeNull();
  });

  it("speaking and listening are different shapes (rings against bars)", () => {
    const speaking = render(<Orb stage="speaking" />);
    expect(speaking.container.querySelectorAll(".orb-ripple")).toHaveLength(3);
    expect(bars(speaking.container)).toHaveLength(0);
    speaking.unmount();
    const listening = render(<Orb stage="listening" />);
    expect(bars(listening.container)).toHaveLength(24);
    expect(listening.container.querySelector(".orb-ripple")).toBeNull();
  });

  it("error is still: no animated layer at all", () => {
    const { container } = render(<Orb stage="error" />);
    expect(
      container.querySelector(
        ".orb-breathe, .orb-pulse, .orb-spin, .orb-steps, .orb-ripple, .orb-bar-idle",
      ),
    ).toBeNull();
  });

  it("start and review do not animate either", () => {
    for (const stage of ["start", "review"] as const) {
      const { container, unmount } = render(<Orb stage={stage} />);
      expect(container.querySelector("[class*='orb-']")).toBeNull();
      unmount();
    }
  });
});

describe("listening: the bars follow the real volume", () => {
  it("creates one analyser on the stream it is given and moves the bars with the signal", () => {
    frames = installAudio();
    const { container } = render(<Orb stage="listening" stream={stream} />);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(svg(container)).toHaveAttribute("data-orb-reactive", "true");
    const [context] = FakeAudioContext.instances;
    const height = () =>
      bars(container).map((bar) => Number(bar.getAttribute("height")));

    context.level = 0;
    act(() => frames?.tick());
    const quiet = height();
    context.level = 220;
    act(() => frames?.tick());
    const loud = height();

    expect(Math.max(...quiet)).toBe(6);
    expect(Math.max(...loud)).toBeGreaterThan(15);
    // Reactive bars are driven by the signal, not by the idle animation.
    expect(container.querySelector(".orb-bar-idle")).toBeNull();
  });

  it("uses an animation that does not react to sound when Web Audio is not available", () => {
    vi.stubGlobal("AudioContext", undefined);
    const { container } = render(<Orb stage="listening" stream={stream} />);
    expect(svg(container)).not.toHaveAttribute("data-orb-reactive");
    expect(container.querySelectorAll(".orb-bar-idle")).toHaveLength(24);
  });

  it("falls back to the same animation when the analyser cannot be created", () => {
    frames = installAudio();
    FakeAudioContext.failConstruct = true;
    const { container } = render(<Orb stage="listening" stream={stream} />);
    expect(svg(container)).not.toHaveAttribute("data-orb-reactive");
    expect(container.querySelectorAll(".orb-bar-idle")).toHaveLength(24);
  });

  it("does not listen to anything without a stream or in another state", () => {
    frames = installAudio();
    render(<Orb stage="listening" stream={null} />);
    render(<Orb stage="ready" stream={stream} />);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(frames.pending()).toBe(0);
  });

  it("cleans up when the state changes: frame cancelled, nodes disconnected, context closed", () => {
    frames = installAudio();
    const { rerender, container } = render(
      <Orb stage="listening" stream={stream} />,
    );
    const [context] = FakeAudioContext.instances;
    act(() => frames?.tick());
    expect(frames.pending()).toBe(1);

    rerender(<Orb stage="transcribing" stream={null} />);

    expect(frames.pending()).toBe(0);
    expect(frames.cancelled.length).toBeGreaterThan(0);
    expect(context.sources[0].disconnected).toBe(true);
    expect(context.analysers[0].disconnected).toBe(true);
    expect(context.closed).toBe(true);
    expect(container.querySelector(".orb-spin")).not.toBeNull();
    act(() => frames?.tick());
    expect(frames.pending()).toBe(0);
  });

  it("cleans up on unmount", () => {
    frames = installAudio();
    const { unmount } = render(<Orb stage="listening" stream={stream} />);
    const [context] = FakeAudioContext.instances;
    unmount();
    expect(frames.pending()).toBe(0);
    expect(context.closed).toBe(true);
    expect(context.sources[0].disconnected).toBe(true);
  });

  it("makes a new analyser for a new recording and never reuses a closed one", () => {
    frames = installAudio();
    const { rerender } = render(<Orb stage="listening" stream={stream} />);
    rerender(<Orb stage="ready" />);
    rerender(<Orb stage="listening" stream={{} as MediaStream} />);
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[0].closed).toBe(true);
    expect(FakeAudioContext.instances[1].closed).toBe(false);
  });

  it("restores the bars to rest after listening", () => {
    frames = installAudio();
    const { rerender, container } = render(
      <Orb stage="listening" stream={stream} />,
    );
    FakeAudioContext.instances[0].level = 250;
    act(() => frames?.tick());
    const nodes = bars(container);
    rerender(<Orb stage="listening" stream={null} />); // the stream went away
    expect(nodes.every((bar) => bar.getAttribute("height") === "6")).toBe(true);
  });
});

describe("reduced motion", () => {
  function reduceMotion() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
  }

  it("runs no analyser and no frame loop, and shows still bars", () => {
    frames = installAudio();
    reduceMotion();
    const { container } = render(<Orb stage="listening" stream={stream} />);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(frames.pending()).toBe(0);
    expect(container.querySelector(".orb-bar-idle")).toBeNull();
    expect(bars(container)).toHaveLength(24); // the bars are still drawn
  });

  it("leaves the CSS animations to the media query, which turns them off", () => {
    const css = readGlobalCss();
    const animated = css.match(/\.orb-[a-z-]+ \{\s*animation:/g) ?? [];
    expect(animated.length).toBeGreaterThanOrEqual(5);
    const outside = css.split(
      "@media (prefers-reduced-motion: no-preference)",
    )[0];
    expect(outside).not.toMatch(/animation:\s*orb-/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

function readGlobalCss(): string {
  return readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
}
