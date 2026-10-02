import { describe, expect, it } from "vitest";

import { GET } from "./route";

function visit(search: string) {
  const response = GET(new Request(`http://localhost:3000/book${search}`));
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

describe("/book", () => {
  it("redirects a direct visit to the assistant with a temporary redirect", () => {
    expect(visit("")).toEqual({
      status: 307,
      location: "http://localhost:3000/assistant",
    });
  });

  it("keeps a well-formed service and drops the start time and anything else", () => {
    expect(
      visit("?service=flat-repair&start=2026-10-01T13%3A00%3A00Z&x=1"),
    ).toEqual({
      status: 307,
      location: "http://localhost:3000/assistant?service=flat-repair",
    });
  });

  it("drops a malformed service instead of echoing it", () => {
    expect(visit("?service=%3Cscript%3Ealert(1)%3C%2Fscript%3E").location).toBe(
      "http://localhost:3000/assistant",
    );
  });
});
