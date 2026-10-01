import type { ReactNode } from "react";

/** One labelled row of a `<dl>` details list. */
export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1 border-t-2 border-bottle/20 py-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="font-bold">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
