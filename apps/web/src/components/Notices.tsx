import type { ReactNode } from "react";

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      className="max-w-prose border-l-8 border-rust bg-white/60 p-4"
    >
      <p className="text-lg font-bold text-rust">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function ApiUnavailableNotice({
  subject = "The schedule service",
}: {
  subject?: string;
}) {
  return (
    <Notice title={`${subject} isn't responding`}>
      <p>
        We couldn&apos;t reach it just now. Reload the page in a moment to try
        again.
      </p>
    </Notice>
  );
}

/** Turns an API error code into plain guidance. Falls back to the server's own message. */
export function describeError(code: string, message: string): string {
  switch (code) {
    case "service_not_found":
      return "That service isn't on the list. Choose one from the menu.";
    case "validation_error":
      return "Choose a service and a valid date, then try again.";
    case "date_out_of_range":
      return message;
    default:
      return "The schedule service returned an error. Try again in a moment.";
  }
}

export function ErrorNotice({
  code,
  message,
}: {
  code: string;
  message: string;
}) {
  return (
    <Notice title="Something went wrong">
      <p>{describeError(code, message)}</p>
    </Notice>
  );
}
