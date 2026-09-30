"use client";

export default function ErrorBoundary({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
      <div role="alert" className="border-l-8 border-rust bg-white/60 p-4">
        <h1 className="text-2xl font-bold text-rust">
          This page hit a problem
        </h1>
        <p className="mt-2">Nothing was changed. Try loading the page again.</p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 min-h-12 bg-bottle px-6 py-2 text-lg font-bold text-primer"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
