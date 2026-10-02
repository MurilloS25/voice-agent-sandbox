import Link from "next/link";

import type { Business } from "@/lib/api/client";
import { assistantHref } from "@/lib/assistant-link";

import { Wheel } from "./Wheel";

export function BusinessHeader({ business }: { business: Business }) {
  return (
    <header className="relative overflow-hidden bg-celeste text-bottle">
      {/*
        Below xl the wheel would sit under the text, so it becomes a faint corner
        watermark. From xl up the title is capped to two lines and clears the wheel.
      */}
      <Wheel className="absolute -right-24 -bottom-24 w-[22rem] opacity-15 sm:w-[30rem] xl:-top-16 xl:right-[-4rem] xl:bottom-auto xl:w-[34rem] xl:opacity-90" />
      <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-8 sm:pt-24 sm:pb-20">
        <h1 className="max-w-2xl font-display text-6xl leading-[0.96] font-extrabold tracking-tight text-balance [overflow-wrap:anywhere] uppercase sm:text-8xl">
          {business.name}
        </h1>
        <p className="mt-5 max-w-md text-xl font-bold">{business.tagline}</p>
        <address className="mt-6 text-lg not-italic">
          <p>{business.address}</p>
        </address>
        <p className="mt-8">
          <Link
            href={assistantHref()}
            className="inline-block min-h-12 bg-bottle px-6 py-3 text-lg font-bold text-primer hover:bg-moss"
          >
            Ask the assistant
          </Link>
        </p>
        <p className="mt-8 max-w-md text-base">
          This is a fictional business built for a software demo. The assistant
          can check open times and prepare a booking for you to confirm, but
          nothing here is real and no personal details are collected.
        </p>
      </div>
    </header>
  );
}
