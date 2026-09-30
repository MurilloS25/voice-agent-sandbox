import type { Business, Service } from "@/lib/api/client";
import { getAvailability } from "@/lib/api/client";
import { weekdayIndex } from "@/lib/format";

import { ApiUnavailableNotice, ErrorNotice } from "./Notices";
import { SlotList } from "./SlotList";

type AvailabilityResultsProps = {
  business: Business;
  services: Service[];
  serviceId: string;
  date: string;
};

/** Async Server Component: fetches availability, then renders the synchronous SlotList. */
export async function AvailabilityResults({
  business,
  services,
  serviceId,
  date,
}: AvailabilityResultsProps) {
  const result = await getAvailability(serviceId, date);

  if (result.kind === "unavailable") {
    return <ApiUnavailableNotice />;
  }
  if (result.kind === "error") {
    return <ErrorNotice code={result.code} message={result.message} />;
  }

  const weekday = weekdayIndex(result.data.date);
  const shopClosed = !business.hours.some(
    (interval) => interval.weekday === weekday,
  );
  const serviceName =
    services.find((s) => s.id === serviceId)?.name ?? "this service";

  return (
    <SlotList
      availability={result.data}
      serviceName={serviceName}
      shopClosed={shopClosed}
    />
  );
}
