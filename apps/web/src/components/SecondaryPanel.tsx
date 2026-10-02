"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

type Props = {
  id: string;
  title: string;
  /** Closes the panel. The caller returns focus to the control that opened it. */
  onClose: () => void;
  children: ReactNode;
  /** Scroll the body to its end when the panel opens and whenever this value changes. */
  endKey?: string | number;
};

/**
 * A secondary surface (transcript, activity, voice settings). It is not a modal: nothing behind it
 * is made inert, no focus is trapped, and Escape or the Close button leaves it. Opening it moves
 * focus to its heading so a keyboard or screen reader user lands in it. It keeps its own scroll.
 */
export function SecondaryPanel({
  id,
  title,
  onClose,
  children,
  endKey,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (endKey === undefined) return;
    const element = body.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [endKey]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <aside
      id={id}
      aria-labelledby={`${id}-heading`}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col rounded-3xl bg-white/85 shadow-[0_10px_40px_-18px_rgb(15_59_54/0.5)]"
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
        <h2
          id={`${id}-heading`}
          ref={heading}
          tabIndex={-1}
          className="font-display text-2xl leading-tight font-extrabold [overflow-wrap:anywhere]"
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
          className="inline-flex min-h-12 shrink-0 items-center rounded-full border border-bottle/40 bg-white px-4 py-2 font-bold hover:bg-celeste/40"
        >
          Close
        </button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">
        {children}
      </div>
    </aside>
  );
}
