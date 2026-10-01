import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONVERSATION_ID, agentTurn } from "@/test/fixtures";

import {
  AGENT_TURN_TIMEOUT_MS,
  MUTATION_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  confirmAppointment,
  createProposal,
  getAppointment,
  getAvailability,
  getBusinessOverview,
  sendAgentTurn,
} from "./client";

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

describe("createProposal", () => {
  const START = "2026-10-01T13:00:00Z";

  it("posts the service and start as JSON and saves nothing itself", async () => {
    fetchMock.mockResolvedValue(json({ proposal_token: "v1.a.b" }));

    const result = await createProposal("flat-repair", START);

    expect(result).toEqual({ kind: "ok", data: { proposal_token: "v1.a.b" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/v1/appointment-proposals");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: expect.objectContaining({ "content-type": "application/json" }),
    });
    expect(JSON.parse(init.body)).toEqual({
      service_id: "flat-repair",
      start: START,
    });
  });

  it.each([
    [409, "slot_unavailable"],
    [422, "slot_not_offered"],
    [404, "service_not_found"],
  ])("surfaces a %i %s envelope", async (status, code) => {
    fetchMock.mockResolvedValue(
      json({ error: { code, message: "Nope." } }, status),
    );
    expect(await createProposal("flat-repair", START)).toEqual({
      kind: "error",
      status,
      code,
      message: "Nope.",
    });
  });

  it("reports a storage outage as unavailable", async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: "storage_unavailable", message: "x" } }, 503),
    );
    expect(await createProposal("flat-repair", START)).toEqual({
      kind: "unavailable",
    });
  });

  it.each([
    ["Flat Repair", START],
    ["../x", START],
    ["flat-repair", "2026-10-01T13:00:00"],
    ["flat-repair", "2026-10-01T13:00:00+00:00"],
    ["flat-repair", "yesterday"],
  ])("rejects invalid input locally (%s, %s)", async (service, start) => {
    expect(await createProposal(service, start)).toMatchObject({
      kind: "error",
      code: "validation_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("confirmAppointment", () => {
  it("posts the token with an explicit confirm flag and a mutation timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(json({ id: "x" }, 201));

    const result = await confirmAppointment("v1.abc.def");

    expect(result).toEqual({ kind: "ok", data: { id: "x" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/v1/appointments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      proposal_token: "v1.abc.def",
      confirm: true,
    });
    expect(timeout).toHaveBeenCalledWith(MUTATION_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it("treats a replay (200) like a success", async () => {
    fetchMock.mockResolvedValue(json({ id: "x" }, 200));
    expect(await confirmAppointment("v1.abc.def")).toEqual({
      kind: "ok",
      data: { id: "x" },
    });
  });

  it.each([
    [409, "slot_unavailable"],
    [409, "proposal_stale"],
    [422, "proposal_expired"],
    [422, "proposal_invalid"],
  ])("surfaces a %i %s envelope", async (status, code) => {
    fetchMock.mockResolvedValue(
      json({ error: { code, message: "Nope." } }, status),
    );
    expect(await confirmAppointment("v1.abc.def")).toMatchObject({
      kind: "error",
      status,
      code,
    });
  });

  it.each([
    [
      "network error",
      () => fetchMock.mockRejectedValue(new TypeError("fetch failed")),
    ],
    [
      "timeout",
      () => fetchMock.mockRejectedValue(new DOMException("t", "TimeoutError")),
    ],
    ["503", () => fetchMock.mockResolvedValue(json({}, 503))],
  ])(
    "reports %s as an unknown outcome (unavailable)",
    async (_name, arrange) => {
      arrange();
      expect(await confirmAppointment("v1.abc.def")).toEqual({
        kind: "unavailable",
      });
    },
  );

  it.each([
    "",
    "garbage",
    "v1.only-two",
    "v2.a.b",
    "v1.a.b c",
    `v1.a.${"b".repeat(3000)}`,
  ])("never sends a malformed token (%s)", async (token) => {
    expect(await confirmAppointment(token)).toMatchObject({
      kind: "error",
      code: "proposal_invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getAppointment", () => {
  const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("reads the appointment by id with the read timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(json({ id: ID }));
    expect(await getAppointment(ID)).toEqual({ kind: "ok", data: { id: ID } });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://api.test/v1/appointments/${ID}`,
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(timeout).toHaveBeenCalledWith(READ_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it.each(["", "not-a-uuid", "../x", `${ID}/extra`, ID.toUpperCase()])(
    "reports %s as not found without calling the API",
    async (id) => {
      expect(await getAppointment(id)).toMatchObject({
        kind: "error",
        status: 404,
        code: "appointment_not_found",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("sendAgentTurn", () => {
  const turn = {
    conversation_id: CONVERSATION_ID,
    client_turn_id: "22222222-2222-4222-8222-222222222221",
    turn_index: 1,
    message: "  What do you do?  ",
  };

  it("uses the agreed 26 second budget", () => {
    expect(AGENT_TURN_TIMEOUT_MS).toBe(26000);
  });

  it("posts the four values with the trimmed message and the turn timeout", async () => {
    fetchMock.mockResolvedValue(json(agentTurn(1)));
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const result = await sendAgentTurn(turn);

    expect(result.kind).toBe("ok");
    expect(timeout).toHaveBeenCalledWith(26000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/agent/turns");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      ...turn,
      message: "What do you do?",
    });
    timeout.mockRestore();
  });

  it.each([
    ["a bad conversation id", { conversation_id: "nope" }],
    ["a bad turn id", { client_turn_id: "nope" }],
    ["turn index 0", { turn_index: 0 }],
    ["turn index 31", { turn_index: 31 }],
    ["a fractional turn index", { turn_index: 1.5 }],
    ["an empty message", { message: "   " }],
    ["a long message", { message: "x".repeat(501) }],
    ["a control character", { message: "bad\u0000text" }],
    ["a carriage return", { message: "bad\rtext" }],
  ])("refuses %s without calling the API", async (_name, patch) => {
    const result = await sendAgentTurn({ ...turn, ...patch });
    expect(result).toMatchObject({ kind: "error", code: "validation_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a newline inside a message", async () => {
    fetchMock.mockResolvedValue(json(agentTurn(1)));
    expect((await sendAgentTurn({ ...turn, message: "a\nb" })).kind).toBe("ok");
  });

  it("rejects an answer that belongs to a different submission", async () => {
    for (const other of [
      agentTurn(2),
      agentTurn(1, { conversation_id: "33333333-3333-4333-8333-333333333333" }),
      agentTurn(1, { client_turn_id: "44444444-4444-4444-8444-444444444444" }),
    ]) {
      fetchMock.mockResolvedValueOnce(json(other));
      expect(await sendAgentTurn(turn)).toMatchObject({
        kind: "error",
        code: "invalid_response",
      });
    }
  });

  it("rejects an answer without the expected shape", async () => {
    fetchMock.mockResolvedValue(json({ conversation_id: CONVERSATION_ID }));
    expect(await sendAgentTurn(turn)).toMatchObject({
      code: "invalid_response",
    });
  });

  it("keeps an agent_unavailable 503 distinct from an unreachable service", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "agent_unavailable", message: "m" } }, 503),
    );
    expect(await sendAgentTurn(turn)).toMatchObject({
      kind: "error",
      status: 503,
      code: "agent_unavailable",
    });

    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "storage_unavailable", message: "m" } }, 503),
    );
    expect(await sendAgentTurn(turn)).toEqual({ kind: "unavailable" });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    expect(await sendAgentTurn(turn)).toEqual({ kind: "unavailable" });
  });

  it("reports a network error or timeout as unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await sendAgentTurn(turn)).toEqual({ kind: "unavailable" });
    fetchMock.mockRejectedValueOnce(new DOMException("t", "TimeoutError"));
    expect(await sendAgentTurn(turn)).toEqual({ kind: "unavailable" });
  });

  it("surfaces the error code and a valid Retry-After value", async () => {
    const reply = (retryAfter: string | null) =>
      new Response(
        JSON.stringify({ error: { code: "turn_in_progress", message: "m" } }),
        {
          status: 409,
          headers: {
            "content-type": "application/json",
            ...(retryAfter ? { "retry-after": retryAfter } : {}),
          },
        },
      );
    fetchMock.mockResolvedValueOnce(reply("2"));
    expect(await sendAgentTurn(turn)).toMatchObject({
      code: "turn_in_progress",
      retryAfterS: 2,
    });
    for (const bad of [null, "0", "-3", "abc", "1.5"]) {
      fetchMock.mockResolvedValueOnce(reply(bad));
      const result = await sendAgentTurn(turn);
      expect(result).toMatchObject({ code: "turn_in_progress" });
      expect(result).not.toHaveProperty("retryAfterS");
    }
  });

  it("clamps a long Retry-After to a minute", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "agent_busy", message: "m" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "9999",
          },
        },
      ),
    );
    expect(await sendAgentTurn(turn)).toMatchObject({ retryAfterS: 60 });
  });

  it("does not read the body of a 502 or 504", async () => {
    const response = new Response("<html>", { status: 504 });
    const json = vi.spyOn(response, "json");
    fetchMock.mockResolvedValueOnce(response);
    expect(await sendAgentTurn(turn)).toEqual({ kind: "unavailable" });
    expect(json).not.toHaveBeenCalled();
  });
});
