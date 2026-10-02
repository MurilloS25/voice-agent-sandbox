import { beforeEach, describe, expect, it, vi } from "vitest";

import BookPage from "./page";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

async function visit(search: Record<string, string>) {
  await BookPage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(search),
  } as PageProps<"/book">);
}

beforeEach(() => redirect.mockReset());

describe("/book", () => {
  it("redirects a direct visit to the assistant", async () => {
    await visit({});
    expect(redirect).toHaveBeenCalledWith("/assistant");
  });

  it("keeps a well-formed service and drops the start time", async () => {
    await visit({ service: "flat-repair", start: "2026-10-01T13:00:00Z" });
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/assistant?service=flat-repair");
  });

  it("drops a malformed service instead of echoing it", async () => {
    await visit({ service: "<script>alert(1)</script>" });
    expect(redirect).toHaveBeenCalledWith("/assistant");
  });
});
