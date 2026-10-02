import Link from "next/link";

import { Wheel } from "./Wheel";

/** A compact version of the home page header: the same celeste, bottle green and wheel. */
export function AssistantHeader() {
  return (
    <header className="relative shrink-0 overflow-hidden bg-celeste pt-[env(safe-area-inset-top)] text-bottle shadow-[0_6px_24px_-14px_rgb(15_59_54/0.6)]">
      <Wheel className="absolute -top-14 -right-10 w-48 opacity-20 sm:w-56" />
      <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] sm:px-8">
        <div className="min-w-0">
          <p className="font-display text-sm leading-none font-extrabold tracking-tight uppercase">
            Quillwheel Cycle Works
          </p>
          <h1 className="mt-0.5 font-display text-2xl leading-none font-extrabold [overflow-wrap:anywhere] sm:text-3xl">
            Workshop assistant
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0">
          <p className="rounded-full bg-bottle px-3 py-1 text-sm font-bold text-cream">
            AI assistant
          </p>
          <Link
            href="/"
            className="inline-flex min-h-12 items-center font-bold underline underline-offset-4"
          >
            Back to workshop
          </Link>
        </div>
      </div>
    </header>
  );
}
