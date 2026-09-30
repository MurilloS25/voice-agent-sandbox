import { Suspense } from "react";

import { AvailabilityLookup } from "@/components/AvailabilityLookup";
import { AvailabilityResults } from "@/components/AvailabilityResults";
import { BusinessHeader } from "@/components/BusinessHeader";
import { ApiUnavailableNotice, ErrorNotice } from "@/components/Notices";
import { OpeningHours } from "@/components/OpeningHours";
import { ServiceList } from "@/components/ServiceList";
import { SlotsSkeleton } from "@/components/Skeletons";
import { getBusinessOverview } from "@/lib/api/client";

function firstValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single ? single : undefined;
}

export default async function Home(props: PageProps<"/">) {
  const searchParams = await props.searchParams;
  const serviceId = firstValue(searchParams.service);
  const date = firstValue(searchParams.date);

  const overview = await getBusinessOverview();

  if (overview.kind !== "ok") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
        <h1 className="font-display text-5xl font-extrabold">
          Quillwheel Cycle Works
        </h1>
        <div className="mt-8">
          {overview.kind === "unavailable" ? (
            <ApiUnavailableNotice />
          ) : (
            <ErrorNotice code={overview.code} message={overview.message} />
          )}
        </div>
      </main>
    );
  }

  const { business, services } = overview.data;

  return (
    <>
      <BusinessHeader business={business} />
      <main className="mx-auto max-w-6xl space-y-16 px-4 py-12 sm:px-8 sm:py-16">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-16">
          <ServiceList services={services} />
          <OpeningHours hours={business.hours} timezone={business.timezone} />
        </div>

        <AvailabilityLookup
          services={services}
          bookingWindow={business.booking_window}
          selectedService={serviceId}
          selectedDate={date}
        >
          {serviceId && date ? (
            <Suspense key={`${serviceId}|${date}`} fallback={<SlotsSkeleton />}>
              <AvailabilityResults
                business={business}
                services={services}
                serviceId={serviceId}
                date={date}
              />
            </Suspense>
          ) : (
            <p>Choose a service and a date to see when the shop has room.</p>
          )}
        </AvailabilityLookup>
      </main>
    </>
  );
}
