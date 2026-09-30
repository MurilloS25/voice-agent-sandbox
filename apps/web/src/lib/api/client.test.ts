import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAvailability, getBusinessOverview } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("API_BASE_URL", "http://api.test");
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const business = { id: "b", name: "Shop", timezone: "America/New_York" };
const services = { services: [{ id: "flat-repair", name: "Flat repair" }] };

describe("getBusinessOverview", () => {
  it("returns business and services when both calls succeed", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/v1/business") ? json(business) : json(services),
      ),
    );

    const result = await getBusinessOverview();

    expect(result).toEqual({
      kind: "ok",
      data: { business, services: services.services },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/business",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports unavailable on a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await getBusinessOverview()).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable on a timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await getBusinessOverview()).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable on a gateway error", async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    expect(await getBusinessOverview()).toEqual({ kind: "unavailable" });
  });

  it("surfaces the API error envelope", async () => {
    fetchMock.mockResolvedValue(
      json(
        { error: { code: "internal_error", message: "Something went wrong." } },
        500,
      ),
    );
    expect(await getBusinessOverview()).toEqual({
      kind: "error",
      status: 500,
      code: "internal_error",
      message: "Something went wrong.",
    });
  });

  it("reports malformed JSON as an error", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>oops</html>", { status: 200 }),
    );
    expect(await getBusinessOverview()).toMatchObject({
      kind: "error",
      code: "invalid_response",
    });
  });
});

describe("getAvailability", () => {
  const availability = {
    service_id: "flat-repair",
    date: "2026-10-01",
    timezone: "America/New_York",
    slots: [],
  };

  it("requests the availability endpoint for the service and date", async () => {
    fetchMock.mockResolvedValue(json(availability));

    const result = await getAvailability("flat-repair", "2026-10-01");

    expect(result).toEqual({ kind: "ok", data: availability });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/v1/services/flat-repair/availability?date=2026-10-01",
      expect.anything(),
    );
  });

  it.each([
    [404, "service_not_found"],
    [422, "date_out_of_range"],
    [422, "validation_error"],
  ])("surfaces a %i %s envelope", async (status, code) => {
    fetchMock.mockResolvedValue(
      json({ error: { code, message: "Nope." } }, status),
    );
    expect(await getAvailability("flat-repair", "2026-10-01")).toEqual({
      kind: "error",
      status,
      code,
      message: "Nope.",
    });
  });

  it("falls back to a generic error when the body is not an envelope", async () => {
    fetchMock.mockResolvedValue(json({ detail: "boom" }, 500));
    expect(await getAvailability("flat-repair", "2026-10-01")).toMatchObject({
      kind: "error",
      status: 500,
      code: "unexpected_error",
    });
  });

  it.each([
    ["flat-repair", "not-a-date"],
    ["flat-repair", ""],
    ["../etc/passwd", "2026-10-01"],
    ["", "2026-10-01"],
  ])("rejects invalid input locally (%s, %s)", async (serviceId, date) => {
    expect(await getAvailability(serviceId, date)).toMatchObject({
      kind: "error",
      code: "validation_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
