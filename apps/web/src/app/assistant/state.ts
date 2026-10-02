import type { AgentTurn } from "@/lib/api/client";

/**
 * One submission, exactly as it is sent to the API. A retry resends these four values unchanged:
 * the API treats `clientTurnId` as the idempotency key, so a new id for a retry would be a new
 * message.
 */
export type Pending = {
  conversationId: string;
  clientTurnId: string;
  turnIndex: number;
  message: string;
};

/** Why the API will not continue this conversation. */
export type EndReason =
  | "not_found" // unknown to the API, for example after it restarted
  | "expired"
  | "out_of_order"
  | "key_reused"
  | "limit";

/** What the Server Action tells the chat. `kind` drives the message and the next step. */
export type TurnOutcome =
  | { kind: "ok"; turn: AgentTurn }
  // The outcome is unknown or the API asked for a pause: resend the same submission.
  | {
      kind: "retry";
      reason: "unknown" | "in_progress" | "busy";
      retryAfterS: number | null;
    }
  | { kind: "agent_unavailable" } // no assistant is configured
  | { kind: "limit_reached" } // today's demo allowance is spent: nothing to retry now
  | { kind: "ended"; reason: EndReason }
  | { kind: "rejected" }; // the message itself was refused: edit it

/** A turn the API answered: what the visitor typed and the stored response. */
export type Turn = { message: string; response: AgentTurn };

/** A finished conversation, kept in memory and shown read-only. */
export type Conversation = { turns: Turn[]; unsent: string | null };
