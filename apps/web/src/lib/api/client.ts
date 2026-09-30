/**
 * Server-side client for the FastAPI backend. Call it from Server Components only:
 * `API_BASE_URL` is a server-only variable and the browser never talks to the API directly.
 */
import type { components } from "./schema";

export type Business = components["schemas"]["BusinessResponse"];
export type Service = components["schemas"]["ServiceResponse"];
export type Money = components["schemas"]["MoneyResponse"];
export type OpeningInterval = components["schemas"]["OpeningIntervalResponse"];
export type Availability = components["schemas"]["AvailabilityResponse"];

export type ApiResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "unavailable" }
  | { kind: "error"; status: number; code: string; message: string };

export type BusinessOverview = { business: Business; services: Service[] };

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 3000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SERVICE_ID_PATTERN = /^[a-z0-9-]+$/;

function baseUrl(): string {
  return (process.env.API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function errorResult(status: number, payload: unknown): ApiResult<never> {
  const body =
    typeof payload === "object" && payload !== null
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  if (typeof body?.code === "string" && typeof body.message === "string") {
    return { kind: "error", status, code: body.code, message: body.message };
  }
  return {
    kind: "error",
    status,
    code: "unexpected_error",
    message: "The schedule service returned an unexpected response.",
  };
}

async function request<T>(path: string): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable" };
  }

  if ([502, 503, 504].includes(response.status)) {
    return { kind: "unavailable" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      kind: "error",
      status: response.status,
      code: "invalid_response",
      message:
        "The schedule service returned a response that could not be read.",
    };
  }

  if (!response.ok) {
    return errorResult(response.status, payload);
  }
  return { kind: "ok", data: payload as T };
}

export async function getBusinessOverview(): Promise<
  ApiResult<BusinessOverview>
> {
  const [business, services] = await Promise.all([
    request<Business>("/v1/business"),
    request<{ services: Service[] }>("/v1/services"),
  ]);

  if (business.kind === "unavailable" || services.kind === "unavailable") {
    return { kind: "unavailable" };
  }
  if (business.kind === "error") return business;
  if (services.kind === "error") return services;
  return {
    kind: "ok",
    data: { business: business.data, services: services.data.services },
  };
}

export async function getAvailability(
  serviceId: string,
  date: string,
): Promise<ApiResult<Availability>> {
  if (!SERVICE_ID_PATTERN.test(serviceId) || !DATE_PATTERN.test(date)) {
    return {
      kind: "error",
      status: 422,
      code: "validation_error",
      message: "Choose a service and a date in YYYY-MM-DD format.",
    };
  }
  return request<Availability>(
    `/v1/services/${encodeURIComponent(serviceId)}/availability?date=${date}`,
  );
}
