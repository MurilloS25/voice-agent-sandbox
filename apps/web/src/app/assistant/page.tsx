import type { Metadata } from "next";
import Link from "next/link";

import { ChatPanel } from "@/components/ChatPanel";
import { DemoBanner } from "@/components/DemoBanner";

export const metadata: Metadata = {
  title: "Ask the assistant | Quillwheel Cycle Works",
};

const linkClass = "font-bold underline underline-offset-4";

export default function AssistantPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-12 sm:px-8 sm:py-16">
      <DemoBanner />
      <header className="space-y-4">
        <h1 className="font-display text-4xl font-extrabold [overflow-wrap:anywhere] sm:text-5xl">
          Ask the workshop
        </h1>
        <p className="max-w-prose">
          Chat in plain text about Quillwheel&apos;s services, prices, opening
          hours and open times. Every price and time comes from the schedule
          service, and nothing is booked until you press Confirm booking.
        </p>
        <p className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/#availability" className={linkClass}>
            Book with the form instead
          </Link>
          <Link href="/" className={linkClass}>
            Back to the workshop
          </Link>
        </p>
      </header>
      <ChatPanel />
    </main>
  );
}
