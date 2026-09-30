import type { Service } from "@/lib/api/client";
import { formatDuration, formatPrice } from "@/lib/format";

export function ServiceList({ services }: { services: Service[] }) {
  return (
    <section aria-labelledby="services-heading">
      <h2
        id="services-heading"
        className="font-display text-4xl font-extrabold sm:text-5xl"
      >
        Services and prices
      </h2>

      {services.length === 0 ? (
        <p className="mt-6 border-t-4 border-bottle pt-4">
          The workshop has no services listed right now. Check back soon.
        </p>
      ) : (
        <ul className="mt-6 border-t-4 border-bottle">
          {services.map((service) => (
            // Wraps instead of using fixed columns: when text is enlarged the price
            // drops under the name rather than squeezing it into a sliver.
            <li
              key={service.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-bottle/40 py-4"
            >
              <div className="min-w-[min(100%,11rem)] flex-1">
                <h3 className="text-xl font-bold">{service.name}</h3>
                <p className="max-w-prose text-moss">{service.description}</p>
              </div>
              <div className="ml-auto text-right">
                <p className="font-display text-3xl leading-none font-extrabold">
                  {formatPrice(service.price)}
                </p>
                <p className="mt-1 text-moss">
                  {formatDuration(service.duration_minutes)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
