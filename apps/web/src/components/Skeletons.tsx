function Bar({ className }: { className: string }) {
  return <div className={`skeleton-pulse bg-bottle/15 ${className}`} />;
}

export function SlotsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading open times">
      <Bar className="h-5 w-2/3" />
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Bar key={index} className="h-12" />
        ))}
      </div>
      <span className="sr-only">Loading open times</span>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the workshop">
      <div className="h-72 bg-celeste" />
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-12 sm:px-8">
        {Array.from({ length: 5 }, (_, index) => (
          <Bar key={index} className="h-16" />
        ))}
      </div>
      <span className="sr-only">Loading the workshop</span>
    </div>
  );
}
