"use client";

/**
 * The first thing the visitor sees from the assistant. It is fixed text that lives only in the
 * browser: it is not a turn, is never sent to the model, never counts toward a limit, never
 * creates a conversation and is never read aloud on its own.
 */
export const WELCOME_TEXT =
  "Hi! I’m Quillwheel’s workshop assistant. I can explain our services, check available times, and prepare a booking for your confirmation. How can I help?";

/** Each action only fills the message box. The visitor reviews it and presses Send. */
export const QUICK_ACTIONS = [
  { label: "See available services", draft: "What services do you offer?" },
  {
    label: "Find an afternoon appointment",
    draft: "Can you find me an afternoon appointment?",
  },
  { label: "How much is a tune-up?", draft: "How much is a standard tune-up?" },
] as const;

export function AssistantWelcome({
  onPick,
  showActions,
  disabled,
  boxHasText,
}: {
  onPick: (draft: string) => void;
  showActions: boolean;
  disabled: boolean;
  /** Quick starts only fill an empty message box, so they wait while it holds text. */
  boxHasText: boolean;
}) {
  return (
    <section aria-label="Welcome from the assistant" className="space-y-4">
      <div className="flex min-w-0 gap-3">
        <span
          aria-hidden="true"
          className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bottle font-display text-xl leading-none font-extrabold text-celeste"
        >
          Q
        </span>
        <div className="max-w-prose min-w-0 rounded-2xl rounded-tl-md bg-white p-3 text-left shadow-[0_2px_14px_-6px_rgb(15_59_54/0.35)]">
          <p className="text-sm font-bold">Assistant (AI)</p>
          <p className="mt-1 [overflow-wrap:anywhere]">{WELCOME_TEXT}</p>
        </div>
      </div>
      {showActions ? (
        <div className="sm:ml-12">
          <p className="mb-2 text-sm font-bold">Quick starts</p>
          {boxHasText ? (
            <p id="quick-start-note" className="mb-2 text-sm">
              Quick starts fill an empty message box. Clear your message to use
              one.
            </p>
          ) : null}
          <ul className="flex flex-wrap gap-3">
            {QUICK_ACTIONS.map((action) => (
              <li key={action.label}>
                <button
                  type="button"
                  onClick={() => onPick(action.draft)}
                  disabled={disabled || boxHasText}
                  aria-describedby={boxHasText ? "quick-start-note" : undefined}
                  className="min-h-12 rounded-full border border-bottle/40 bg-white px-5 py-2 text-left font-bold [overflow-wrap:anywhere] hover:bg-celeste/40 disabled:opacity-60"
                >
                  {action.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
