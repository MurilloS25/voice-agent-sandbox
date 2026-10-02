/**
 * Evidence for the transport decision (ADR 0009): a Server Action cannot be cancelled once it has
 * started, so transcription goes through a same-origin route handler whose `request.signal` ends
 * when the visitor cancels or leaves.
 *
 * This reads the Next.js client shipped in node_modules, which is what the running app uses. If a
 * future Next.js version adds cancellation, these tests fail and the decision should be revisited.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const next = dirname(require.resolve("next/package.json"));
const read = (relative: string) =>
  readFileSync(join(next, "dist", relative), "utf8");

describe("Next.js Server Actions (installed version)", () => {
  it("are called with an id and arguments only: there is no signal to pass", () => {
    const source = read("client/app-call-server.js");
    expect(source).toMatch(/async function callServer\(actionId, actionArgs\)/);
    expect(source).not.toMatch(/signal|abort/i);
  });

  it("are fetched without any caller-supplied AbortSignal", () => {
    const source = read(
      "client/components/router-reducer/reducers/server-action-reducer.js",
    );
    expect(source).not.toMatch(/AbortController|AbortSignal|signal/);
  });

  it("are dispatched one at a time, so a pending one would also block the others", () => {
    const guide = readFileSync(
      join(next, "dist/docs/01-app/02-guides/server-actions.md"),
      "utf8",
    );
    expect(guide).toMatch(/dispatches Server Actions one at a time per client/);
  });
});
