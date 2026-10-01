/**
 * Server-side client for the FastAPI backend. Call it from Server Components and Server
 * Actions only: `API_BASE_URL` is a server-only variable and the browser never talks to the
 * API directly. Client Components may import its types (`import type`) but never its values.
 */
import "server-only";

import { MAX_TURN_INDEX, normalizeMessage } from "../agent-message";
import type { components } from "./schema";

export type Business = components["schemas"]["BusinessResponse"];
export type Service = components["schemas"]["ServiceResponse"];
export type Money = components["schemas"]["MoneyResponse"];
export type OpeningInterval = components["schemas"]["OpeningIntervalResponse"];
export type Availability = components["schemas"]["AvailabilityResponse"];
export type AppointmentProposal =
  components["schemas"]["AppointmentProposalResponse"];
export type Appointment = components["schemas"]["AppointmentResponse"];
export type AgentTurnRequest = components["schemas"]["AgentTurnRequest"];
export type AgentTurn = components["schemas"]["AgentTurnResponse"];
export type TimelineEvent = AgentTurn["events"][number];

export type ApiResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "unavailable" }
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      /** Seconds from a Retry-After header, when the API sent one. */
      retryAfterS?: number;
    };

export type BusinessOverview = { business: Business; services: Service[] };

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
// Every request now reaches a database. The API's worst case, when the database is slow but
// answering, is the sum of its per-step limits (pool acquire 2 s, then 1 s for each statement,
// the first `set_config` and the commit): about 7 s for availability and proposals and 10 s
// for confirm. A silent network failure is capped by the connection's 5 s TCP timeout.
// These budgets add about 2 s for Node, rendering and the network, plus 3 s of slack, so a stuck
// database is reported by the API as `storage_unavailable` rather than cut off here first.
// Only a dead API reaches them. See docs/decisions/0002-direct-postgres-private-schema.md.
export const READ_TIMEOUT_MS = 12000;
export const MUTATION_TIMEOUT_MS = 15000;
// One agent turn. The API bounds a turn at 21 s (20 s deadline plus 1 s to commit, see
// apps/api/src/voice_agent_api/agent/limits.py); this adds the same 5 s margin as the booking
// requests. tests/test_timeout_budget.py in the API fails if the two sides drift apart.
export const AGENT_TURN_TIMEOUT_MS = 26000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SERVICE_ID_PATTERN = /^[a-z0-9-]+$/;
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 2048;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function baseUrl(): string {
  return (process.env.API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function errorResult(
  status: number,
  payload: unknown,
  retryAfterS?: number,
): ApiResult<never> {
  const body =
    typeof payload === "object" && payload !== null
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  if (typeof body?.code === "string" && typeof body.message === "string") {
    return {
      kind: "error",
      status,
      code: body.code,
      message: body.message,
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    };
  }
  return {
    kind: "error",
    status,
    code: "unexpected_error",
    message: "The schedule service returned an unexpected response.",
  };
}

function invalidInput(message: string): ApiResult<never> {
  return { kind: "error", status: 422, code: "validation_error", message };
}

function isAgentUnavailable(payload: unknown): boolean {
  const code =
    typeof payload === "object" && payload !== null
      ? (payload as { error?: { code?: unknown } }).error?.code
      : undefined;
  return code === "agent_unavailable";
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  // A pause longer than a minute is clamped: this is a chat, not a queue.
  return Number.isInteger(value) && value > 0 ? Math.min(value, 60) : undefined;
}

type RequestOptions = { body?: unknown; timeoutMs?: number };

async function request<T>(
  path: string,
  { body, timeoutMs = READ_TIMEOUT_MS }: RequestOptions = {},
): Promise<ApiResult<T>> {
  const hasBody = body !== undefined;
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: hasBody ? "POST" : "GET",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A timeout or network failure on a write leaves the outcome unknown. The caller
    // offers a retry, which is safe because confirming is idempotent.
    return { kind: "unavailable" };
  }

  if ([502, 504].includes(response.status)) {
    return { kind: "unavailable" };
  }
  if (response.status === 503) {
    // A 503 that names itself `agent_unavailable` means "no assistant is configured", which is
    // not the same as the service being down. Any other 503 is an unavailable service.
    const named = await response.json().catch(() => undefined);
    return isAgentUnavailable(named)
      ? errorResult(503, named)
      : { kind: "unavailable" };
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
    return errorResult(response.status, payload, retryAfter(response));
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
    return invalidInput("Choose a service and a date in YYYY-MM-DD format.");
  }
  return request<Availability>(
    `/v1/services/${encodeURIComponent(serviceId)}/availability?date=${date}`,
  );
}

/** Asks the API to describe what booking this slot would do. Nothing is saved. */
export async function createProposal(
  serviceId: string,
  start: string,
): Promise<ApiResult<AppointmentProposal>> {
  if (!SERVICE_ID_PATTERN.test(serviceId) || !INSTANT_PATTERN.test(start)) {
    return invalidInput("Choose an open time from the list.");
  }
  return request<AppointmentProposal>("/v1/appointment-proposals", {
    body: { service_id: serviceId, start },
    timeoutMs: MUTATION_TIMEOUT_MS,
  });
}

/** The only write. Requires the signed token from a proposal and an explicit confirm. */
export async function confirmAppointment(
  proposalToken: string,
): Promise<ApiResult<Appointment>> {
  if (
    proposalToken.length > MAX_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(proposalToken)
  ) {
    return {
      kind: "error",
      status: 422,
      code: "proposal_invalid",
      message: "The booking review could not be verified. Review it again.",
    };
  }
  return request<Appointment>("/v1/appointments", {
    body: { proposal_token: proposalToken, confirm: true },
    timeoutMs: MUTATION_TIMEOUT_MS,
  });
}

export async function getAppointment(
  id: string,
): Promise<ApiResult<Appointment>> {
  if (!UUID_PATTERN.test(id)) {
    return {
      kind: "error",
      status: 404,
      code: "appointment_not_found",
      message: "No appointment matches that id.",
    };
  }
  return request<Appointment>(`/v1/appointments/${id}`);
}

const UUID_ANY = UUID_PATTERN;

/**
 * One conversation turn. Retrying with the very same four values is safe while the API process
 * still holds the conversation (it replays the stored answer), so callers must never change an
 * id for a retry.
 */
export async function sendAgentTurn(
  turn: AgentTurnRequest,
): Promise<ApiResult<AgentTurn>> {
  const message = normalizeMessage(turn.message);
  if (
    !UUID_ANY.test(turn.conversation_id) ||
    !UUID_ANY.test(turn.client_turn_id) ||
    !Number.isInteger(turn.turn_index) ||
    turn.turn_index < 1 ||
    turn.turn_index > MAX_TURN_INDEX ||
    message === undefined
  ) {
    return invalidInput("Write a message of 1 to 500 characters.");
  }
  const result = await request<AgentTurn>("/v1/agent/turns", {
    body: { ...turn, message },
    timeoutMs: AGENT_TURN_TIMEOUT_MS,
  });
  if (result.kind !== "ok") return result;

  // The answer must belong to this very submission; anything else is not shown.
  const data = result.data;
  if (
    data?.conversation_id !== turn.conversation_id ||
    data.client_turn_id !== turn.client_turn_id ||
    data.turn_index !== turn.turn_index ||
    !Array.isArray(data.events) ||
    typeof data.reply?.text !== "string"
  ) {
    return {
      kind: "error",
      status: 200,
      code: "invalid_response",
      message:
        "The schedule service returned a response that could not be read.",
    };
  }
  return result;
}
