"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { BAR_COUNT, startLevelMeter } from "@/lib/voice/level-meter";
import type { StageKind } from "@/lib/voice/stage";

const SPOKES = 24;
const spokeLines = Array.from({ length: SPOKES }, (_, index) => {
  const angle = (index / SPOKES) * Math.PI * 2;
  return {
    x1: (100 + Math.cos(angle) * 12).toFixed(1),
    y1: (100 + Math.sin(angle) * 12).toFixed(1),
    x2: (100 + Math.cos(angle) * 66).toFixed(1),
    y2: (100 + Math.sin(angle) * 66).toFixed(1),
  };
});

const glyphs: Record<StageKind, ReactNode> = {
  start: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />, // play
  ready: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4" />
    </>
  ), // microphone
  preparing: (
    <>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  listening: (
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
  ), // stop
  transcribing: <path d="M5 7h14M5 12h14M5 17h9" />, // lines of text
  review: <path d="m5 12.5 4.5 4.5L19 7.5" />, // check
  thinking: (
    <>
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  speaking: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ), // speaker
  error: (
    <>
      <path d="M12 4 3 19.5h18z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
};

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia?.(REDUCED);
  query?.addEventListener?.("change", notify);
  return () => query?.removeEventListener?.("change", notify);
};
const prefersReducedMotion = () =>
  window.matchMedia?.(REDUCED)?.matches ?? false;

const BAR_REST = 6;
const BAR_MAX = 26;

/**
 * The centre of the voice stage, drawn as one SVG so every state can move in its own way:
 *
 * - ready: a very slow breath; preparing: a slow pulse;
 * - listening: bars around the disc that follow the real volume of the microphone (Web Audio on
 *   the stream the recorder already holds, analysed in the browser and never stored or sent);
 *   without Web Audio the bars move on their own;
 * - transcribing: an arc turning around the disc; thinking: three dots stepping round it;
 * - speaking: rings spreading outwards (a fixed pattern: speech output is never analysed);
 * - error: still.
 *
 * Under `prefers-reduced-motion: reduce` nothing moves and no analyser runs. The state is also
 * always a different glyph and is written next to the orb, so motion is never the only signal.
 */
export function Orb({
  stage,
  small = false,
  stream = null,
  children,
}: {
  stage: StageKind;
  /** A smaller disc, when something else (the review text) needs the room. */
  small?: boolean;
  /** The microphone stream being recorded, while listening. */
  stream?: MediaStream | null;
  /** The interactive element (a button) over the disc, or nothing. */
  children?: ReactNode;
}) {
  const id = useId();
  const reduced = useSyncExternalStore(
    subscribeMotion,
    prefersReducedMotion,
    () => false,
  );
  const bars = useRef<Array<SVGRectElement | null>>([]);
  const [reactive, setReactive] = useState(false);

  const listening = stage === "listening";
  useEffect(() => {
    if (!listening || !stream || reduced) return;
    const meter = startLevelMeter(stream, (levels) => {
      levels.forEach((level, index) => {
        const bar = bars.current[index];
        if (!bar) return;
        const height = BAR_REST + level * (BAR_MAX - BAR_REST);
        bar.setAttribute("height", height.toFixed(1));
        bar.setAttribute("y", (22 - height).toFixed(1));
      });
    });
    setReactive(meter !== undefined);
    const nodes = bars.current;
    return () => {
      meter?.stop();
      setReactive(false);
      nodes.forEach((node) => {
        node?.setAttribute("height", String(BAR_REST));
        node?.setAttribute("y", String(22 - BAR_REST));
      });
    };
  }, [listening, stream, reduced]);

  const gradient = `${id}-disc`;
  const size = small
    ? "w-[clamp(56px,10dvh,7rem)]"
    : "w-[clamp(96px,22dvh,15rem)]";
  return (
    <span className={`relative mx-auto block aspect-square max-w-full ${size}`}>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 200 200"
        data-orb-stage={stage}
        data-orb-reactive={reactive || undefined}
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        <defs>
          <radialGradient id={gradient} cx="30%" cy="25%" r="85%">
            <stop offset="0%" stopColor="#c9ece9" />
            <stop offset="55%" stopColor="var(--color-celeste)" />
            <stop offset="100%" stopColor="#5fb8b1" />
          </radialGradient>
        </defs>

        {/* Per-state motion, behind and around the disc. */}
        {stage === "ready" ? (
          <circle
            className="orb-breathe"
            cx="100"
            cy="100"
            r="80"
            fill="none"
            stroke="var(--color-celeste)"
            strokeWidth="5"
            opacity="0.55"
          />
        ) : null}
        {stage === "preparing" ? (
          <circle
            className="orb-pulse"
            cx="100"
            cy="100"
            r="74"
            fill="none"
            stroke="var(--color-bottle)"
            strokeWidth="3"
            opacity="0.5"
          />
        ) : null}
        {stage === "listening" ? (
          <g data-orb-bars>
            {Array.from({ length: BAR_COUNT }, (_, index) => (
              <g
                key={index}
                transform={`rotate(${(index / BAR_COUNT) * 360} 100 100)`}
              >
                <rect
                  ref={(node) => {
                    bars.current[index] = node;
                  }}
                  className={reactive || reduced ? undefined : "orb-bar-idle"}
                  style={
                    reactive || reduced
                      ? undefined
                      : { animationDelay: `${(index % 6) * 0.13}s` }
                  }
                  x="98"
                  y={22 - BAR_REST}
                  width="4"
                  height={BAR_REST}
                  rx="2"
                  fill="var(--color-bottle)"
                />
              </g>
            ))}
          </g>
        ) : null}
        {stage === "transcribing" ? (
          <circle
            className="orb-spin"
            cx="100"
            cy="100"
            r="82"
            fill="none"
            stroke="var(--color-bottle)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="90 425"
          />
        ) : null}
        {stage === "thinking" ? (
          <g className="orb-steps">
            {[0, 120, 240].map((angle) => (
              <circle
                key={angle}
                cx="100"
                cy="14"
                r="6"
                fill="var(--color-bottle)"
                transform={`rotate(${angle} 100 100)`}
              />
            ))}
          </g>
        ) : null}
        {stage === "speaking"
          ? [0, 1, 2].map((index) => (
              <circle
                key={index}
                className="orb-ripple"
                style={{ animationDelay: `${index * 0.7}s` }}
                cx="100"
                cy="100"
                r="72"
                fill="none"
                stroke="var(--color-bottle)"
                strokeWidth="3"
              />
            ))
          : null}
        {stage === "error" ? (
          <circle
            cx="100"
            cy="100"
            r="80"
            fill="none"
            stroke="var(--color-rust)"
            strokeWidth="5"
          />
        ) : null}

        {/* The disc, the workshop wheel and the glyph of the state. */}
        <circle cx="100" cy="100" r="70" fill={`url(#${gradient})`} />
        <circle
          cx="100"
          cy="100"
          r="70"
          fill="none"
          stroke="var(--color-bottle)"
          strokeOpacity="0.14"
          strokeWidth="1.5"
        />
        <g stroke="var(--color-bottle)" strokeOpacity="0.25" strokeWidth="1">
          {spokeLines.map((line) => (
            <line key={`${line.x2}-${line.y2}`} {...line} />
          ))}
        </g>
        <circle
          cx="100"
          cy="100"
          r="30"
          fill="var(--color-cream)"
          fillOpacity="0.85"
        />
        <svg
          x="72"
          y="72"
          width="56"
          height="56"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-bottle)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          color="var(--color-bottle)"
        >
          {glyphs[stage]}
        </svg>
      </svg>
      {children}
    </span>
  );
}
