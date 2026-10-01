import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appointment } from "@/test/fixtures";

import AppointmentPage from "./page";

const { getAppointment } = vi.hoisted(() => ({ getAppointment: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ getAppointment }));

async function renderPage(id: string) {
  const props = {
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  } as PageProps<"/appointments/[id]">;
  render(await AppointmentPage(props));
}

beforeEach(() => getAppointment.mockReset());

describe("/appointments/[id]", () => {
  it("shows the saved booking and moves focus to the heading", async () => {
    getAppointment.mockResolvedValue({ kind: "ok", data: appointment });
    await renderPage(appointment.id);

    const heading = screen.getByRole("heading", {
      name: "Booked: Flat repair",
    });
    expect(heading).toHaveFocus();
    expect(screen.getByText(appointment.id)).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveTextContent(
      "Fictional demo",
    );
  });

  it("explains an unknown appointment", async () => {
    getAppointment.mockResolvedValue({
      kind: "error",
      status: 404,
      code: "appointment_not_found",
      message: "ignored",
    });
    await renderPage("00000000-0000-4000-8000-000000000000");
    expect(
      screen.getByRole("heading", { name: "We couldn't show that booking" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't find that appointment.",
    );
  });

  it("shows the unavailable notice when the API cannot be reached", async () => {
    getAppointment.mockResolvedValue({ kind: "unavailable" });
    await renderPage(appointment.id);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The schedule service isn't responding",
    );
  });
});
