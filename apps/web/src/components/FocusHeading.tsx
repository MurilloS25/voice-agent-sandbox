"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** An `<h1>` that takes focus on mount, so a screen reader starts at the result. */
export function FocusHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={className}>
      {children}
    </h1>
  );
}
