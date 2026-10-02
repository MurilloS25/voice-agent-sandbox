/** Every booking page says plainly that this is a fictional demo. */
export function DemoBanner({ compact = false }: { compact?: boolean }) {
  if (compact) {
    // The assistant is a full-height app, so the notice is one quiet line with a small accent.
    return (
      <aside
        aria-label="Demo notice"
        className="flex shrink-0 items-start gap-2 px-4 py-1 text-xs leading-snug font-bold text-bottle sm:gap-3 sm:px-8 sm:py-2 sm:text-sm"
      >
        <span
          aria-hidden="true"
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-hivis ring-2 ring-bottle sm:mt-1.5"
        />
        <span className="max-w-5xl">
          Fictional demo: Quillwheel Cycle Works is not a real business. Nothing
          here is real, and no personal details are collected or stored.
        </span>
      </aside>
    );
  }
  return (
    <aside
      aria-label="Demo notice"
      className="border-l-8 border-bottle bg-hivis px-4 py-3 font-bold text-bottle"
    >
      Fictional demo: Quillwheel Cycle Works is not a real business. Nothing
      here is real, and no personal details are collected or stored.
    </aside>
  );
}
