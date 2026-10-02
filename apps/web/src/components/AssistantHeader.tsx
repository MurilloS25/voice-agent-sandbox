import Link from "next/link";

import { Wheel } from "./Wheel";

/** A compact version of the home page header: the same celeste, bottle green and wheel. */
export function AssistantHeader() {
  return (
    <header className="relative shrink-0 overflow-hidden bg-celeste pt-[env(safe-area-inset-top)] text-bottle shadow-[0_6px_24px_-14px_rgb(15_59_54/0.6)]">
      <Wheel className="absolute -top-14 -right-10 w-48 opacity-20 sm:w-56" />
      <div className="relative flex items-center justify-between gap-x-4 gap-y-1 px-4 py-1.5 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] sm:px-8 sm:py-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 font-display text-sm leading-tight font-extrabold tracking-tight uppercase">
            <span>Quillwheel Cycle Works</span>
            <span className="rounded-full bg-bottle px-2 py-0.5 font-sans text-xs font-bold tracking-normal text-cream normal-case">
              AI assistant
            </span>
          </p>
          <h1 className="font-display text-2xl leading-none font-extrabold [overflow-wrap:anywhere] sm:text-3xl">
            Workshop assistant
          </h1>
        </div>
        <Link
          href="/"
          className="inline-flex min-h-12 shrink-0 items-center font-bold underline underline-offset-4"
        >
          <span className="sm:hidden" aria-hidden="true">
            Back
          </span>
          <span className="max-sm:sr-only">Back to workshop</span>
        </Link>
      </div>
    </header>
  );
}
