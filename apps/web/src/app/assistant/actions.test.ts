import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResult, AgentTurn } from "@/lib/api/client";
import { agentTurn } from "@/test/fixtures";

import { sendTurn } from "./actions";
import type { Pending } from "./state";

const { sendAgentTurn } = vi.hoisted(() => ({ sendAgentTurn: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ sendAgentTurn }));

const pending: Pending = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  clientTurnId: "22222222-2222-4222-8222-222222222221",
  turnIndex: 1,
  message: "What do you do?",
};

const error = (
  status: number,
  code: string,
  retryAfterS?: number,
): ApiResult<AgentTurn> => ({
  kind: "error",
  status,
  code,
  message: "internal detail that must not leak",
  ...(retryAfterS === undefined ? {} : { retryAfterS }),
});

beforeEach(() => {
  sendAgentTurn.mockReset();
});

describe("sendTurn", () => {
  it("sends exactly the four values, renamed for the API", async () => {
    sendAgentTurn.mockResolvedValue({ kind: "ok", data: agentTurn(1) });

    const outcome = await sendTurn(pending);

    expect(sendAgentTurn).toHaveBeenCalledWith({
      conversation_id: pending.conversationId,
      client_turn_id: pending.clientTurnId,
      turn_index: 1,
      message: "What do you do?",
    });
    expect(outcome).toEqual({ kind: "ok", turn: agentTurn(1) });
  });

  it("never calls the API for something that is not a submission", async () => {
    for (const bad of [
      null,
      undefined,
      "x",
      5,
      {},
      { ...pending, turnIndex: "1" },
    ]) {
      expect(await sendTurn(bad as unknown as Pending)).toEqual({
        kind: "rejected",
      });
    }
    expect(sendAgentTurn).not.toHaveBeenCalled();
  });

  it("treats an unreachable or timed-out API as an unknown outcome", async () => {
    sendAgentTurn.mockResolvedValue({ kind: "unavailable" });
    expect(await sendTurn(pending)).toEqual({
      kind: "retry",
      reason: "unknown",
      retryAfterS: null,
    });
  });

  it.each([
    [409, "turn_in_progress", undefined, "in_progress", 2],
    [409, "turn_in_progress", 7, "in_progress", 7],
    [409, "conversation_busy", undefined, "busy", 2],
    [429, "agent_busy", undefined, "busy", 5],
    [429, "agent_busy", 9, "busy", 9],
  ] as const)(
    "maps %i %s (Retry-After %s) to a pause of %s",
    async (status, code, retryAfterS, reason, expected) => {
      sendAgentTurn.mockResolvedValue(error(status, code, retryAfterS));
      expect(await sendTurn(pending)).toEqual({
        kind: "retry",
        reason,
        retryAfterS: expected,
      });
    },
  );

  it.each([
    [404, "conversation_not_found", "not_found"],
    [410, "conversation_expired", "expired"],
    [409, "turn_out_of_order", "out_of_order"],
    [409, "idempotency_key_reused", "key_reused"],
    [409, "conversation_limit_reached", "limit"],
  ] as const)(
    "maps %i %s to an ended conversation (%s)",
    async (status, code, reason) => {
      sendAgentTurn.mockResolvedValue(error(status, code));
      expect(await sendTurn(pending)).toEqual({ kind: "ended", reason });
    },
  );

  it("maps agent_unavailable and a refused message", async () => {
    sendAgentTurn.mockResolvedValue(error(503, "agent_unavailable"));
    expect(await sendTurn(pending)).toEqual({ kind: "agent_unavailable" });
    sendAgentTurn.mockResolvedValue(error(422, "validation_error"));
    expect(await sendTurn(pending)).toEqual({ kind: "rejected" });
  });

  it.each([
    [500, "internal_error"], // a commit that failed: the turn was not recorded
    [200, "invalid_response"],
    [404, "unexpected_error"],
    [418, "something_new"],
  ])(
    "treats %i %s as an unknown outcome so the same message can be retried",
    async (status, code) => {
      sendAgentTurn.mockResolvedValue(error(status, code));
      expect(await sendTurn(pending)).toEqual({
        kind: "retry",
        reason: "unknown",
        retryAfterS: null,
      });
    },
  );

  it("returns only small state objects, never an API message", async () => {
    sendAgentTurn.mockResolvedValue(error(500, "internal_error"));
    const outcome = await sendTurn(pending);
    expect(JSON.stringify(outcome)).not.toContain("internal detail");
  });
});
