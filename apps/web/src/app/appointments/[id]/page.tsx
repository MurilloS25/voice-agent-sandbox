import type { Metadata } from "next";
import Link from "next/link";

import { AppointmentSummary } from "@/components/AppointmentSummary";
import { DemoBanner } from "@/components/DemoBanner";
import { FocusHeading } from "@/components/FocusHeading";
import { ApiUnavailableNotice, ErrorNotice } from "@/components/Notices";
import { getAppointment } from "@/lib/api/client";

export const metadata: Metadata = {
  title: "Your booking | Quillwheel Cycle Works",
};

const linkClass = "font-bold underline underline-offset-4";
// `text-5xl` at a 320 px viewport with 200% text is wider than the longest word: start smaller, and allow a break.
const headingClass =
  "font-display text-4xl font-extrabold [overflow-wrap:anywhere] sm:text-5xl";

export default async function AppointmentPage(
  props: PageProps<"/appointments/[id]">,
) {
  const { id } = await props.params;
  const result = await getAppointment(id);

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-12 sm:px-8 sm:py-16">
      <DemoBanner />
      {result.kind === "ok" ? (
        <>
          <FocusHeading className={headingClass}>
            Booked: {result.data.service.name}
          </FocusHeading>
          <AppointmentSummary appointment={result.data} />
        </>
      ) : (
        <>
          <h1 className={headingClass}>We couldn&apos;t show that booking</h1>
          {result.kind === "unavailable" ? (
            <ApiUnavailableNotice />
          ) : (
            <ErrorNotice code={result.code} message={result.message} />
          )}
        </>
      )}
      <p>
        <Link href="/#availability" className={linkClass}>
          Back to open times
        </Link>
      </p>
    </main>
  );
}
