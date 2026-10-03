import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResult, Appointment } from "@/lib/api/client";
import { appointment } from "@/test/fixtures";

import { confirmBooking } from "./actions";
import { IDLE } from "./state";

const { confirmAppointment, redirect } = vi.hoisted(() => ({
  confirmAppointment: vi.fn(),
  redirect: vi.fn((path: string) => {
    // Like Next's redirect(), this throws so nothing after it runs.
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));

vi.mock("@/lib/api/client", () => ({ confirmAppointment }));
vi.mock("next/navigation", () => ({ redirect }));

function form(token?: FormDataEntryValue): FormData {
  const data = new FormData();
  if (token !== undefined) data.set("proposal_token", token);
  return data;
}

const error = (status: number, code: string): ApiResult<Appointment> => ({
  kind: "error",
  status,
  code,
  message: "ignored",
});

beforeEach(() => {
  confirmAppointment.mockReset();
  redirect.mockClear();
});

describe("confirmBooking", () => {
  it("sends the token to the API and redirects to the saved appointment", async () => {
    confirmAppointment.mockResolvedValue({ kind: "ok", data: appointment });

    await expect(confirmBooking(IDLE, form("v1.a.b"))).rejects.toThrow(
      `NEXT_REDIRECT /appointments/${appointment.id}`,
    );

    expect(confirmAppointment).toHaveBeenCalledWith("v1.a.b");
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("never calls the API without a text token", async () => {
    expect(await confirmBooking(IDLE, form())).toEqual({ kind: "invalid" });
    expect(await confirmBooking(IDLE, form(new File(["x"], "x.txt")))).toEqual({
      kind: "invalid",
    });
    expect(confirmAppointment).not.toHaveBeenCalled();
  });

  it("reports an unreachable API as an unknown outcome", async () => {
    confirmAppointment.mockResolvedValue({ kind: "unavailable" });
    expect(await confirmBooking(IDLE, form("v1.a.b"))).toEqual({
      kind: "unavailable",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    [429, "rate_limited", "unavailable"],
    [409, "slot_unavailable", "conflict"],
    [409, "proposal_stale", "stale"],
    [422, "proposal_expired", "expired"],
    [422, "proposal_invalid", "invalid"],
    [422, "validation_error", "invalid"],
    [422, "slot_not_offered", "not_offered"],
    [422, "date_out_of_range", "not_offered"],
  ])(
    "maps the known refusal %i %s to %s (nothing was booked)",
    async (status, code, kind) => {
      confirmAppointment.mockResolvedValue(error(status, code));
      expect(await confirmBooking(IDLE, form("v1.a.b"))).toEqual({ kind });
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [500, "internal_error"],
    [502, "bad_gateway"],
    [200, "invalid_response"], // an unreadable body after a possible commit
    [404, "unexpected_error"],
  ])(
    "treats %i %s as an unknown outcome, so a retry is offered and nothing is claimed",
    async (status, code) => {
      confirmAppointment.mockResolvedValue(error(status, code));
      expect(await confirmBooking(IDLE, form("v1.a.b"))).toEqual({
        kind: "unavailable",
      });
    },
  );

  it("reports only an unrecognised 4xx as a plain error", async () => {
    confirmAppointment.mockResolvedValue(error(404, "something_else"));
    expect(await confirmBooking(IDLE, form("v1.a.b"))).toEqual({
      kind: "error",
    });
  });

  it("returns only a small state object, never the API message", async () => {
    confirmAppointment.mockResolvedValue({
      kind: "error",
      status: 500,
      code: "internal_error",
      message: "secret-internal-detail",
    });
    const state = await confirmBooking(IDLE, form("v1.a.b"));
    expect(JSON.stringify(state)).not.toContain("secret-internal-detail");
    expect(Object.keys(state)).toEqual(["kind"]);
  });
});
