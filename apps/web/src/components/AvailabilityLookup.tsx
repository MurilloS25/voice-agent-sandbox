import type { ReactNode } from "react";

import type { Business, Service } from "@/lib/api/client";

type AvailabilityLookupProps = {
  services: Service[];
  bookingWindow: Business["booking_window"];
  selectedService?: string;
  selectedDate?: string;
  /** The results area, rendered under the form. */
  children?: ReactNode;
};

const fieldClass =
  "border-bottle mt-1 block w-full border-2 bg-white px-3 py-2 text-lg min-h-12";

/**
 * A plain GET form: the selection lives in the URL (?service=&date=), so it works without
 * client JavaScript and the server can fetch availability on render.
 */
export function AvailabilityLookup({
  services,
  bookingWindow,
  selectedService,
  selectedDate,
  children,
}: AvailabilityLookupProps) {
  // An id that isn't on the menu would make the browser silently select the first option,
  // which contradicts the "not on the list" notice. Show the placeholder instead.
  const knownService = services.some((s) => s.id === selectedService)
    ? selectedService
    : undefined;

  return (
    <section
      id="availability"
      aria-labelledby="availability-heading"
      className="scroll-mt-6 border-t-4 border-bottle pt-6"
    >
      <h2
        id="availability-heading"
        className="font-display text-4xl font-extrabold sm:text-5xl"
      >
        Find an open time
      </h2>

      <form
        method="get"
        action="/#availability"
        className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end"
      >
        <div>
          <label htmlFor="service" className="font-bold">
            Service
          </label>
          <select
            id="service"
            name="service"
            required
            defaultValue={knownService ?? ""}
            className={fieldClass}
          >
            <option value="" disabled>
              Choose a service
            </option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="date" className="font-bold">
            Date
          </label>
          <input
            id="date"
            name="date"
            type="date"
            required
            min={bookingWindow.first_date}
            max={bookingWindow.last_date}
            defaultValue={selectedDate ?? ""}
            className={fieldClass}
          />
        </div>
        <button
          type="submit"
          className="min-h-12 bg-bottle px-6 py-2 text-lg font-bold text-primer hover:bg-moss"
        >
          Show open times
        </button>
      </form>

      <div className="mt-8 min-h-24">{children}</div>
    </section>
  );
}
