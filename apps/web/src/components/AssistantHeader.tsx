import Link from "next/link";

import { Wheel } from "./Wheel";

/** A compact version of the home page header: the same celeste, bottle green and wheel. */
export function AssistantHeader() {
  return (
    <header className="relative overflow-hidden border-b-4 border-bottle bg-celeste text-bottle">
      <Wheel className="absolute -top-16 -right-12 w-56 opacity-20 sm:w-72" />
      <div className="relative mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 sm:px-8">
        <div className="min-w-0">
          <p className="font-display text-lg leading-none font-extrabold tracking-tight uppercase">
            Quillwheel Cycle Works
          </p>
          <h1 className="mt-1 font-display text-3xl leading-none font-extrabold [overflow-wrap:anywhere] sm:text-4xl">
            Workshop assistant
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <p className="bg-bottle px-3 py-1 text-sm font-bold text-primer">
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
