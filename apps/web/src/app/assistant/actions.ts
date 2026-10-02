"use server";

import { sendAgentTurn } from "@/lib/api/client";

import type { Pending, TurnOutcome } from "./state";

function isPending(value: unknown): value is Pending {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.conversationId === "string" &&
    typeof input.clientTurnId === "string" &&
    typeof input.turnIndex === "number" &&
    typeof input.message === "string"
  );
}

/**
 * One turn. Treated as a public POST endpoint: the input is checked for shape here and fully
 * validated by `sendAgentTurn`, and the API validates it again. The return value is a small
 * state object: the API's error messages never reach the browser.
 *
 * Anything that leaves the outcome unknown (a timeout, an unreachable or failing API, an
 * unreadable answer) is a `retry`, which resends the identical submission. That is safe while
 * the API still holds the conversation: it replays the stored answer instead of calling the
 * model again.
 */
export async function sendTurn(input: Pending): Promise<TurnOutcome> {
  if (!isPending(input)) return { kind: "rejected" };

  const result = await sendAgentTurn({
    conversation_id: input.conversationId,
    client_turn_id: input.clientTurnId,
    turn_index: input.turnIndex,
    message: input.message,
  });

  if (result.kind === "ok") return { kind: "ok", turn: result.data };
  if (result.kind === "unavailable") {
    return { kind: "retry", reason: "unknown", retryAfterS: null };
  }

  switch (result.code) {
    case "agent_unavailable":
      return { kind: "agent_unavailable" };
    case "demo_budget_reached":
      return { kind: "limit_reached" };
    case "rate_limited":
      // Too many requests from this visitor or from everyone: wait and send the same message.
      return {
        kind: "retry",
        reason: "busy",
        retryAfterS: result.retryAfterS ?? 10,
      };
    case "turn_in_progress":
      return {
        kind: "retry",
        reason: "in_progress",
        retryAfterS: result.retryAfterS ?? 2,
      };
    case "conversation_busy":
      return {
        kind: "retry",
        reason: "busy",
        retryAfterS: result.retryAfterS ?? 2,
      };
    case "agent_busy":
      return {
        kind: "retry",
        reason: "busy",
        retryAfterS: result.retryAfterS ?? 5,
      };
    case "conversation_not_found":
      return { kind: "ended", reason: "not_found" };
    case "conversation_expired":
      return { kind: "ended", reason: "expired" };
    case "turn_out_of_order":
      return { kind: "ended", reason: "out_of_order" };
    case "idempotency_key_reused":
      return { kind: "ended", reason: "key_reused" };
    case "conversation_limit_reached":
      return { kind: "ended", reason: "limit" };
    case "validation_error":
      return { kind: "rejected" };
  }

  // An unrecognised answer (a 5xx, an unreadable body) may have come after the turn was recorded.
  return { kind: "retry", reason: "unknown", retryAfterS: null };
}
