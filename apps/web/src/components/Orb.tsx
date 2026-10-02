import type { ReactNode } from "react";

import type { StageKind } from "@/lib/voice/stage";

import { Wheel } from "./Wheel";

const glyphs: Record<StageKind, ReactNode> = {
  // Play
  start: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  // Microphone
  ready: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4" />
    </>
  ),
  // Microphone with a pending ellipsis
  preparing: (
    <>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  // Stop square
  listening: (
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
  ),
  // Lines of text
  transcribing: <path d="M5 7h14M5 12h14M5 17h9" />,
  // Check mark
  review: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  // Three dots
  thinking: (
    <>
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </>
  ),
  // Speaker with sound waves
  speaking: (
    <>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  // Exclamation in a triangle
  error: (
    <>
      <path d="M12 4 3 19.5h18z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
};

/**
 * The centre of the voice stage: a soft turquoise disc with the workshop wheel behind a glyph
 * that is different for every state, so the state is never carried by colour or motion alone.
 * Purely visual: the state is also written as text next to it.
 */
export function Orb({
  stage,
  small = false,
  children,
}: {
  stage: StageKind;
  /** A smaller disc, when something else (the review text) needs the room. */
  small?: boolean;
  /** The interactive element (a button) or nothing. It sits over the disc and fills it. */
  children?: ReactNode;
}) {
  const active = stage === "listening";
  const working =
    stage === "transcribing" || stage === "thinking" || stage === "preparing";
  return (
    <span
      className={`relative mx-auto block aspect-square max-w-full ${small ? "w-[clamp(5rem,14dvh,7.5rem)]" : "w-[clamp(8rem,30dvh,15rem)]"}`}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="orb-breathe absolute inset-0 rounded-full bg-celeste"
        />
      ) : null}
      {working ? (
        <span
          aria-hidden="true"
          className="orb-orbit absolute -inset-2 rounded-full border-2 border-dashed border-bottle/40"
        />
      ) : null}
      <span className="absolute inset-0 block overflow-hidden rounded-full bg-[radial-gradient(circle_at_30%_25%,#c9ece9,var(--color-celeste)_55%,#5fb8b1)] shadow-[0_18px_40px_-16px_rgb(15_59_54/0.55)] ring-1 ring-bottle/10">
        <Wheel className="absolute -inset-[8%] w-[116%] text-bottle opacity-25" />
        <span className="absolute inset-[30%] flex items-center justify-center rounded-full bg-cream/80 text-bottle shadow-sm">
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            className="h-3/5 w-3/5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {glyphs[stage]}
          </svg>
        </span>
      </span>
      {children}
    </span>
  );
}
