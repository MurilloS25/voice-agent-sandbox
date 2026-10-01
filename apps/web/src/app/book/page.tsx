import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingReview } from "@/components/BookingReview";
import { DemoBanner } from "@/components/DemoBanner";
import { ApiUnavailableNotice, ErrorNotice } from "@/components/Notices";
import { reviewHref } from "@/components/SlotList";
import { createProposal, getBusinessOverview } from "@/lib/api/client";
import { tryLocalDateOf } from "@/lib/format";
import { firstValue } from "@/lib/search-params";

import { ConfirmForm } from "./ConfirmForm";

export const metadata: Metadata = {
  title: "Review your booking | Quillwheel Cycle Works",
};

const linkClass = "font-bold underline underline-offset-4";
// `text-5xl` at a 320 px viewport with 200% text is wider than the longest word: start smaller, and allow a break.
const headingClass =
  "font-display text-4xl font-extrabold [overflow-wrap:anywhere] sm:text-5xl";

/** The open-times section for a service, on a given local day when it is known. */
function availabilityLink(serviceId: string, date: string | undefined): string {
  return date
    ? `/?service=${encodeURIComponent(serviceId)}&date=${date}#availability`
    : "/#availability";
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-12 sm:px-8 sm:py-16">
      <DemoBanner />
      {children}
    </main>
  );
}

export default async function BookPage(props: PageProps<"/book">) {
  const searchParams = await props.searchParams;
  const serviceId = firstValue(searchParams.service);
  const start = firstValue(searchParams.start);

  if (!serviceId || !start) {
    return (
      <Shell>
        <h1 className={headingClass}>Choose a time first</h1>
        <p>
          Pick a service and an open time to review a booking.{" "}
          <Link href="/#availability" className={linkClass}>
            See open times
          </Link>
          .
        </p>
      </Shell>
    );
  }

  const proposal = await createProposal(serviceId, start);

  if (proposal.kind !== "ok") {
    // Only on this rare path do we look up the business timezone, so that "back to open times"
    // lands on the right day. The success path needs a single API call.
    const overview = await getBusinessOverview();
    const date =
      overview.kind === "ok"
        ? tryLocalDateOf(start, overview.data.business.timezone)
        : undefined;
    const backHref = availabilityLink(serviceId, date);
    return (
      <Shell>
        <h1 className={headingClass}>We couldn&apos;t prepare that booking</h1>
        {proposal.kind === "unavailable" ? (
          <ApiUnavailableNotice />
        ) : (
          <ErrorNotice code={proposal.code} message={proposal.message} />
        )}
        <p>
          <Link href={backHref} className={linkClass}>
            Back to open times
          </Link>
        </p>
      </Shell>
    );
  }

  // The proposal carries the business timezone, so no second request is needed.
  const availabilityHref = availabilityLink(
    serviceId,
    tryLocalDateOf(start, proposal.data.timezone),
  );

  return (
    <Shell>
      <h1 className={headingClass}>Review your booking</h1>
      <BookingReview proposal={proposal.data} />
      <ConfirmForm
        token={proposal.data.proposal_token}
        reviewHref={reviewHref(serviceId, start)}
        availabilityHref={availabilityHref}
      />
      <p>
        <Link href={availabilityHref} className={linkClass}>
          Choose a different time
        </Link>
      </p>
    </Shell>
  );
}
